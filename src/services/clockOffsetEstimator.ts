import type { Session, TelemetryPoint } from '../types/telemetry';

/**
 * 同じ走行を別々のロガーで記録した 2 つのログの、時計のずれ (GPS の受信・記録の遅れ) を見積もる (BUG-08)。
 *
 * 位置で合わせる: 比べるログの各点について、時刻を d 秒ずらしたときの基準のログの位置 (時刻で補間) との距離を求め、
 * 距離の中央値が最も小さくなる d を探す。走っている (20 km/h 以上の) 区間だけを使う。
 * 速度の波形で合わせる方法より確か (速度はロガーごとに求め方・ならし方が違い、波形の形がずれるため)。
 *
 * 結果の offsetSec は「比べるログの時刻から引くと基準のログの時刻にそろう秒数」。
 * 比べるログが基準より 0.3 秒遅れて記録していれば +0.3
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

const MIN_SPEED_KMH = 20;
const SEARCH_RANGE_SEC = 10;
const MIN_SAMPLES = 100;

interface TimedPoint { t: number; lat: number; lon: number; speed: number }

function toTimed(points: TelemetryPoint[]): TimedPoint[] {
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

/** 基準のログの、時刻 t の位置 (前後の点で直線補間)。範囲外・間が 1 秒より空いているときは null */
function positionAt(ref: TimedPoint[], t: number): [number, number] | null {
  let lo = 0, hi = ref.length - 1;
  if (t < ref[0].t || t > ref[hi].t) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ref[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = ref[lo], b = ref[hi];
  if (b.t - a.t > 1) return null;
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f];
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
    const q = positionAt(ref, p.t - d);
    if (!q) continue;
    dx.push((p.lon - q[1]) * 111320 * cosLat);
    dy.push((p.lat - q[0]) * 111320);
  }
  if (dx.length === 0) return { median: Infinity, n: 0 };
  const bx = median(dx), by = median(dy);
  return { median: median(dx.map((x, i) => Math.hypot(x - bx, dy[i] - by))), n: dx.length };
}

/** 2 つのログの時計のずれを見積もる。重なる走行が短い (走っている点が 100 点未満) ときは null */
export function estimateClockOffset(reference: TelemetryPoint[], other: TelemetryPoint[]): ClockOffsetEstimate | null {
  const ref = toTimed(reference);
  const all = toTimed(other);
  if (ref.length < 2 || all.length < 2) return null;
  // 比べる点は走っている区間だけ。多すぎるときは間引く (見積もりの細かさは点の数より時刻の補間で決まる)
  const moving = all.filter(p => p.speed >= MIN_SPEED_KMH);
  const step = Math.max(1, Math.floor(moving.length / 3000));
  const sample = moving.filter((_, i) => i % step === 0);
  if (sample.length < MIN_SAMPLES) return null;
  const cosLat = Math.cos((sample[0].lat * Math.PI) / 180);

  // 粗く (0.1 秒刻み) 探してから、その前後を 0.005 秒刻みで詰める
  let best = 0, bestM = Infinity;
  for (let d = -SEARCH_RANGE_SEC; d <= SEARCH_RANGE_SEC + 1e-9; d += 0.1) {
    const r = medianDistance(ref, sample, d, cosLat);
    if (r.n >= MIN_SAMPLES && r.median < bestM) { bestM = r.median; best = d; }
  }
  if (!Number.isFinite(bestM)) return null;
  const coarse = best;
  for (let d = coarse - 0.15; d <= coarse + 0.15 + 1e-9; d += 0.005) {
    const r = medianDistance(ref, sample, d, cosLat);
    if (r.n >= MIN_SAMPLES && r.median < bestM) { bestM = r.median; best = d; }
  }
  const final = medianDistance(ref, sample, best, cosLat);
  const around = Math.min(medianDistance(ref, sample, best - 0.1, cosLat).median, medianDistance(ref, sample, best + 0.1, cosLat).median);
  return {
    offsetSec: Number(best.toFixed(3)),
    medianDistanceM: Number(final.median.toFixed(2)),
    samples: final.n,
    sharpnessM: Number((around - final.median).toFixed(2))
  };
}

/** ログの記録の時間 (ログの時刻のまま、ミリ秒)。時刻のないログは null */
function sessionRange(s: Session): [number, number] | null {
  const a = s.points[0]?.timestamp, b = s.points[s.points.length - 1]?.timestamp;
  const ta = a ? Date.parse(a) : NaN, tb = b ? Date.parse(b) : NaN;
  return Number.isFinite(ta) && Number.isFinite(tb) ? [ta, tb] : null;
}

/**
 * 時計のずれを見積もるときの基準のログ: 同じ時間に記録したほかのログのうち、基準車のログ (あれば)、なければ記録の細かい (Hz の高い) もの。
 * 重なる時間が 60 秒より短いログは使わない
 */
export function pickReferenceSession(session: Session, sessions: Session[], preferredId?: string): Session | null {
  const r = sessionRange(session);
  if (!r) return null;
  const candidates = sessions.filter(s => {
    if (s.id === session.id) return false;
    const q = sessionRange(s);
    return !!q && Math.min(r[1], q[1]) - Math.max(r[0], q[0]) >= 60000;
  });
  return candidates.find(s => s.id === preferredId)
    ?? candidates.sort((x, y) => (y.samplingRate || 0) - (x.samplingRate || 0))[0]
    ?? null;
}
