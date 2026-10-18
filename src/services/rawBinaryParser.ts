import { TelemetryPoint } from '../types/telemetry';
import { calculatePhysics } from './physics';

/**
 * デジスパイス3 / 4 の生ログファイル (.bnx4, .bon4, .binx, .bon) を解析
 */
// 設定タグ (16 バイト): 先頭 7 バイトが 0xAA、末尾 4 バイトが 0xBB
function isTag(bytes: Uint8Array, pos: number): boolean {
  if (pos + 16 > bytes.length) return false;
  for (let i = 0; i < 7; i++) if (bytes[pos + i] !== 0xaa) return false;
  for (let i = 12; i < 16; i++) if (bytes[pos + i] !== 0xbb) return false;
  return true;
}

// 未記録領域: 先頭 6 バイトが 0xFF
function isBlank(bytes: Uint8Array, pos: number): boolean {
  for (let i = 0; i < 6; i++) if (bytes[pos + i] !== 0xff) return false;
  return true;
}

// レコード末尾のチェックサム ('*' + 先頭 34 バイトの XOR) が正しいか
function hasValidChecksum(bytes: Uint8Array, pos: number): boolean {
  if (bytes[pos + 34] !== 0x2a) return false;
  let x = 0;
  for (let i = 0; i < 34; i++) x ^= bytes[pos + i];
  return x === bytes[pos + 35];
}

// この時間より長く記録が空いたら、別の走行 (セッション) として分ける。
// ピットでの停止 (記録開始速度を下回って記録が止まる) は数分なので、それより長くとる
export const SESSION_GAP_SEC = 10 * 60;
// これより短い走行 (パドックの移動など) は、ほかに走行があれば読み込まない
const MIN_SESSION_SEC = 10;

export interface RawBinarySession {
  points: TelemetryPoint[];
  samplingRate: number;
  startDate?: Date;
}

/**
 * 生ログを読み、記録の空き (SESSION_GAP_SEC 以上) で区切った走行ごとに返す (時刻順)
 */
export function parseDigispiceRawBinary(fileName: string, buffer: ArrayBuffer): RawBinarySession[] {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  interface RawPoint {
    lat: number;
    lon: number;
    speedKmh: number;
    timeSec: number;
    timestamp?: Date;
    heading?: number;
    altitude?: number;
    satellites?: number;
  }

  const rawPoints: RawPoint[] = [];
  // ミリ秒が記録されているログか (1 点でも 0 < ms < 1000 があれば)
  let hasMilliseconds = false;
  // チェックサムの検証に通らないまま仮採用したレコード
  const unverified = new Set<RawPoint>();

  // ==========================================
  // 1. .bon / .bon4 フォーマット (26バイトレコード, offset 8開始)
  // ==========================================
  if (ext === 'bon' || ext === 'bon4') {
    const msMultiplier = ext === 'bon4' ? 10 : 100;
    let offset = 8;

    while (offset + 26 <= bytes.length) {
      try {
        const rawSpeed = view.getUint16(offset + 2, true);
        const rawLat = view.getInt32(offset + 4, true);
        const rawLon = view.getInt32(offset + 8, true);
        const year = view.getUint16(offset + 18, true);
        const month = view.getUint8(offset + 20);
        const day = view.getUint8(offset + 21);
        const hour = view.getUint8(offset + 22);
        const minute = view.getUint8(offset + 23);
        const second = view.getUint8(offset + 24);
        const subSec = view.getUint8(offset + 25);
        if (subSec > 0 && subSec * msMultiplier < 1000) hasMilliseconds = true;
        // +12 の int32 は標高 (0.1 m 単位)。.bon4 の実ログで確認。.bon は未確認のため読まない
        const rawAlt = ext === 'bon4' ? view.getInt32(offset + 12, true) / 10 : NaN;
        const altitude = rawAlt > -500 && rawAlt < 10000 ? rawAlt : undefined;

        const speedKmh = (rawSpeed / 100) * 3.6;
        const lat = rawLat / 1e7;
        const lon = rawLon / 1e7;

        if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31 && lat !== 0 && lon !== 0) {
          const utcDate = new Date(
            Date.UTC(year, month - 1, day, hour, minute, second, subSec * msMultiplier)
          );
          const timeSec = utcDate.getTime() / 1000;

          rawPoints.push({
            lat,
            lon,
            speedKmh,
            timeSec,
            timestamp: utcDate,
            altitude
          });
        }
      } catch {
        // Skip corrupt record
      }
      offset += 26;
    }
  } else {
    // ==========================================
    // 2. DigSpice IV セクター型 (.bnx4 / .binx, 4096バイトセクター, 0x200開始, 36バイト)
    //
    //    36 バイトレコードの構成 (実走ログで確認):
    //      +0  uint32  UTC 時刻 (秒)        +22 float32 高度 (m)
    //      +4  uint16  測位状態 (3 = 3D)    +26 float32 車速 (km/h)
    //      +6  float64 緯度                 +30 uint8 x2 衛星数
    //      +14 float64 経度                 +32 uint16  ミリ秒
    //                                       +34 '*' (0x2A), +35 先頭 34 バイトの XOR
    //    進行方位は記録されていないため、位置の変化から求める (physics.ts)
    // ==========================================
    // デジスパイスIV (.bnx4) のレコードは必ずチェックサムを持つ。それ以外 (.binx 等) は形式が未確認のため検証しない
    const requireChecksum = ext === 'bnx4';
    // チェックサム付きのレコードを 1 件でも見つけたら、このファイルはセクター型と確定する
    let isSectorFormat = false;
    // 末尾が途中で切れたファイルでも、最後のセクター内の完全なレコードは読む
    const numSectors = Math.ceil(bytes.length / 0x1000);
    if (numSectors > 0) {
      for (let s = 0; s < numSectors; s++) {
        const secOffset = s * 0x1000;
        let esi = 0x200;

        while (esi + 36 <= 0x1000) {
          const pos = secOffset + esi;
          if (pos + 36 > bytes.length) break;

          // 設定タグのスキップ (16 バイト: 0xAA x7, 種別, 値 x4, 0xBB x4)
          if (isTag(bytes, pos)) {
            esi += 0x10;
            continue;
          }

          // 未記録領域 (0xFF が続く) のスキップ
          if (isBlank(bytes, pos)) {
            esi += 36;
            continue;
          }

          try {
            const ts = view.getUint32(pos + 0, true);
            const fix = view.getUint16(pos + 4, true);
            const lat = view.getFloat64(pos + 6, true);
            const lon = view.getFloat64(pos + 14, true);
            const alt = view.getFloat32(pos + 22, true);
            const spd = view.getFloat32(pos + 26, true);
            const ms = view.getUint16(pos + 32, true);

            const checksumOk = hasValidChecksum(bytes, pos);
            if (checksumOk) isSectorFormat = true;

            // 妥当性判定: チェックサム, 3D/2D Fix, 有効な緯度経度, 2000年〜2050年頃のタイムスタンプ
            if (
              (checksumOk || !requireChecksum) &&
              (fix === 2 || fix === 3) &&
              lat >= -90 && lat <= 90 && lat !== 0 &&
              lon >= -180 && lon <= 180 && lon !== 0 &&
              ts > 946684800 && ts < 2524608000
            ) {
              const cleanSpeed = !isNaN(spd) && spd >= 0 && spd < 500 ? spd : 0;
              const cleanAltitude = !isNaN(alt) && alt >= -500 && alt < 10000 ? alt : undefined;
              // ミリ秒が記録されていればそれを使う (範囲外なら 0 とし、後段で補間する)
              const timeSec = ts + (ms < 1000 ? ms / 1000 : 0);
              if (ms > 0 && ms < 1000) hasMilliseconds = true;

              const point: RawPoint = {
                lat,
                lon,
                speedKmh: cleanSpeed,
                timeSec,
                timestamp: new Date(timeSec * 1000),
                altitude: cleanAltitude,
                // +30 / +31 の 2 つのうち、公式ソフトの周回ファイルに入る値と一致するのは +31
                satellites: bytes[pos + 31]
              };
              if (!checksumOk) unverified.add(point);
              rawPoints.push(point);
            }
          } catch {
            // パース例外時はスキップ
          }

          esi += 36;
        }
      }

      // チェックサム付きのレコードが 1 件でもあれば、そのファイルはチェックサム付きの形式。
      // 拡張子が .bnx4 以外でも、検証に通らなかったレコード (破損) は採用しない
      if (isSectorFormat && unverified.size > 0) {
        const verified = rawPoints.filter(p => !unverified.has(p));
        rawPoints.length = 0;
        // 点の多いログで引数の上限を超えないよう、1 つずつ入れる
        for (const p of verified) rawPoints.push(p);
      }
    }

    // ==========================================
    // 3. レガシー・フラットバイナリ用フォールバック
    // ==========================================
    // .bnx4 と、セクター型と確定したファイル (チェックサム付きレコードあり) は、壊れていても別形式として読み直さない
    if (rawPoints.length === 0 && !isSectorFormat && !requireChecksum) {
      interface Layout {
        name: string;
        recordSize: number;
        parse: (v: DataView, z: number) => {
          lat: number;
          lon: number;
          speedKmh: number;
          heading: number;
          ms: number;
          u_t: number;
          alt: number;
        } | null;
      }

      const layouts: Layout[] = [
        {
          name: 'DigSpice 4 36-byte Flat',
          recordSize: 36,
          parse: (v, z) => {
            try {
              const u_t = v.getUint32(z + 0, true);
              const lat = v.getFloat64(z + 6, true);
              const lon = v.getFloat64(z + 14, true);
              const alt = v.getFloat32(z + 22, true);
              const speedKmh = v.getFloat32(z + 26, true);
              // +30 以降は衛星数・ミリ秒・チェックサム (進行方位は記録されていない)
              const ms = v.getUint16(z + 32, true);
              return { lat, lon, speedKmh, heading: NaN, ms, u_t, alt };
            } catch {
              return null;
            }
          }
        },
        {
          name: 'Legacy .binx 38-byte',
          recordSize: 38,
          parse: (v, z) => {
            try {
              const u_t = v.getUint32(z + 0, true);
              const lat = v.getFloat64(z + 4, true);
              const lon = v.getFloat64(z + 12, true);
              const heading = v.getFloat32(z + 20, true);
              const speedKmh = v.getFloat32(z + 24, true);
              const ms = v.getUint16(z + 34, true);
              return { lat, lon, speedKmh, heading, ms, u_t, alt: NaN };
            } catch {
              return null;
            }
          }
        }
      ];

      const isPossiblyValid = (lat: number, lon: number, u_t: number): boolean => {
        return (
          !isNaN(lat) &&
          Math.abs(lat) > 1 &&
          Math.abs(lat) <= 90 &&
          !isNaN(lon) &&
          Math.abs(lon) > 1 &&
          Math.abs(lon) <= 180 &&
          !isNaN(u_t) &&
          u_t > 5e8 &&
          u_t < 2.5e9
        );
      };

      let z = 0;
      // 4バイト境界でスキャンしてメインスレッドの過負荷を防止
      const step = 4;
      while (z + 36 <= bytes.length) {
        let matched = false;

        for (const layout of layouts) {
          if (z + layout.recordSize > bytes.length) continue;
          const rec = layout.parse(view, z);
          if (rec) {
            const { lat, lon, speedKmh, heading, ms, u_t, alt } = rec;
            if (isPossiblyValid(lat, lon, u_t)) {
              const cleanSpeed = !isNaN(speedKmh) && speedKmh >= 0 && speedKmh < 450 ? speedKmh : 0;
              const cleanHeading = !isNaN(heading) && heading >= 0 && heading <= 360 ? heading : undefined;
              const cleanMs = ms >= 0 && ms < 1000 ? ms : 0;
              const timeSec = u_t + cleanMs / 1000;

              rawPoints.push({
                lat,
                lon,
                speedKmh: cleanSpeed,
                timeSec,
                timestamp: new Date(timeSec * 1000),
                heading: cleanHeading,
                altitude: alt > -500 && alt < 10000 ? alt : undefined
              });

              z += layout.recordSize;
              matched = true;
              break;
            }
          }
        }

        if (!matched) {
          z += step;
        }
      }
    }
  }

  if (rawPoints.length === 0) {
    throw new Error(`${fileName} から有効なGPSログレコードを抽出できませんでした`);
  }

  // 時間順にソートする (同じ時刻のレコードは記録順のまま)
  rawPoints.sort((a, b) => a.timeSec - b.timeSec);

  // 重複の除去: 時刻・位置・速度がすべて同じレコードは、同じ記録が 2 回入ったものとして 1 つにする。
  // ミリ秒の無いログでは、止まっている間の同じ秒のレコードが同じ値になり得るので除かない
  const deduped = hasMilliseconds
    ? rawPoints.filter((r, i) => {
        const q = rawPoints[i - 1];
        return !q || q.timeSec !== r.timeSec || q.lat !== r.lat || q.lon !== r.lon || q.speedKmh !== r.speedKmh;
      })
    : rawPoints;

  // 同じ整数秒のレコードが続く部分 (ミリ秒が記録されていない) は、その 1 秒の中で等分して割り振る。
  // ミリ秒付きのログでも、ミリ秒が抜けた秒だけはこれで補う。同じ秒の中に次の時刻のレコードがあれば、
  // その手前までの間で割り振る (時刻の順が入れ替わらないように)
  for (let i = 0; i < deduped.length; ) {
    const curTs = deduped[i].timeSec;
    let count = 1;
    while (i + count < deduped.length && deduped[i + count].timeSec === curTs) count++;
    if (count > 1 && Number.isInteger(curTs)) {
      const next = deduped[i + count]?.timeSec ?? Infinity;
      const width = Math.min(1, next - curTs);
      for (let k = 0; k < count; k++) {
        const preciseTime = curTs + (k * width) / count;
        deduped[i + k].timeSec = preciseTime;
        deduped[i + k].timestamp = new Date(preciseTime * 1000);
      }
    }
    i += count;
  }

  // 記録の空きで走行を区切る
  const groups: RawPoint[][] = [];
  for (const r of deduped) {
    const g = groups[groups.length - 1];
    if (g && r.timeSec - g[g.length - 1].timeSec < SESSION_GAP_SEC) g.push(r);
    else groups.push([r]);
  }
  const span = (g: RawPoint[]) => g[g.length - 1].timeSec - g[0].timeSec;
  let kept = groups.filter(g => g.length >= 2 && span(g) >= MIN_SESSION_SEC);
  // どれも短いときは、いちばん長いものだけを読む
  if (kept.length === 0) kept = [groups.reduce((a, b) => (span(b) > span(a) || (span(b) === span(a) && b.length > a.length) ? b : a))];

  return kept.map(toSession);
}

// 区切った走行の点列を、先頭を 0 秒とした TelemetryPoint にして解析値を付ける
function toSession(
  rawPoints: { lat: number; lon: number; speedKmh: number; timeSec: number; timestamp?: Date; heading?: number; altitude?: number; satellites?: number }[]
): RawBinarySession {
  // 最初の時間を t=0 とする相対時間計算
  const t0 = rawPoints[0].timeSec;
  const startDate = rawPoints[0].timestamp;

  const points: TelemetryPoint[] = rawPoints.map((r, i) => ({
    index: i,
    time: Number((r.timeSec - t0).toFixed(4)),
    timestamp: r.timestamp?.toISOString(),
    latitude: Number(r.lat.toFixed(7)),
    longitude: Number(r.lon.toFixed(7)),
    altitude: Number((r.altitude ?? 0).toFixed(1)),
    ...(r.altitude === undefined ? { altitudeMissing: true } : {}),
    ...(r.satellites !== undefined ? { satellites: r.satellites } : {}),
    speed: Number(r.speedKmh.toFixed(2)),
    heading: r.heading ?? 0,
    distance: 0,
    accelG: 0,
    corneringG: 0,
    combinedG: 0,
    turningRadius: 9999,
    driftAngle: 0
  }));

  // 物理計算 (Gフォース、旋回半径、累積距離、方位角)
  const enriched = calculatePhysics(points);

  // 記録レートは時刻の刻みの中央値から求める (ピットでの停止など記録の空白に影響されないように)
  let samplingRate = 20;
  if (points.length > 20) {
    const steps: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const dt = points[i].time - points[i - 1].time;
      if (dt > 0) steps.push(dt);
    }
    steps.sort((x, y) => x - y);
    const median = steps[steps.length >> 1];
    if (median > 0) {
      const hz = Math.round(1 / median);
      if (hz >= 1 && hz <= 100) samplingRate = hz;
    }
  }

  return {
    points: enriched,
    samplingRate,
    startDate
  };
}
