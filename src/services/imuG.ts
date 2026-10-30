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
import type { GFilterLevel } from './physics';

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

/**
 * 低域のフィルターで残す上の周波数 (Hz)。「なめらか」の設定ごと。
 * 端末の G センサーには、ホルダー・車体・エンジンの細かい振動 (袖ヶ浦の 1 台では 12〜25 Hz) が乗る。
 * 運転で起きる G の変化 (ブレーキ・切り返し) は 3 Hz までに収まるので、それより上を捨てる
 */
export const IMU_CUTOFF_HZ: Record<GFilterLevel, number> = { weak: 4, standard: 2.5, strong: 1.5 };
/** これより間が空いた所は、つながっていないものとして分けてフィルターをかけ、間の値は作らない (ミリ秒) */
const GAP_MS = 200;

/** 2 次の Butterworth の低域のフィルターの係数 (fs: 1 秒の点の数) */
function butterLowPass(fc: number, fs: number): { b: [number, number, number]; a: [number, number] } {
  const k = Math.tan(Math.PI * Math.min(fc, fs * 0.45) / fs), q = Math.SQRT1_2, n = 1 / (1 + k / q + k * k);
  return { b: [k * k * n, 2 * k * k * n, k * k * n], a: [2 * (k * k - 1) * n, (1 - k / q + k * k) * n] };
}

/** 前から 1 回かける (はじめの値で始めて、立ち上がりの跳ねを出さない) */
function filterOnce(f: ReturnType<typeof butterLowPass>, x: Float32Array, from: number, to: number, reverse: boolean): void {
  const step = reverse ? -1 : 1;
  let i = reverse ? to - 1 : from;
  const x0 = x[i];
  let x1 = x0, x2 = x0, y1 = x0, y2 = x0;
  for (let c = from; c < to; c++, i += step) {
    const v = f.b[0] * x[i] + f.b[1] * x1 + f.b[2] * x2 - f.a[0] * y1 - f.a[1] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; x[i] = v;
  }
}

/** 前と後ろから 1 回ずつかける (遅れが出ない)。間の空いた所で分ける */
function filtfilt(t: Float64Array, v: Float32Array, fc: number): Float32Array {
  const out = Float32Array.from(v);
  let from = 0;
  for (let i = 1; i <= t.length; i++) {
    if (i < t.length && t[i] - t[i - 1] <= GAP_MS) continue;
    if (i - from >= 8) {
      const fs = 1000 * (i - 1 - from) / (t[i - 1] - t[from]);
      const f = butterLowPass(fc, fs);
      filterOnce(f, out, from, i, false);
      filterOnce(f, out, from, i, true);
    }
    from = i;
  }
  return out;
}

/** 低域のフィルターをかけた G センサーの値 (G センサーの値とフィルターごとに覚える) */
const filteredCache = new WeakMap<ImuTrack, Map<number, ImuTrack>>();
export function lowPassTrack(track: ImuTrack, fc: number): ImuTrack {
  let m = filteredCache.get(track);
  if (!m) { m = new Map(); filteredCache.set(track, m); }
  let f = m.get(fc);
  if (!f) { f = { t: track.t, long: filtfilt(track.t, track.long, fc), lat: filtfilt(track.t, track.lat, fc) }; m.set(fc, f); }
  return f;
}

/** 点ごとの G センサーの値 (前後の値の間をつなぐ。G センサーの無い所・間が空いた所は null) */
function imuAtPoints(points: TelemetryPoint[], track: ImuTrack, startUtc: number, offsetMs: number): Array<{ long: number; lat: number } | null> {
  const out: Array<{ long: number; lat: number } | null> = [];
  const { t } = track;
  let j = 0;
  for (const p of points) {
    const u = startUtc + p.time * 1000 + offsetMs;
    while (j + 1 < t.length && t[j + 1] < u) j++;
    if (j + 1 >= t.length || u < t[j] || t[j + 1] - t[j] > GAP_MS) { out.push(null); continue; }
    const k = (u - t[j]) / (t[j + 1] - t[j]);
    out.push({ long: track.long[j] + (track.long[j + 1] - track.long[j]) * k, lat: track.lat[j] + (track.lat[j + 1] - track.lat[j]) * k });
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
export function alignImu(points: TelemetryPoint[], rawTrack: ImuTrack, startUtc: number): number {
  const times = points.map(p => p.time);
  const track = lowPassTrack(rawTrack, IMU_CUTOFF_HZ.weak);
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
 * G センサーには、先に「なめらか」の設定の低域のフィルターをかける。G センサーの無い所は計算した G のまま
 */
export function fuseImuG(points: TelemetryPoint[], track: ImuTrack, startUtc: number, offsetMs: number, level: GFilterLevel = 'standard', windowSec = FUSE_WINDOW_SEC): TelemetryPoint[] {
  const times = points.map(p => p.time);
  const imu = imuAtPoints(points, lowPassTrack(track, IMU_CUTOFF_HZ[level]), startUtc, offsetMs);
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

export function applyImuToSession(points: TelemetryPoint[], session: Pick<Session, 'points' | 'clockOffsetSec'>, track: ImuTrack, level: GFilterLevel = 'standard'): { points: TelemetryPoint[]; offsetMs: number; wobbleG: number | null } {
  const start = sessionStartUtcMs({ ...session, points } as Session);
  if (start === null) return { points, offsetMs: 0, wobbleG: null };
  const key = `${start}|${points.length}`;
  let byKey = offsetCache.get(track);
  if (!byKey) { byKey = new Map(); offsetCache.set(track, byKey); }
  const offsetMs = byKey.get(key) ?? alignImu(points, track, start);
  byKey.set(key, offsetMs);
  return { points: fuseImuG(points, track, start, offsetMs, level), offsetMs, wobbleG: imuWobbleG(points, track, start, offsetMs) };
}

/**
 * 端末の揺れの判定。走っている間の 3〜8 Hz の揺れの強さ (G、5 秒ごとの RMS の中央値。加減速と横の大きいほう)。
 * この帯は運転の G より速く、低域のフィルターでも消えきらないので、大きいとグラフが揺れる (やわらかいホルダーなど)
 */
export const WOBBLE_LIMIT_G = 0.08;
const wobbleCache = new WeakMap<ImuTrack, Map<string, number | null>>();
export function imuWobbleG(points: TelemetryPoint[], track: ImuTrack, startUtc: number, offsetMs: number): number | null {
  const key = `${startUtc}|${offsetMs}|${points.length}`;
  let m = wobbleCache.get(track);
  if (!m) { m = new Map(); wobbleCache.set(track, m); }
  if (m.has(key)) return m.get(key)!;
  const hi = lowPassTrack(track, 8), lo = lowPassTrack(track, 3);
  // 走っている時刻 (30 km/h より速い) を、点から 5 秒ごとに拾う
  const moving = new Set<number>();
  for (const p of points) if (p.speed > 30) moving.add(Math.floor((startUtc + p.time * 1000 + offsetMs) / 5000));
  const sums = new Map<number, { l: number; a: number; n: number }>();
  for (let i = 0; i < track.t.length; i++) {
    const w = Math.floor(track.t[i] / 5000);
    if (!moving.has(w)) continue;
    const dl = hi.long[i] - lo.long[i], da = hi.lat[i] - lo.lat[i];
    const s = sums.get(w) ?? { l: 0, a: 0, n: 0 };
    s.l += dl * dl; s.a += da * da; s.n++;
    sums.set(w, s);
  }
  const rms = [...sums.values()].filter(s => s.n >= 50).map(s => Math.max(Math.sqrt(s.l / s.n), Math.sqrt(s.a / s.n))).sort((x, y) => x - y);
  const v = rms.length >= 6 ? rms[rms.length >> 1] : null;
  m.set(key, v);
  return v;
}

/** 開いている走行の揺れの判定 (applyImuToSession と同じ時計のずれを使う) */
export function sessionImuWobbleG(session: Pick<Session, 'points' | 'clockOffsetSec'>, track: ImuTrack): number | null {
  const start = sessionStartUtcMs(session as Session);
  if (start === null) return null;
  const key = `${start}|${session.points.length}`;
  let byKey = offsetCache.get(track);
  if (!byKey) { byKey = new Map(); offsetCache.set(track, byKey); }
  const offsetMs = byKey.get(key) ?? alignImu(session.points, track, start);
  byKey.set(key, offsetMs);
  return imuWobbleG(session.points, track, start, offsetMs);
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
