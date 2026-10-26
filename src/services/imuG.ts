/**
 * iPhone の G センサーの値 (<走行>.iphone_imu.csv) を、走行の G に合わせて使う (2026-10-25)。
 *
 * - 位置と車速から計算した G は、ゆっくりした変化 (全体の大きさ・坂の影響が混ざらない) は確かだが、細かく揺れ、ならすと速い変化が鈍る
 * - G センサーは速い変化 (ブレーキの踏み始め・切り返し) がはっきり出るが、坂・路面の傾き・付け方のずれでゆっくりずれる
 * そこで、ゆっくりした変化は計算した G、速い変化は G センサーから取って合わせる (計算した G を前後 FUSE_WINDOW_SEC でならしたもの
 * + G センサーから同じならし方のものを引いた残り)。あとから解析するので、前後を均等に使ってならす (遅れない)。
 *
 * 時刻: csv の時刻は iPhone の時計 (UTC)。ログの時刻とは少しずれることがあるので、前後の G (加減速) の形が
 * いちばん合う ずれ (±ALIGN_RANGE_MS) を探して合わせる
 */
import type { Session, TelemetryPoint } from '../types/telemetry';
import { sessionStartUtcMs } from './mediaClock';

export interface ImuTrack {
  /** UTC ミリ秒 (iPhone の時計) */
  t: Float64Array;
  /** 加減速 G (前へ加速が +) */
  long: Float32Array;
  /** 横 G (右が +) */
  lat: Float32Array;
}

/** ゆっくりした変化と速い変化を分ける、ならしの長さ (秒) */
export const FUSE_WINDOW_SEC = 1.2;
const ALIGN_RANGE_MS = 1500;
const ALIGN_STEP_MS = 20;

/** <走行>.iphone_imu.csv を読む。読めなければ null */
export function parseImuCsv(text: string | null): ImuTrack | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const head = lines[0]?.split(',') ?? [];
  const it = head.indexOf('time_utc_ms'), il = head.indexOf('g_long'), ia = head.indexOf('g_lat');
  if (it < 0 || il < 0 || ia < 0) return null;
  const t: number[] = [], long: number[] = [], lat: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const tt = Number(c[it]), l = Number(c[il]), a = Number(c[ia]);
    if (!c[it] || !c[il] || !c[ia] || !Number.isFinite(tt) || !Number.isFinite(l) || !Number.isFinite(a)) continue;
    // 時刻が戻った行 (書き足しの重なり) は飛ばす
    if (t.length && tt <= t[t.length - 1]) continue;
    t.push(tt); long.push(l); lat.push(a);
  }
  if (t.length < 20) return null;
  return { t: Float64Array.from(t), long: Float32Array.from(long), lat: Float32Array.from(lat) };
}

/** utc の前後 halfMs の G センサーの値の平均 (無ければ null) */
function imuMean(track: ImuTrack, utc: number, halfMs: number, start: number): { long: number; lat: number; next: number } | null {
  const { t } = track;
  let i = start;
  while (i < t.length && t[i] < utc - halfMs) i++;
  let n = 0, sl = 0, sa = 0;
  for (let j = i; j < t.length && t[j] <= utc + halfMs; j++) { sl += track.long[j]; sa += track.lat[j]; n++; }
  if (n === 0) return null;
  return { long: sl / n, lat: sa / n, next: i };
}

/** 点ごとの G センサーの値 (点の間隔の分を平均。無い所は null) */
function imuAtPoints(points: TelemetryPoint[], track: ImuTrack, startUtc: number, offsetMs: number): Array<{ long: number; lat: number } | null> {
  const out: Array<{ long: number; lat: number } | null> = [];
  let cursor = 0;
  for (let i = 0; i < points.length; i++) {
    const dt = i > 0 ? points[i].time - points[i - 1].time : i + 1 < points.length ? points[i + 1].time - points[i].time : 0.05;
    const half = Math.max(5, Math.min(500, (dt * 1000) / 2));
    const m = imuMean(track, startUtc + points[i].time * 1000 + offsetMs, half, cursor);
    if (m) cursor = m.next;
    out.push(m ? { long: m.long, lat: m.lat } : null);
  }
  return out;
}

/** 前後 windowSec の平均 (null は飛ばす) */
function smooth(times: number[], v: Array<number | null>, windowSec: number): Array<number | null> {
  const n = v.length;
  const out = new Array<number | null>(n).fill(null);
  let lo = 0, hi = 0, sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && times[hi] <= times[i] + windowSec / 2) { if (v[hi] !== null) { sum += v[hi]!; cnt++; } hi++; }
    while (lo < n && times[lo] < times[i] - windowSec / 2) { if (v[lo] !== null) { sum -= v[lo]!; cnt--; } lo++; }
    out[i] = cnt > 0 && v[i] !== null ? sum / cnt : null;
  }
  return out;
}

/**
 * G センサーの時刻のずれ (ミリ秒) を探す。計算した加減速 G と、G センサーの加減速 G (同じくらいにならしたもの) の形が
 * いちばん合う (相関が大きい) ずれ。走っている所が短すぎて決まらなければ 0
 */
export function alignImu(points: TelemetryPoint[], track: ImuTrack, startUtc: number): number {
  const times = points.map(p => p.time);
  const calc = smooth(times, points.map(p => (p.speed > 15 ? p.accelG : null)), 0.4);
  let best = 0, bestScore = -Infinity;
  for (let off = -ALIGN_RANGE_MS; off <= ALIGN_RANGE_MS; off += ALIGN_STEP_MS) {
    const imu = smooth(times, imuAtPoints(points, track, startUtc, off).map(x => x?.long ?? null), 0.4);
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < points.length; i += 2) {
      const a = calc[i], b = imu[i];
      if (a === null || b === null) continue;
      n++; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
    }
    if (n < 50) continue;
    const cov = sxy - (sx * sy) / n, va = sxx - (sx * sx) / n, vb = syy - (sy * sy) / n;
    const r = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -Infinity;
    if (r > bestScore) { bestScore = r; best = off; }
  }
  return bestScore > 0.3 ? best : 0;
}

/**
 * 点の G (加減速・横・合算) を、計算した G と G センサーを合わせたものに書き換える (points をそのまま直す)。
 * G センサーの無い所は計算した G のまま
 */
export function fuseImuG(points: TelemetryPoint[], track: ImuTrack, startUtc: number, offsetMs: number, windowSec = FUSE_WINDOW_SEC): TelemetryPoint[] {
  const times = points.map(p => p.time);
  const imu = imuAtPoints(points, track, startUtc, offsetMs);
  const calcLong = points.map(p => p.accelG), calcLat = points.map(p => p.corneringG);
  const lpCalcLong = smooth(times, calcLong, windowSec), lpCalcLat = smooth(times, calcLat, windowSec);
  const lpImuLong = smooth(times, imu.map(x => x?.long ?? null), windowSec);
  const lpImuLat = smooth(times, imu.map(x => x?.lat ?? null), windowSec);
  for (let i = 0; i < points.length; i++) {
    const m = imu[i];
    if (!m || lpImuLong[i] === null || lpImuLat[i] === null || lpCalcLong[i] === null || lpCalcLat[i] === null) continue;
    const p = points[i];
    p.accelG = lpCalcLong[i]! + (m.long - lpImuLong[i]!);
    p.corneringG = lpCalcLat[i]! + (m.lat - lpImuLat[i]!);
    p.combinedG = Math.hypot(p.accelG, p.corneringG);
  }
  return points;
}

/** ログに G センサーの値を合わせる (時刻のずれを探してから)。ログに時刻が無ければそのまま */
/** 見つけた時計のずれ (G センサーの値ごと・走行の始まりと点の数ごと)。ならし方を替えるたびに探し直すと重いので覚える */
const offsetCache = new WeakMap<ImuTrack, Map<string, number>>();

export function applyImuToSession(points: TelemetryPoint[], session: Pick<Session, 'points' | 'clockOffsetSec'>, track: ImuTrack): { points: TelemetryPoint[]; offsetMs: number } {
  const start = sessionStartUtcMs({ ...session, points } as Session);
  if (start === null) return { points, offsetMs: 0 };
  const key = `${start}|${points.length}`;
  let byKey = offsetCache.get(track);
  if (!byKey) { byKey = new Map(); offsetCache.set(track, byKey); }
  const offsetMs = byKey.get(key) ?? alignImu(points, track, start);
  byKey.set(key, offsetMs);
  return { points: fuseImuG(points, track, start, offsetMs), offsetMs };
}

/** G の出どころの設定 (sensor: G センサーがある走行は合わせる / calc: いつも計算した G) */
export type GSource = 'sensor' | 'calc';
const KEY = 'ds_g_source';
export function getGSource(): GSource {
  try { return localStorage.getItem(KEY) === 'calc' ? 'calc' : 'sensor'; } catch { return 'sensor'; }
}
export function setGSource(s: GSource): void {
  try { localStorage.setItem(KEY, s); } catch { /* 覚えられなくても使える */ }
}
