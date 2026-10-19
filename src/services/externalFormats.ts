/**
 * 他社ロガー・解析ソフト形式の入出力
 *  - Racelogic VBO (.vbo) の読み込み
 *  - RaceChrono CSV (v2 / v3 エクスポート) の読み込み
 *  - GPX (.gpx) の読み込み
 *  - TCX (.tcx、Garmin の Training Center XML) の読み込み
 *  - MoTeC CSV (i2 の CSV エクスポート形式) の読み込み・書き出し
 */

import { Session, TelemetryPoint } from '../types/telemetry';
import { calculatePhysics, calculateGeoDistanceAndHeading } from './physics';
import { tr } from '../utils/i18n';

// MoTeC CSV の読み込み・書き出し。実物の i2 の書き出し (小数点がカンマのもの) で確かめて有効にした (2026-10-18)。
// false にすると、書き出しボタンと読み込み時の自動判別を止める
export const MOTEC_CSV_ENABLED = true;

export interface ImportedLog {
  points: TelemetryPoint[];
  samplingRate: number;
  startDate?: Date;
}

export interface RawSample {
  time: number;       // 先頭からの秒
  latitude: number;
  longitude: number;
  speedKmh: number;
  altitude: number;
  heading: number;
  timestamp?: Date;
  /** 位置・車速のほかに記録されている値 (アクセル・ブレーキなど)。点にそのまま付ける */
  extra?: Partial<Pick<TelemetryPoint, 'throttle' | 'brake' | 'steering' | 'rpm' | 'gear'>>;
}

/**
 * データの行の値から、小数点がカンマか (ヨーロッパの設定で書き出した CSV) を決める。
 * "47,2207022" のような値があればカンマ、"47.22" のような値があればピリオド。
 * カンマの後ろがちょうど 3 桁の値 ("1,000") は桁区切りかもしれないので、決め手にしない
 */
export function detectDecimalComma(lines: string[], start: number, maxRows = 30): boolean {
  let rows = 0;
  for (let i = start; i < lines.length && rows < maxRows; i++) {
    if (lines[i].trim() === '') continue;
    rows++;
    for (const cell of splitCsvLine(lines[i])) {
      const v = cell.trim();
      if (/^-?\d+\.\d+$/.test(v)) return false;
      const m = /^-?\d+,(\d+)$/.exec(v);
      if (m && m[1].length !== 3) return true;
    }
  }
  return false;
}

/** 引用符付きフィールドに対応した CSV 1 行の分割 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

function speedFactorToKmh(unit: string): number {
  const u = unit.toLowerCase().replace(/\s/g, '');
  if (u === 'm/s' || u === 'mps') return 3.6;
  if (u === 'mph') return 1.609344;
  if (u === 'kn' || u === 'kt' || u === 'knots') return 1.852;
  return 1; // km/h, kph
}

/** 時刻順に並んだ有効なサンプルだけを残し、TelemetryPoint へ変換して物理量を付与する */
// coordDigits: 緯度経度を丸める桁。60Hz の .ibt のように点の間隔が短いログでは、7 桁 (約 1 cm) の丸めが 3 点から求める旋回半径の誤差になる (偽の横 G) ので、桁を増やす
export function finalizeImportedSamples(samples: RawSample[], formatName: string, coordDigits = 7): ImportedLog {
  const points: TelemetryPoint[] = [];
  // 速度・方位の記録がない点 (速度の列がないログなど)。後で前後の点の位置と時刻から求める
  const noSpeed: number[] = [];
  const noHeading: number[] = [];
  let lastTime = -Infinity;
  let t0: number | null = null;
  let startDate: Date | undefined;
  for (const s of samples) {
    if (!Number.isFinite(s.time) || !Number.isFinite(s.latitude) || !Number.isFinite(s.longitude)) continue;
    if (Math.abs(s.latitude) > 90 || Math.abs(s.longitude) > 180) continue;
    // 未測位の行 (0, 0) と、時刻が進んでいない重複行は捨てる
    if (s.latitude === 0 && s.longitude === 0) continue;
    if (s.time <= lastTime) continue;
    lastTime = s.time;
    // 先頭の有効サンプルを 0 秒にそろえる
    if (t0 === null) {
      t0 = s.time;
      startDate = s.timestamp;
    }
    if (!Number.isFinite(s.speedKmh)) noSpeed.push(points.length);
    if (!Number.isFinite(s.heading)) noHeading.push(points.length);
    points.push({
      index: points.length,
      time: Number((s.time - t0).toFixed(3)),
      timestamp: s.timestamp?.toISOString(),
      latitude: Number(s.latitude.toFixed(coordDigits)),
      longitude: Number(s.longitude.toFixed(coordDigits)),
      altitude: Number((Number.isFinite(s.altitude) ? s.altitude : 0).toFixed(2)),
      ...(Number.isFinite(s.altitude) ? {} : { altitudeMissing: true }),
      speed: Number((Number.isFinite(s.speedKmh) ? Math.max(0, s.speedKmh) : 0).toFixed(2)),
      heading: Number.isFinite(s.heading) ? s.heading : 0,
      distance: 0,
      accelG: 0,
      corneringG: 0,
      combinedG: 0,
      turningRadius: 9999,
      driftAngle: 0,
      ...s.extra
    });
  }
  if (points.length < 2) {
    throw new Error(tr(`${formatName} から有効な GPS 位置データを読み取れませんでした`, `Could not read valid GPS positions from ${formatName}`));
  }
  const fromNeighbours = (i: number) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    return { ...calculateGeoDistanceAndHeading(a.latitude, a.longitude, b.latitude, b.longitude), dt: b.time - a.time };
  };
  for (const i of noSpeed) {
    const { distanceMeters, dt } = fromNeighbours(i);
    if (dt > 0) points[i].speed = Number(((distanceMeters / dt) * 3.6).toFixed(2));
  }
  for (const i of noHeading) {
    const { distanceMeters, headingDeg } = fromNeighbours(i);
    if (distanceMeters > 0) points[i].heading = headingDeg;
  }
  const enriched = calculatePhysics(points);
  const duration = enriched[enriched.length - 1].time - enriched[0].time;
  const samplingRate = duration > 0 ? Math.max(1, Math.round((enriched.length - 1) / duration)) : 10;
  return { points: enriched, samplingRate, startDate };
}

// ============================================================================
// Racelogic VBO
// ============================================================================

export function isVbo(text: string): boolean {
  return /^\s*\[column names\]\s*$/im.test(text) && /^\s*\[data\]\s*$/im.test(text);
}

export function parseVbo(text: string): ImportedLog {
  const lines = text.split(/\r?\n/);
  let section = '';
  let columns: string[] = [];
  const rows: string[][] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { section = m[1].toLowerCase(); continue; }
    if (section === 'column names' && columns.length === 0) columns = line.split(/\s+/).map(c => c.toLowerCase());
    else if (section === 'data') rows.push(line.split(/\s+/));
  }

  const col = (...names: string[]) => columns.findIndex(c => names.includes(c));
  const cTime = col('time');
  const cLat = col('lat', 'latitude');
  const cLon = col('long', 'lng', 'lon', 'longitude');
  const cSpeed = col('velocity', 'speed');
  const cHeading = col('heading');
  const cHeight = col('height', 'altitude');
  if (cTime < 0 || cLat < 0 || cLon < 0) {
    throw new Error(tr('VBO ファイルに time / lat / long の列が見つかりません', 'No time / lat / long columns were found in the VBO file'));
  }

  // 作成日 ("File created on dd/mm/yyyy ...") を記録開始日として使う
  const dm = /created on (\d{2})\/(\d{2})\/(\d{4})/i.exec(lines[0] || '');
  const baseDate = dm ? Date.UTC(Number(dm[3]), Number(dm[2]) - 1, Number(dm[1])) : null;

  const samples: RawSample[] = [];
  let dayOffset = 0;
  let prevSec = -1;
  for (const r of rows) {
    // 時刻は UTC の HHMMSS.ss
    const tv = parseFloat(r[cTime]);
    if (!Number.isFinite(tv)) continue;
    const sec = Math.floor(tv / 10000) * 3600 + Math.floor((tv % 10000) / 100) * 60 + (tv % 100);
    if (prevSec >= 0 && sec < prevSec - 43200) dayOffset += 86400; // 日付またぎ
    prevSec = sec;
    const t = sec + dayOffset;
    samples.push({
      time: t,
      // 緯度・経度は「分」単位。経度は西経が正
      latitude: parseFloat(r[cLat]) / 60,
      longitude: -parseFloat(r[cLon]) / 60,
      speedKmh: cSpeed >= 0 ? parseFloat(r[cSpeed]) : NaN,
      altitude: cHeight >= 0 ? parseFloat(r[cHeight]) : NaN,
      heading: cHeading >= 0 ? parseFloat(r[cHeading]) : NaN,
      timestamp: baseDate !== null ? new Date(baseDate + t * 1000) : undefined
    });
  }
  return finalizeImportedSamples(samples, tr('VBO ファイル', 'the VBO file'));
}

// ============================================================================
// RaceChrono CSV
// ============================================================================

export function isRaceChronoCsv(text: string): boolean {
  return /^.*created using RaceChrono/i.test(text.substring(0, 200));
}

export function parseRaceChronoCsv(text: string): ImportedLog {
  const lines = text.split(/\r?\n/);
  // v3: "timestamp,fragment_id,..." + 単位行 + 取得元行 / v2: "Time (s),Session fragment #,..."
  const headerIdx = lines.findIndex(l => /^"?timestamp"?,/i.test(l) || /^"?Time \(s\)"?,/i.test(l));
  if (headerIdx < 0) throw new Error(tr('RaceChrono CSV の列見出しが見つかりません', 'Column headers were not found in the RaceChrono CSV'));

  const header = splitCsvLine(lines[headerIdx]).map(h => h.toLowerCase());
  const isV3 = header[0] === 'timestamp';
  const units = isV3 ? splitCsvLine(lines[headerIdx + 1] || '') : [];
  const sources = isV3 ? splitCsvLine(lines[headerIdx + 2] || '') : [];
  const dataStart = headerIdx + (isV3 ? 3 : 1);

  let cTime: number, cLat: number, cLon: number, cSpeed: number, cAlt: number, cBearing: number;
  let speedFactor = 3.6; // RaceChrono の既定は m/s
  if (isV3) {
    cTime = 0;
    cLat = header.indexOf('latitude');
    cLon = header.indexOf('longitude');
    cAlt = header.indexOf('altitude');
    cBearing = header.indexOf('bearing');
    // 同名の speed 列が複数ある (GPS / 算出値 / OBD)。GPS 由来を優先する
    const speedCols = header.map((h, i) => (h === 'speed' ? i : -1)).filter(i => i >= 0);
    cSpeed = speedCols.find(i => /gps/i.test(sources[i] || '')) ?? speedCols[0] ?? -1;
    if (cSpeed >= 0 && units[cSpeed]) speedFactor = speedFactorToKmh(units[cSpeed]);
  } else {
    const find = (re: RegExp) => header.findIndex(h => re.test(h) && !h.includes('*'));
    cTime = 0;
    cLat = find(/^latitude/);
    cLon = find(/^longitude/);
    cAlt = find(/^altitude/);
    cBearing = find(/^bearing/);
    cSpeed = find(/^speed/);
    const um = cSpeed >= 0 ? /\(([^)]+)\)/.exec(header[cSpeed]) : null;
    if (um) speedFactor = speedFactorToKmh(um[1]);
  }
  if (cLat < 0 || cLon < 0) throw new Error(tr('RaceChrono CSV に latitude / longitude の列が見つかりません', 'No latitude / longitude columns were found in the RaceChrono CSV'));

  const samples: RawSample[] = [];
  for (let i = dataStart; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const c = splitCsvLine(lines[i]);
    const unix = parseFloat(c[cTime]);
    if (!Number.isFinite(unix)) continue;
    samples.push({
      time: unix,
      latitude: parseFloat(c[cLat]),
      longitude: parseFloat(c[cLon]),
      speedKmh: cSpeed >= 0 ? parseFloat(c[cSpeed]) * speedFactor : NaN,
      altitude: cAlt >= 0 ? parseFloat(c[cAlt]) : NaN,
      heading: cBearing >= 0 ? parseFloat(c[cBearing]) : NaN,
      // 時刻列は UNIX 時間 (秒)
      timestamp: unix > 1e8 ? new Date(unix * 1000) : undefined
    });
  }
  return finalizeImportedSamples(samples, 'RaceChrono CSV');
}

// ============================================================================
// GPX
// ============================================================================

export function isGpx(text: string): boolean {
  return /<gpx[\s>]/i.test(text.substring(0, 2000));
}

/** 要素の中身を取り出す。名前空間の接頭辞 (gpxtpx: など) は問わない */
function gpxTag(body: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([^<]*)<`, 'i').exec(body);
  return m ? m[1].trim() : undefined;
}

/**
 * GPX (1.0 / 1.1) の航跡 (trk > trkseg > trkpt) を読む。複数の trk / trkseg は連結する
 * 速度は <speed> (GPX 1.0) か拡張要素 (gpxtpx:speed など) の m/s を使い、なければ位置と時刻から求める
 */
export function parseGpx(text: string): ImportedLog {
  const raw: TrackPoint[] = [];
  const re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1];
    const body = m[2] || '';
    const lat = parseFloat(/\blat\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '');
    const lon = parseFloat(/\blon\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '');
    const time = gpxTag(body, 'time');
    const t = time ? Date.parse(time) / 1000 : NaN;
    raw.push({
      t,
      lat,
      lon,
      ele: parseFloat(gpxTag(body, 'ele') ?? ''),
      speedMs: parseFloat(gpxTag(body, 'speed') ?? ''),
      course: parseFloat(gpxTag(body, 'course') ?? '')
    });
  }
  if (raw.length === 0) throw new Error(tr('GPX ファイルに航跡 (trkpt) が見つかりません', 'No track points (trkpt) were found in the GPX file'));
  return trackToLog(raw, tr('GPX ファイル', 'the GPX file'));
}

/** 航跡の点 (GPX・TCX・FIT で共通)。t は UNIX 秒、speedMs・course は記録がなければ NaN */
export interface TrackPoint { t: number; lat: number; lon: number; ele: number; speedMs: number; course: number }

/**
 * 航跡の点を、ログの点にする (GPX・TCX・FIT で共通)。時刻・位置のない点を除き、同じ秒の点を割り振り、
 * 速度の記録がない点は前後の点から求める
 */
export function trackToLog(rawIn: TrackPoint[], formatName: string): ImportedLog {
  // 時刻・位置のない点と未測位の点 (0, 0) は、時刻の割り振りと速度の計算より前に除く (前後の点の速度を壊さないため)
  const valid = rawIn.filter(p => Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lon) && !(p.lat === 0 && p.lon === 0));
  if (valid.length === 0) throw new Error(tr(`${formatName} に時刻と位置のある点がないため読み込めません`, `${formatName} has no points with both a time and a position`));
  // 点の多いログで引数の上限を超えないよう、1 つずつ入れる (push(...valid) は十数万点で失敗する)
  const raw: TrackPoint[] = [];
  for (const p of valid) raw.push({ ...p });

  // 時刻が秒単位までしかない形式では同じ時刻の点が続く。次の時刻までを等間隔に割り振って間引かれないようにする
  // 次の時刻が 1 秒より先 (測位の途切れ・区間の切れ目) や、末尾で次の時刻がないときは、1 秒の中に割り振る
  for (let i = 0; i < raw.length; ) {
    let j = i + 1;
    while (j < raw.length && raw[j].t === raw[i].t) j++;
    if (j - i > 1) {
      const next = j < raw.length && raw[j].t > raw[i].t ? Math.min(raw[j].t, raw[i].t + 1) : raw[i].t + 1;
      const step = (next - raw[i].t) / (j - i);
      for (let k = i + 1; k < j; k++) raw[k].t = raw[i].t + (k - i) * step;
    }
    i = j;
  }

  // 速度がない点は、前後の点の移動距離と時刻差から求める
  const samples: RawSample[] = raw.map((p, i) => {
    let speedKmh = Number.isFinite(p.speedMs) ? p.speedMs * 3.6 : NaN;
    if (!Number.isFinite(speedKmh)) {
      const a = raw[Math.max(0, i - 1)];
      const b = raw[Math.min(raw.length - 1, i + 1)];
      const dt = b.t - a.t;
      if (dt > 0) speedKmh = (calculateGeoDistanceAndHeading(a.lat, a.lon, b.lat, b.lon).distanceMeters / dt) * 3.6;
    }
    return {
      time: p.t,
      latitude: p.lat,
      longitude: p.lon,
      speedKmh,
      altitude: p.ele,
      heading: p.course,
      timestamp: new Date(p.t * 1000)
    };
  });
  return finalizeImportedSamples(samples, formatName);
}

// ============================================================================
// TCX (Garmin Training Center XML)
// ============================================================================

export function isTcx(text: string): boolean {
  return /<TrainingCenterDatabase[\s>]/i.test(text.substring(0, 3000));
}

/**
 * TCX の Trackpoint を読む (Activity > Lap > Track > Trackpoint。複数の Lap・Track は連結する)。
 * 速度は拡張要素 (TPX の Speed、m/s) を使い、なければ位置と時刻から求める。位置のない点 (室内の記録など) は除く
 */
export function parseTcx(text: string): ImportedLog {
  const raw: TrackPoint[] = [];
  const re = /<(?:[\w-]+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Trackpoint>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    const time = gpxTag(body, 'Time');
    raw.push({
      t: time ? Date.parse(time) / 1000 : NaN,
      lat: parseFloat(gpxTag(body, 'LatitudeDegrees') ?? ''),
      lon: parseFloat(gpxTag(body, 'LongitudeDegrees') ?? ''),
      ele: parseFloat(gpxTag(body, 'AltitudeMeters') ?? ''),
      speedMs: parseFloat(gpxTag(body, 'Speed') ?? ''),
      course: NaN
    });
  }
  if (raw.length === 0) throw new Error(tr('TCX ファイルに Trackpoint が見つかりません', 'No Trackpoint elements were found in the TCX file'));
  return trackToLog(raw, tr('TCX ファイル', 'the TCX file'));
}

// ============================================================================
// MoTeC CSV
// ============================================================================

export function isMotecCsv(text: string): boolean {
  const first = splitCsvLine(text.trimStart().split(/\r?\n/, 1)[0] || '');
  return first[0] === 'Format' && first[1] === 'MoTeC CSV File';
}

export function parseMotecCsv(text: string): ImportedLog {
  const lines = text.split(/\r?\n/);
  // チャンネル名の行 (先頭が Time) と、その次の空でない行 (単位。先頭が s) を探す
  let headerIdx = -1;
  let unitIdx = -1;
  for (let i = 0; i < lines.length && headerIdx < 0; i++) {
    if (splitCsvLine(lines[i])[0] !== 'Time') continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (/^s(ec(onds?)?)?$/i.test(splitCsvLine(lines[j] || '')[0] ?? '')) { headerIdx = i; unitIdx = j; }
  }
  if (headerIdx < 0) throw new Error(tr('MoTeC CSV のチャンネル見出し (Time / s) が見つかりません', 'Channel headers (Time / s) were not found in the MoTeC CSV'));

  const names = splitCsvLine(lines[headerIdx]).map(n => n.toLowerCase());
  const units = splitCsvLine(lines[unitIdx]);
  const find = (...patterns: RegExp[]) => {
    for (const re of patterns) {
      const idx = names.findIndex(n => re.test(n));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const cLat = find(/^gps lat/, /^latitude/, /gps.*lat/);
  const cLon = find(/^gps lon/, /^longitude/, /gps.*lon/);
  const cSpeed = find(/^gps speed/, /^ground speed/, /^speed$/, /^corr speed/, /speed/);
  const cAlt = find(/^gps alt/, /^altitude/, /gps.*(alt|height)/);
  const cHeading = find(/^gps heading/, /^heading/);
  if (cLat < 0 || cLon < 0) {
    throw new Error(tr('この MoTeC CSV には GPS の緯度・経度チャンネルがないため読み込めません (本アプリの解析には位置情報が必要です)', 'This MoTeC CSV has no GPS latitude / longitude channels, so it cannot be loaded (the app needs positions for analysis)'));
  }
  const speedFactor = cSpeed >= 0 ? speedFactorToKmh(units[cSpeed] || 'km/h') : 1;

  // 記録日時 (Log Date dd/mm/yyyy, Log Time hh:mm:ss) があれば開始時刻にする
  let start: number | null = null;
  const meta = new Map<string, string>();
  for (let i = 0; i < headerIdx; i++) {
    const c = splitCsvLine(lines[i]);
    for (let k = 0; k + 1 < c.length; k++) if (c[k] && !meta.has(c[k])) meta.set(c[k], c[k + 1]);
  }
  // 日付は dd/mm/yyyy か dd.mm.yyyy。タイムゾーンは記録されていないので、この端末の時刻として読む
  const dm = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(meta.get('Log Date') || '');
  const tm = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(meta.get('Log Time') || '');
  if (dm) {
    // 日 / 月 の順。月が 12 を超えるときは 月 / 日 の順 (米国の設定) とみなす。どちらでも読めないときは日時なし
    let day = Number(dm[1]);
    let month = Number(dm[2]);
    if (month > 12 && day <= 12) [day, month] = [month, day];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      start = new Date(Number(dm[3]), month - 1, day, tm ? Number(tm[1]) : 0, tm ? Number(tm[2]) : 0, tm ? Number(tm[3]) : 0).getTime();
    }
  }
  // ヨーロッパの設定の i2 は小数点がカンマ ("47,2207022")。ファイル全体で決める (英語の設定の "1,000" を 1 にしない)
  const decimalComma = detectDecimalComma(lines, unitIdx + 1);
  const num = (v: string | undefined) => parseFloat(decimalComma ? (v ?? '').replace(/\./g, '').replace(',', '.') : (v ?? '').replace(/,/g, ''));

  const samples: RawSample[] = [];
  for (let i = unitIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const c = splitCsvLine(lines[i]);
    const t = num(c[0]);
    if (!Number.isFinite(t)) continue;
    samples.push({
      time: t,
      latitude: num(c[cLat]),
      longitude: num(c[cLon]),
      speedKmh: cSpeed >= 0 ? num(c[cSpeed]) * speedFactor : NaN,
      altitude: cAlt >= 0 ? num(c[cAlt]) : NaN,
      heading: cHeading >= 0 ? num(c[cHeading]) : NaN,
      timestamp: start !== null ? new Date(start + t * 1000) : undefined
    });
  }
  return finalizeImportedSamples(samples, 'MoTeC CSV');
}

/** セッション全体を MoTeC CSV 形式で書き出す。ラップの区切りは Beacon Markers に記録する */
export function exportMotecCsv(session: Session): string {
  const pts = session.points;
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const t0 = pts[0]?.time ?? 0;
  const d0 = pts[0]?.distance ?? 0;
  const duration = pts.length > 0 ? pts[pts.length - 1].time - t0 : 0;
  const endDistanceM = pts.length > 0 ? (pts[pts.length - 1].distance - d0) * 1000 : 0;

  const startDate = pts[0]?.timestamp ? new Date(pts[0].timestamp) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  // MoTeC の記録日時はロガーの時計 (タイムゾーンなし)。この端末の時刻で書く (読み込みと同じ)
  const logDate = startDate ? `${pad(startDate.getDate())}/${pad(startDate.getMonth() + 1)}/${startDate.getFullYear()}` : '';
  const logTime = startDate ? `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}:${pad(startDate.getSeconds())}` : '';

  // ラップの終了時刻 (セッション先頭からの秒)。ラップが 1 つだけ (区切りなし) の場合は出力しない
  const beacons = session.laps.length > 1 ? session.laps.map(l => (l.endTime - t0).toFixed(3)).join(' ') : '';

  const head = [
    `${q('Format')},${q('MoTeC CSV File')},,,${q('Workbook')},${q('')}`,
    `${q('Venue')},${q(session.circuitName || '')},,,${q('Worksheet')},${q('')}`,
    `${q('Vehicle')},${q(session.vehicleName || '')},,,${q('Vehicle Desc')},${q('')}`,
    `${q('Driver')},${q(session.driverName || '')},,,${q('Engine ID')},${q('')}`,
    `${q('Device')},${q('DS Universal')}`,
    `${q('Comment')},${q(session.sessionName)},,,${q('Session')},${q('')}`,
    `${q('Log Date')},${q(logDate)},,,${q('Origin Time')},${q('0.000')},${q('s')}`,
    `${q('Log Time')},${q(logTime)},,,${q('Start Time')},${q('0.000')},${q('s')}`,
    `${q('Sample Rate')},${q(session.samplingRate.toFixed(3))},${q('Hz')},,${q('End Time')},${q(duration.toFixed(3))},${q('s')}`,
    `${q('Duration')},${q(duration.toFixed(3))},${q('s')},,${q('Start Distance')},${q('0')},${q('m')}`,
    `${q('Range')},${q('entire outing')},,,${q('End Distance')},${q(endDistanceM.toFixed(0))},${q('m')}`,
    `${q('Beacon Markers')},${q(beacons)}`,
    '',
    '',
    ['Time', 'Distance', 'GPS Latitude', 'GPS Longitude', 'GPS Altitude', 'Ground Speed', 'GPS Heading', 'G Force Long', 'G Force Lat'].map(q).join(','),
    ['s', 'm', 'deg', 'deg', 'm', 'km/h', 'deg', 'G', 'G'].map(q).join(','),
    '',
    ''
  ];

  const rows = pts.map(p => [
    (p.time - t0).toFixed(3),
    ((p.distance - d0) * 1000).toFixed(1),
    p.latitude.toFixed(7),
    p.longitude.toFixed(7),
    p.altitude.toFixed(2),
    p.speed.toFixed(2),
    p.heading.toFixed(1),
    p.accelG.toFixed(3),
    p.corneringG.toFixed(3)
  ].map(q).join(','));

  return [...head, ...rows].join('\r\n') + '\r\n';
}
