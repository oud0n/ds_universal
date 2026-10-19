import type { Session, TelemetryPoint } from '../types/telemetry';

/**
 * 同じ時間の 2 つのログを位置で比べる (BUG-08、docs/video_sets_design.md の 3・4)。1 回の比べで、次の 2 つを決める:
 * - 時計のずれ: 比べるログの各点について、時刻を d 秒ずらしたときの基準のログの位置 (時刻で補間) との距離を求め、
 *   距離の中央値が最も小さくなる d を探す。走っている (20 km/h 以上の) 区間だけを使う。
 *   速度の波形で合わせる方法より確か (速度はロガーごとに求め方・ならし方が違い、波形の形がずれるため)
 * - 同じ走行 (同じ車) のログか: 重なった時間を 1 分ずつに分けて、区間ごとのずれが全体のずれとそろうかを見る。
 *   時刻が重なるだけでは同じ車と限らない (同じ走行枠のチームメイトのログ)。後ろに付いて走る車は、
 *   一定の時間差が時計のずれに見えるが、区間ごとに差が変わり、ピットに入る時刻も違う
 *
 * offsetSec は「比べるログの時刻から引くと基準のログの時刻にそろう秒数」。比べるログが基準より 0.3 秒遅れて記録していれば +0.3
 */
export interface ClockOffsetEstimate {
  offsetSec: number;
  /** そのずれでの、2 つのログの位置の差の中央値 (m) */
  medianDistanceM: number;
  /** 比べた点の数 */
  samples: number;
  /** ずれを ±0.1 秒動かしたときの距離の増え方 (m)。小さいと、ずれがはっきり決まらない (直線ばかりの区間など) */
  sharpnessM: number;
}

/** 1 分ごとの区間のずれ */
export interface WindowEstimate {
  /** 区間の始め (比べるログの最初の比べた点からの秒) */
  startSec: number;
  offsetSec: number;
  medianDistanceM: number;
}

/** 見積もりの扱い。auto: そのまま入れる、suggest: 案として出す、reject: 使わない */
export type EstimateQuality = 'auto' | 'suggest' | 'reject';

/** 使わない・同じ走行でない理由 */
export type PairRejectReason = 'short' | 'offset-large' | 'windows' | 'stops' | 'far';

export interface PairAnalysis extends ClockOffsetEstimate {
  /** 比べた、走っている重なりの長さ (秒) */
  movingSec: number;
  windows: WindowEstimate[];
  /** 片方が止まっていて (5 km/h 未満)、もう片方が走っていた (30 km/h より速い) 時間 (秒) */
  stopMismatchSec: number;
  sameRun: boolean;
  quality: EstimateQuality;
  reason: PairRejectReason | null;
}

const MIN_SPEED_KMH = 20;
const SEARCH_RANGE_SEC = 10;
const MIN_SAMPLES = 100;
const MAX_GAP_SEC = 1.5;
const WINDOW_SEC = 60;
const MIN_WINDOW_SAMPLES = 30;

// 判定の値 (日光のデジスパイスと GoPro: 全体の位置の差 1.33 m、1 分ごとに 0.4〜0.9 m、鋭さ 0.76 m、区間のずれ 0.050〜0.085 秒)
const SAME_RUN = { minMovingSec: 60, maxOffsetSec: 1, windowMaxDistanceM: 3, windowMaxDeviationSec: 0.05, minGoodWindowShare: 0.8, maxStopMismatchSec: 10 };
const QUALITY = { autoMaxDistanceM: 2.5, suggestMaxDistanceM: 5, minSharpnessM: 0.3, minSharpnessPerDistance: 0.25, maxWindowSpreadSec: 0.06 };

/** 時刻 (秒、ログの時刻のまま) つきの点。Web Worker へは Float64Array に詰めて渡す */
export interface TimedPoint { t: number; lat: number; lon: number; speed: number }

export function toTimed(points: TelemetryPoint[]): TimedPoint[] {
  const out: TimedPoint[] = [];
  for (const p of points) {
    if (!p.timestamp) continue;
    const t = Date.parse(p.timestamp) / 1000;
    if (!Number.isFinite(t) || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    if (p.latitude === 0 && p.longitude === 0) continue;
    if (out.length > 0 && t <= out[out.length - 1].t) continue;
    out.push({ t, lat: p.latitude, lon: p.longitude, speed: p.speed });
  }
  return out;
}

/** 基準のログの、時刻 t の位置と速度 (前後の点で直線補間)。範囲外・間が 1.5 秒より空いているときは null (1 Hz のログの記録の揺れは許す) */
function sampleAt(ref: TimedPoint[], t: number): [number, number, number] | null {
  let lo = 0, hi = ref.length - 1;
  if (t < ref[0].t || t > ref[hi].t) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ref[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = ref[lo], b = ref[hi];
  if (b.t - a.t > MAX_GAP_SEC) return null;
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f, a.speed + (b.speed - a.speed) * f];
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

/**
 * ずれを d 秒としたときの、2 つのログの位置の差の中央値 (m)。
 * GPS の受信機ごとの位置の癖 (一定の向き・距離のずれ) は時計のずれと区別できないので、差の向きつきの中央値を引いてから測る
 * (周の中で走る向きが変わるので、時計のずれは向きによって違う差になり、一定のずれとは分けられる)
 */
function medianDistance(ref: TimedPoint[], other: TimedPoint[], d: number, cosLat: number): { median: number; n: number } {
  const dx: number[] = [], dy: number[] = [];
  for (const p of other) {
    const q = sampleAt(ref, p.t - d);
    if (!q) continue;
    dx.push((p.lon - q[1]) * 111320 * cosLat);
    dy.push((p.lat - q[0]) * 111320);
  }
  if (dx.length === 0) return { median: Infinity, n: 0 };
  const bx = median(dx), by = median(dy);
  return { median: median(dx.map((x, i) => Math.hypot(x - bx, dy[i] - by))), n: dx.length };
}

/** from〜to を step 秒刻みで探し、位置の差が最も小さいずれ。minN 点より少ないずれは使わない */
function search(ref: TimedPoint[], sample: TimedPoint[], from: number, to: number, step: number, cosLat: number, minN: number): { d: number; m: number } | null {
  let best: { d: number; m: number } | null = null;
  for (let d = from; d <= to + 1e-9; d += step) {
    const r = medianDistance(ref, sample, d, cosLat);
    if (r.n >= minN && (!best || r.median < best.m)) best = { d, m: r.median };
  }
  return best;
}

/** 比べるログの、基準のログと重なる (探す幅を含めて) 走っている点。多すぎるときは間引く */
function movingOverlap(ref: TimedPoint[], other: TimedPoint[]): TimedPoint[] {
  // 長いログの一部だけが重なるとき、ログ全体で間引くと重なりに点が残らないので、重なりの中で間引く
  // (見積もりの細かさは点の数より時刻の補間で決まる)
  const t0 = ref[0].t - SEARCH_RANGE_SEC, t1 = ref[ref.length - 1].t + SEARCH_RANGE_SEC;
  const moving = other.filter(p => p.speed >= MIN_SPEED_KMH && p.t >= t0 && p.t <= t1);
  const step = Math.max(1, Math.floor(moving.length / 3000));
  return moving.filter((_, i) => i % step === 0);
}

/** 2 つのログ (時刻つきの点) を比べる。重なる走行が短い (走っている点が 100 点未満) ときは null */
export function analyseTimed(ref: TimedPoint[], other: TimedPoint[]): PairAnalysis | null {
  if (ref.length < 2 || other.length < 2) return null;
  const sample = movingOverlap(ref, other);
  if (sample.length < MIN_SAMPLES) return null;
  const cosLat = Math.cos((sample[0].lat * Math.PI) / 180);

  // 粗く (0.1 秒刻み) 探してから、その前後を 0.005 秒刻みで詰める
  const coarse = search(ref, sample, -SEARCH_RANGE_SEC, SEARCH_RANGE_SEC, 0.1, cosLat, MIN_SAMPLES);
  if (!coarse) return null;
  const fine = search(ref, sample, coarse.d - 0.15, coarse.d + 0.15, 0.005, cosLat, MIN_SAMPLES) ?? coarse;
  const best = fine.d;
  const final = medianDistance(ref, sample, best, cosLat);
  const around = Math.min(medianDistance(ref, sample, best - 0.1, cosLat).median, medianDistance(ref, sample, best + 0.1, cosLat).median);
  const dts = sample.slice(1).map((p, i) => p.t - sample[i].t);
  const movingSec = final.n * median(dts);

  // 1 分ごとの区間のずれ (全体のずれの前後 0.3 秒で探す)
  const windows: WindowEstimate[] = [];
  const first = sample[0].t;
  for (let w = 0; first + w * WINDOW_SEC <= sample[sample.length - 1].t; w++) {
    const part = sample.filter(p => p.t >= first + w * WINDOW_SEC && p.t < first + (w + 1) * WINDOW_SEC);
    if (part.length < MIN_WINDOW_SAMPLES) continue;
    const r = search(ref, part, best - 0.3, best + 0.3, 0.005, cosLat, MIN_WINDOW_SAMPLES);
    if (r) windows.push({ startSec: w * WINDOW_SEC, offsetSec: round3(r.d), medianDistanceM: round2(r.m) });
  }

  // 止まった時刻がそろうか (ピット)。止まっている点も使うので、走っている点だけでなく全部の点で見る
  const step = Math.max(1, Math.floor(other.length / 6000));
  let stopMismatchSec = 0;
  for (let i = step; i < other.length; i += step) {
    const p = other[i];
    const q = sampleAt(ref, p.t - best);
    if (!q) continue;
    if ((p.speed < 5 && q[2] > 30) || (q[2] < 5 && p.speed > 30)) stopMismatchSec += Math.min(p.t - other[i - step].t, MAX_GAP_SEC * step);
  }

  const estimate: ClockOffsetEstimate = {
    offsetSec: round3(best),
    medianDistanceM: round2(final.median),
    samples: final.n,
    sharpnessM: round2(around - final.median)
  };
  return { ...estimate, movingSec: Math.round(movingSec), windows, stopMismatchSec: Math.round(stopMismatchSec), ...judge(estimate, movingSec, windows, stopMismatchSec) };
}

/** 同じ走行か、見積もりをどう扱うか (docs/video_sets_design.md の 3・4) */
function judge(e: ClockOffsetEstimate, movingSec: number, windows: WindowEstimate[], stopMismatchSec: number): Pick<PairAnalysis, 'sameRun' | 'quality' | 'reason'> {
  const good = windows.filter(w => w.medianDistanceM <= SAME_RUN.windowMaxDistanceM && Math.abs(w.offsetSec - e.offsetSec) <= SAME_RUN.windowMaxDeviationSec);
  const reason: PairRejectReason | null =
    movingSec < SAME_RUN.minMovingSec ? 'short'
    : Math.abs(e.offsetSec) > SAME_RUN.maxOffsetSec ? 'offset-large'
    : windows.length === 0 || good.length < windows.length * SAME_RUN.minGoodWindowShare ? 'windows'
    : stopMismatchSec > SAME_RUN.maxStopMismatchSec ? 'stops'
    : e.medianDistanceM > QUALITY.suggestMaxDistanceM ? 'far'
    : null;
  if (reason) return { sameRun: reason === 'far', quality: 'reject', reason };
  const offsets = good.map(w => w.offsetSec);
  const spread = Math.max(...offsets) - Math.min(...offsets);
  const sure = e.medianDistanceM <= QUALITY.autoMaxDistanceM &&
    e.sharpnessM >= QUALITY.minSharpnessM && e.sharpnessM >= QUALITY.minSharpnessPerDistance * e.medianDistanceM &&
    spread <= QUALITY.maxWindowSpreadSec;
  return { sameRun: true, quality: sure ? 'auto' : 'suggest', reason: null };
}

/** 2 つのログの時計のずれを見積もる (同じ走行の判定・品質を問わない)。重なる走行が短いときは null */
export function estimateClockOffset(reference: TelemetryPoint[], other: TelemetryPoint[]): ClockOffsetEstimate | null {
  const r = analyseTimed(toTimed(reference), toTimed(other));
  return r && { offsetSec: r.offsetSec, medianDistanceM: r.medianDistanceM, samples: r.samples, sharpnessM: r.sharpnessM };
}

/** 2 つのログを比べる (同じ走行か・見積もりの扱い)。重なる走行が短いときは null */
export function analyseLogPair(reference: TelemetryPoint[], other: TelemetryPoint[]): PairAnalysis | null {
  return analyseTimed(toTimed(reference), toTimed(other));
}

/** ログの記録の時間 (ログの時刻のまま、ミリ秒)。時刻のないログは null */
function sessionRange(s: Session): [number, number] | null {
  const a = s.points[0]?.timestamp;
  const ta = a ? Date.parse(a) : NaN;
  if (!Number.isFinite(ta)) return null;
  // 最後の点に時刻がないログ (NMEA の日付のない文で終わるものなど) は、時刻のある最後の点を使う
  for (let i = s.points.length - 1; i > 0; i--) {
    const b = s.points[i].timestamp;
    const tb = b ? Date.parse(b) : NaN;
    if (Number.isFinite(tb)) return [ta, tb];
  }
  return null;
}

/**
 * 時計のずれを見積もるときの基準のログの候補: 同じ時間に記録したほかのログのうち、基準車のログ (あれば) を先に、
 * あとは記録の細かい (Hz の高い) 順。重なる時間が 60 秒より短いログは使わない
 */
export function referenceCandidates(session: Session, sessions: Session[], preferredId?: string): Session[] {
  const r = sessionRange(session);
  if (!r) return [];
  return sessions
    .filter(s => {
      if (s.id === session.id) return false;
      const q = sessionRange(s);
      return !!q && Math.min(r[1], q[1]) - Math.max(r[0], q[0]) >= 60000;
    })
    .sort((x, y) => Number(y.id === preferredId) - Number(x.id === preferredId) || (y.samplingRate || 0) - (x.samplingRate || 0));
}

function round2(x: number): number { return Number(x.toFixed(2)); }
function round3(x: number): number { return Number(x.toFixed(3)); }
