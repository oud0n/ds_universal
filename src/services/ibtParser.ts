// iRacing のテレメトリ (.ibt) の読み込み。ゲームで走った記録を、実車のログと同じ画面で比べるため。
// 形式は iRacing の SDK (irsdk_defines.h) と、その読み込みを実装した pyirsdk (MIT, https://github.com/kutu/pyirsdk) の IBT で確かめた:
//  - 先頭 112 バイト: 主ヘッダ (版・記録の回数/秒・セッション情報の位置と長さ・項目の数と項目の一覧の位置・1 行の長さ・
//    値の置き場 (varBuf) 4 つ分。ファイルでは varBuf[0] の位置から 1 行ずつ並ぶ)
//  - 112 バイト目から: ディスク用のヘッダ (記録の開始日時 (UNIX 秒)・開始/終了のセッション時刻・周回数・行の数)
//  - 項目の一覧: 1 項目 144 バイト (型・行の中の位置・個数・名前 32・説明 64・単位 32)
//  - セッション情報: YAML の文字列 (コース名・車両名・ドライバー名など)
//  - 値: 1 行 = 1 回の記録 (ふつうは 60 回/秒)
// 緯度・経度は実際のコースの位置 (レーザーで測ったコース) なので、実車のログとそのまま重ねられる
import { finalizeImportedSamples, type ImportedLog, type RawSample } from './externalFormats';
import { calculateGeoDistanceAndHeading } from './physics';
import { tr } from '../utils/i18n';

const HEADER_LEN = 112;
const DISK_HEADER_LEN = 32;
const VAR_HEADER_LEN = 144;
// 型: 0 char / 1 bool / 2 int / 3 bitfield / 4 float / 5 double
const TYPE_SIZE = [1, 1, 4, 4, 4, 8];

export interface IbtLog extends ImportedLog {
  /** 1 回の走行 (コースに出ていた間) ごとの点列。ピットへの瞬間移動 (リセット) などで分ける */
  parts: ImportedLog[];
  trackName?: string;
  vehicleName?: string;
  driverName?: string;
}

interface VarHeader {
  type: number;
  offset: number;
  count: number;
  unit: string;
}

const cstr = (bytes: Uint8Array, start: number, len: number) => {
  let end = start;
  while (end < start + len && bytes[end] !== 0) end++;
  return new TextDecoder('latin1').decode(bytes.subarray(start, end));
};

export function isIbt(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_LEN + DISK_HEADER_LEN) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ver = v.getInt32(0, true);
  const tickRate = v.getInt32(8, true);
  const numVars = v.getInt32(24, true);
  const varHeaderOffset = v.getInt32(28, true);
  const bufLen = v.getInt32(36, true);
  return ver >= 1 && ver <= 10 && tickRate > 0 && tickRate <= 1000 && numVars > 0 && numVars < 10000 &&
    varHeaderOffset >= HEADER_LEN && varHeaderOffset + numVars * VAR_HEADER_LEN <= bytes.length && bufLen > 0;
}

/** セッション情報 (YAML) から、コース名・自分の車両名・ドライバー名を取り出す (必要なところだけを読む) */
export function parseIbtSessionInfo(yaml: string): { trackName?: string; vehicleName?: string; driverName?: string } {
  const value = (src: string, key: string) => {
    const m = new RegExp(`^\\s*${key}:[ \\t]*(.*)$`, 'm').exec(src);
    const s = m?.[1].trim().replace(/^"(.*)"$/, '$1');
    return s ? s : undefined;
  };
  const trackName = value(yaml, 'TrackDisplayName') ?? value(yaml, 'TrackName');
  // DriverInfo の DriverCarIdx が自分の車。Drivers の一覧から同じ CarIdx の項目を探す
  const di = /^DriverInfo:\n((?:[ \t].*(?:\n|$)|\n)*)/m.exec(yaml)?.[1] ?? '';
  const carIdx = value(di, 'DriverCarIdx');
  let vehicleName: string | undefined;
  let driverName: string | undefined;
  if (carIdx !== undefined) {
    for (const entry of di.split(/^\s*-\s+(?=CarIdx:)/m).slice(1)) {
      if (value(entry, 'CarIdx') !== carIdx) continue;
      vehicleName = value(entry, 'CarScreenName');
      driverName = value(entry, 'UserName');
      break;
    }
  }
  return { trackName, vehicleName, driverName };
}

export function parseIbt(bytes: Uint8Array): IbtLog {
  if (!isIbt(bytes)) throw new Error(tr('iRacing の .ibt として読めませんでした', 'Could not read this as an iRacing .ibt file'));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tickRate = v.getInt32(8, true);
  const sessionInfoLen = v.getInt32(16, true);
  const sessionInfoOffset = v.getInt32(20, true);
  const numVars = v.getInt32(24, true);
  const varHeaderOffset = v.getInt32(28, true);
  const bufLen = v.getInt32(36, true);
  const bufOffset = v.getInt32(48 + 4, true);
  // ディスク用のヘッダ
  const startDateSec = Number(v.getBigUint64(HEADER_LEN, true));
  const startSessionTime = v.getFloat64(HEADER_LEN + 8, true);
  // 行の数。途中で終わったファイルでは書かれていないことがあるので、ファイルの大きさからも求めて小さい方を使う
  const recordCount = v.getInt32(HEADER_LEN + 28, true);
  const rowsBySize = Math.floor((bytes.length - bufOffset) / bufLen);
  const rows = recordCount > 0 ? Math.min(recordCount, rowsBySize) : rowsBySize;
  if (bufOffset <= 0 || rows < 2) throw new Error(tr('iRacing の .ibt に記録がありません', 'The iRacing .ibt file has no records'));

  const vars = new Map<string, VarHeader>();
  for (let i = 0; i < numVars; i++) {
    const o = varHeaderOffset + i * VAR_HEADER_LEN;
    const type = v.getInt32(o, true);
    if (type < 0 || type >= TYPE_SIZE.length) continue;
    vars.set(cstr(bytes, o + 16, 32), { type, offset: v.getInt32(o + 4, true), count: v.getInt32(o + 8, true), unit: cstr(bytes, o + 112, 32) });
  }
  const reader = (name: string): ((row: number) => number) | null => {
    const h = vars.get(name);
    if (!h || h.offset < 0 || h.offset + TYPE_SIZE[h.type] > bufLen) return null;
    return (row: number) => {
      const p = bufOffset + row * bufLen + h.offset;
      switch (h.type) {
        case 0: return v.getUint8(p);
        case 1: return v.getUint8(p) ? 1 : 0;
        case 2: return v.getInt32(p, true);
        case 3: return v.getUint32(p, true);
        case 4: return v.getFloat32(p, true);
        default: return v.getFloat64(p, true);
      }
    };
  };
  const lat = reader('Lat');
  const lon = reader('Lon');
  const time = reader('SessionTime');
  if (!lat || !lon || !time) {
    throw new Error(tr('iRacing の .ibt に緯度・経度 (Lat / Lon) の記録がありません。iRacing の設定でディスクへのテレメトリの記録を有効にしてください', 'The iRacing .ibt file has no latitude / longitude (Lat / Lon). Turn on telemetry recording to disk in the iRacing settings'));
  }
  const alt = reader('Alt');
  const speed = reader('Speed');           // m/s
  const onTrack = reader('IsOnTrack');
  const throttle = reader('Throttle');     // 0〜1
  const brake = reader('Brake');           // 0〜1
  const steering = reader('SteeringWheelAngle'); // rad、左が正
  const rpm = reader('RPM');
  const gear = reader('Gear');             // -1 R / 0 N / 1〜

  // セッション情報の YAML は cp1252 (iRacing の SDK・pyirsdk と同じ。UTF-8 で読むと Nürburgring などが化ける)
  const info = sessionInfoOffset > 0 && sessionInfoLen > 0 && sessionInfoOffset + sessionInfoLen <= bytes.length
    ? parseIbtSessionInfo(new TextDecoder('windows-1252').decode(bytes.subarray(sessionInfoOffset, sessionInfoOffset + sessionInfoLen)).replace(/\0+$/, '').replace(/\r\n/g, '\n'))
    : {};

  // コースに出ていない間 (ガレージ・リプレイ) と、位置が (0, 0) の行 (リセットの瞬間) で区切る。
  // 1 回の記録の間に動ける距離を大きく超えて位置が飛んだ (ピットへの移動など) ときも区切る
  const parts: RawSample[][] = [];
  let cur: RawSample[] = [];
  let prev: { t: number; la: number; lo: number } | null = null;
  const cut = () => {
    if (cur.length > 0) parts.push(cur);
    cur = [];
    prev = null;
  };
  for (let r = 0; r < rows; r++) {
    const la = lat(r);
    const lo = lon(r);
    const t = time(r);
    if ((onTrack && !onTrack(r)) || !Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0) || !Number.isFinite(t)) {
      cut();
      continue;
    }
    const sp = speed ? speed(r) : NaN;
    if (prev) {
      const dt = t - prev.t;
      const d = calculateGeoDistanceAndHeading(prev.la, prev.lo, la, lo).distanceMeters;
      // 時刻が戻った (別のセッションに入った)・1 秒より長く途切れた・100 m/s を超える速さで飛んだときは区切る
      if (dt <= 0 || dt > 1 || d > Math.max(5, dt * 100)) cut();
    }
    prev = { t, la, lo };
    const extra: RawSample['extra'] = {};
    if (throttle) extra.throttle = Number((throttle(r) * 100).toFixed(1));
    if (brake) extra.brake = Number((brake(r) * 100).toFixed(1));
    // 右に切ったときを正にする (iRacing は左が正)
    if (steering) extra.steering = Number((-steering(r) * 180 / Math.PI).toFixed(1));
    if (rpm) extra.rpm = Math.round(rpm(r));
    if (gear) extra.gear = gear(r);
    cur.push({
      time: t,
      latitude: la,
      longitude: lo,
      speedKmh: sp * 3.6,
      altitude: alt ? alt(r) : NaN,
      // 進行方向は、実車の GPS と同じく前後の位置から求める (YawNorth は車体の向きで、滑っているときは進行方向と違う)
      heading: NaN,
      timestamp: startDateSec > 0 ? new Date((startDateSec + (t - startSessionTime)) * 1000) : undefined,
      extra
    });
  }
  cut();

  // 動いていない区切り (ピットで止まっているだけのもの) は捨てる。走った距離が 500 m 未満のもの
  const moved = (s: RawSample[]) => {
    let d = 0;
    for (let i = 1; i < s.length && d < 500; i++) d += calculateGeoDistanceAndHeading(s[i - 1].latitude, s[i - 1].longitude, s[i].latitude, s[i].longitude).distanceMeters;
    return d >= 500;
  };
  const logs = parts.filter(p => p.length >= 2 && moved(p)).map(p => {
    const log = finalizeImportedSamples(p, tr('iRacing の .ibt', 'iRacing .ibt'), 9);
    return { ...log, samplingRate: tickRate };
  });
  if (logs.length === 0) throw new Error(tr('iRacing の .ibt に、コースを走った記録がありません', 'The iRacing .ibt file has no laps driven on track'));
  return { ...logs[0], parts: logs, ...info };
}
