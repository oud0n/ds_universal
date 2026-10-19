/**
 * 知らないコース (内蔵のコースにも、利用者が置いたコースにもない) での、計測線とセクター線の自動の設定 (PLAN-12)。
 *
 * 計測線: 周回するログでは、コースのどの場所も 1 周に 1 回通る。速く走っている直線の部分に、進む向きと直角な線を置いてみて、
 * いちばん多く (毎周) 通る線のうち、メインストレートらしい直線の真ん中のものを選ぶ (直線の真ん中なら、走るラインが少し違っても
 * 線をまたぐ角度が変わらない)。メインストレートは、ピットロードの横にある直線とする: ログはふつうピットから走り始めるので、
 * 走り始めのゆっくり走った道 (ピットロード) から 50 m 以内の直線を先に選ぶ。そういう直線がなければ、いちばん長い直線。
 * 周回していないログ (2 周に満たない) では使わない。
 * セクター線: 計測線で区切った周のうち速い周を、距離で 3 等分した所に置く
 */
import type { ControlLine, Sector, TelemetryPoint } from '../types/telemetry';
import { findGateCrossings, Gate } from './lapCalculator';

export const AUTO_CONTROL_LINE_NAME = '自動の計測線';

const MIN_SPEED_KMH = 30;
/** 直線とみなす向きの違い (度) */
const STRAIGHT_DEG = 6;
/** 線の半分の長さの上限・下限 (m) */
const MAX_HALF_M = 20;
const MIN_HALF_M = 8;
/** ピットロードを走るときの速さの上限 (km/h) */
const PIT_MAX_KMH = 60;

interface Local { x: number; y: number; d: number }

/** 点を平面 (m) に直す。d は走った距離 (m) */
function toLocal(points: TelemetryPoint[]): { pts: Local[]; lat0: number; lon0: number; cosLat: number } {
  const lat0 = points[0].latitude, lon0 = points[0].longitude;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  let d = 0;
  const pts = points.map((p, i) => {
    const x = (p.longitude - lon0) * 111320 * cosLat, y = (p.latitude - lat0) * 111320;
    if (i > 0) {
      const q = points[i - 1];
      d += Math.hypot(x - (q.longitude - lon0) * 111320 * cosLat, y - (q.latitude - lat0) * 111320);
    }
    return { x, y, d };
  });
  return { pts, lat0, lon0, cosLat };
}

/** 走った距離 d の位置 (前後の点で補間)。i0 から探す */
function at(pts: Local[], d: number, i0 = 0): { x: number; y: number; i: number } | null {
  if (d < 0 || d > pts[pts.length - 1].d) return null;
  let i = Math.max(1, i0);
  if (pts[i - 1].d > d) i = 1;
  while (i < pts.length - 1 && pts[i].d < d) i++;
  const a = pts[i - 1], b = pts[i];
  const t = b.d === a.d ? 0 : (d - a.d) / (b.d - a.d);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, i };
}

/** 走った距離 d での進む向き (前後 15 m の 2 点から、単位ベクトル) */
function dirAt(pts: Local[], d: number, i0 = 0): [number, number] | null {
  const a = at(pts, d - 15, i0), b = at(pts, d + 15, i0);
  if (!a || !b) return null;
  const n = Math.hypot(b.x - a.x, b.y - a.y);
  return n > 0 ? [(b.x - a.x) / n, (b.y - a.y) / n] : null;
}

/** 線の位置 (平面の点・向き) から、線の端の緯度経度を作る */
function gateAt(c: { x: number; y: number }, dir: [number, number], half: number, base: { lat0: number; lon0: number; cosLat: number }): Gate {
  const nx = -dir[1], ny = dir[0];
  const ll = (x: number, y: number) => ({ lat: base.lat0 + y / 111320, lon: base.lon0 + x / (111320 * base.cosLat) });
  const A = ll(c.x + nx * half, c.y + ny * half), B = ll(c.x - nx * half, c.y - ny * half);
  return { latA: A.lat, lonA: A.lon, latB: B.lat, lonB: B.lon };
}

/**
 * 線の半分の長さ: その位置から、コースのほかの部分 (向きが 30° より違う点。並行する逆向きの直線など) までの距離の 45%。
 * ほかの部分をまたいで数えないように
 */
function halfWidth(pts: Local[], c: { x: number; y: number }, dir: [number, number]): number {
  let m = Infinity;
  for (let i = 1; i < pts.length; i += 2) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    const n = Math.hypot(dx, dy);
    if (n === 0 || (dx * dir[0] + dy * dir[1]) / n > Math.cos((30 * Math.PI) / 180)) continue;
    m = Math.min(m, Math.hypot(pts[i].x - c.x, pts[i].y - c.y));
  }
  return Math.max(MIN_HALF_M, Math.min(MAX_HALF_M, 0.45 * m));
}

/**
 * 計測線を自動で置く。周回していないログ (同じ線を 3 回以上通らない) では undefined。
 * 返す線は、そのログで周回が区切れる (毎周通る) ことを確かめたもの
 */
export function createAutoControlLine(allPoints: TelemetryPoint[]): ControlLine | undefined {
  // 探すのは間引いた点で行う (約 8000 点。長いログでも 1 秒ほどで済むように)。線の位置の細かさは数 m 変わる程度
  const step = Math.max(1, Math.ceil(allPoints.length / 8000));
  const points = step === 1 ? allPoints : allPoints.filter((_, i) => i % step === 0);
  if (points.length < 50) return undefined;
  const base = toLocal(points);
  const { pts } = base;
  const fast = points.map(p => p.speed).filter(v => v >= MIN_SPEED_KMH).sort((a, b) => a - b);
  if (fast.length < 30) return undefined;
  const p90 = fast[Math.floor(fast.length * 0.9)];

  // 候補: 速く (90 パーセンタイルの 6 割より速く) 走っている、直線の部分の点。約 10 m ごと
  const cos = Math.cos((STRAIGHT_DEG * Math.PI) / 180);
  const candidates: { d: number; i: number; dir: [number, number]; straight: number }[] = [];
  let lastD = -Infinity;
  for (let i = 1; i < points.length; i++) {
    if (points[i].speed < Math.max(MIN_SPEED_KMH, 0.6 * p90) || pts[i].d - lastD < 10) continue;
    const dir = dirAt(pts, pts[i].d, i);
    if (!dir) continue;
    // 直線の長さ: 前と後ろに、向きが STRAIGHT_DEG 以内のまま続く距離 (短いほう)。最大 600 m
    const extent = (sign: number) => {
      let k = 0;
      for (let s = 10; s <= 600; s += 10) {
        const dd = dirAt(pts, pts[i].d + sign * s, i);
        if (!dd || dd[0] * dir[0] + dd[1] * dir[1] < cos) break;
        k = s;
      }
      return k;
    };
    const straight = Math.min(extent(1), extent(-1));
    if (straight < 40) continue;
    candidates.push({ d: pts[i].d, i, dir, straight });
    lastD = pts[i].d;
  }
  if (candidates.length === 0) return undefined;

  // 走り始めのゆっくり走った道 (ピットロード): 初めて 60 km/h より速い走りが 5 秒続くまでの、5〜60 km/h の点
  // (走り始めの周 (アウトラップ) をゆっくり走ることもあるので、コースに出るまでに限る)
  let racing = -1;
  for (let i = 0, since = -1; i < points.length; i++) {
    if (points[i].speed <= PIT_MAX_KMH) { since = -1; continue; }
    if (since < 0) since = i;
    if (points[i].time - points[since].time >= 5) { racing = since; break; }
  }
  // コースに出てからも、走り始めの周はゆっくり走ることがあるので、速く走る周 (60 km/h より速い点) の通った所から 8 m より離れた点だけを、
  // ピットロード (コースの外の道) とする。10 m の升目で近くを探す
  const cell = (x: number, y: number) => `${Math.floor(x / 10)},${Math.floor(y / 10)}`;
  const grid = new Map<string, Local[]>();
  for (let i = 0; i < pts.length; i++) {
    if (points[i].speed <= PIT_MAX_KMH) continue;
    const k = cell(pts[i].x, pts[i].y);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(pts[i]);
  }
  const onTrack = (q: Local) => {
    const cx = Math.floor(q.x / 10), cy = Math.floor(q.y / 10);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const r of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(r.x - q.x, r.y - q.y) <= 8) return true;
    }
    return false;
  };
  // ピットロードの点と、そこでの進む向き (同じ向きに並ぶ直線だけを、ピットロードの横の直線とみなす。逆向きに並ぶ別の直線を選ばないように)
  const pit: { x: number; y: number; dir: [number, number] }[] = [];
  for (let i = 0; i < Math.max(0, racing); i++) {
    if (points[i].speed < 5 || points[i].speed > PIT_MAX_KMH || onTrack(pts[i])) continue;
    const dir = dirAt(pts, pts[i].d, i);
    if (dir) pit.push({ x: pts[i].x, y: pts[i].y, dir });
  }
  const nearPit = (c: { i: number; dir: [number, number] }) =>
    pit.some(q => Math.hypot(q.x - pts[c.i].x, q.y - pts[c.i].y) <= 50 && q.dir[0] * c.dir[0] + q.dir[1] * c.dir[1] > 0.85);

  // ピットロードの横の直線を先に、同じなら直線の長い順に試し、毎周通る線を探す (候補が多いと時間がかかるので、上位の 150 個まで)
  for (const c of candidates) (c as { pitSide?: boolean }).pitSide = nearPit(c);
  candidates.sort((a, b) => Number((b as { pitSide?: boolean }).pitSide) - Number((a as { pitSide?: boolean }).pitSide) || b.straight - a.straight);
  const tried = candidates.slice(0, 150).map(c => {
    const center = at(pts, c.d, c.i)!;
    const gate = gateAt(center, c.dir, halfWidth(pts, center, c.dir), base);
    const n = findGateCrossings(points, gate, 15).filter(x => x.interpolatedPoint.speed >= 15).length;
    return { gate, n };
  });
  // 毎周通る線 (通る回数がいちばん多い線。走り始め・終わりの半端な周で 1 回少ないものまで)
  const nMax = Math.max(...tried.map(t => t.n));
  if (nMax < 3) return undefined;
  // 候補はピットロードの横の直線を先に、直線の長い順に並べてあるので、最初のものが、ピットロードの横のいちばん長い直線の真ん中
  // (ピットロードの真ん中に近い所を選ぶ方法も試したが、袖ヶ浦では公式の線から 40 m 離れ、直線の真ん中より悪かった)
  const best = tried.find(t => t.n >= nMax - 1)!;
  return { name: AUTO_CONTROL_LINE_NAME, ...best.gate };
}

/**
 * セクター線を自動で置く: 周 (startTime〜endTime) を距離で n 等分した所に、進む向きと直角な線を置く (最後の区切りは計測線なので置かない)
 */
export function createEqualSectors(points: TelemetryPoint[], lap: { startTime: number; endTime: number }, n = 3, idPrefix = 'auto'): Sector[] {
  const lapPoints = points.filter(p => p.time >= lap.startTime && p.time <= lap.endTime);
  if (lapPoints.length < 10) return [];
  const base = toLocal(lapPoints);
  const { pts } = base;
  const L = pts[pts.length - 1].d;
  const out: Sector[] = [];
  for (let k = 1; k < n; k++) {
    const d = (L * k) / n;
    const center = at(pts, d), dir = dirAt(pts, d);
    if (!center || !dir) return [];
    const g = gateAt(center, dir, halfWidth(pts, center, dir), base);
    out.push({ id: `${idPrefix}_s${k}`, name: `S${k}`, ...g });
  }
  return out;
}
