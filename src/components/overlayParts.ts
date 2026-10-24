/**
 * 動画に重ねる部品のうち、2026-10-20 に足したもの (docs/overlay_parts_design.md)。
 * - ラップの欄 (9 の案): Best・Lap・S1〜・タイム差 (PLAN-15)
 * - コース図 (2.5): 基準の周の軌跡と、今の位置の点
 * 画面の重ね表示・焼き込みの書き出し・メーターだけの書き出しは、同じ関数で描く (4)。
 * 部品の位置は今は決まった隅 (ラップの欄は右上、コース図は左上)。動かす・消す仕組みは 10 を参照
 */

import type { Lap, Session, TelemetryPoint } from '../types/telemetry';

/** 出す部品 (ウインドウごとに覚える) */
export interface OverlayPartsOptions {
  /** ラップの欄 (Best・Lap・セクター・タイム差) */
  lapPanel: boolean;
  /** コース図 */
  map: boolean;
  /** ラップの欄で比べる周 (Car で選んだ周など)。ないときは、そのログのベストラップ */
  reference?: { lap: Lap; label: string } | null;
}

/** 周を終えたあと、その周のタイムと差を止めて出しておく秒 (9 の案) */
const LAP_HOLD_SEC = 3;

const COLOR_PLATE = 'rgba(15, 20, 30, 0.85)';
const COLOR_EDGE = '#2d3852';
const COLOR_LABEL = '#94a3b8';
const COLOR_VALUE = '#f8fafc';
const COLOR_SLOWER = '#f87171';
const COLOR_FASTER = '#34d399';

/** 1'05.746 の形 (9 の案) */
function lapClock(sec: number): string {
  if (!Number.isFinite(sec)) return "-'--.---";
  const a = Math.max(0, sec);
  const m = Math.floor(a / 60);
  const s = (a - m * 60).toFixed(3).padStart(6, '0');
  return s.startsWith('60') ? `${m + 1}'00.000` : `${m}'${s}`;
}

function signed(sec: number): string {
  return `${sec >= 0 ? '+' : '−'}${Math.abs(sec).toFixed(3)}`;
}

function diffColor(d: number): string {
  if (d > 0.0005) return COLOR_SLOWER;
  if (d < -0.0005) return COLOR_FASTER;
  return COLOR_VALUE;
}

function plate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = COLOR_PLATE;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.fill();
  ctx.strokeStyle = COLOR_EDGE;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 点の列で、ある値 (時刻・距離) のところを二分探索して前後の点の間を補間する */
function interpAt(pts: TelemetryPoint[], key: 'time' | 'distance', v: number, out: 'time' | 'distance'): number {
  if (pts.length === 0) return NaN;
  if (v <= pts[0][key]) return pts[0][out];
  const last = pts[pts.length - 1];
  if (v >= last[key]) return last[out];
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][key] <= v) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const f = b[key] > a[key] ? (v - a[key]) / (b[key] - a[key]) : 0;
  return a[out] + f * (b[out] - a[out]);
}

/** ラップの欄を出せるか (計測線で区切った周があるか)。ないログ (ヒルクライムなど) は、これまでの小さなラップタイムの箱にする */
export function hasTimedLaps(session: Session): boolean {
  return session.laps.some(l => !l.isWholeSession);
}

/** その時刻を走っている周 (周の境目ちょうどは、あとの周) */
function lapAt(session: Session, t: number): Lap | undefined {
  const laps = session.laps.filter(l => !l.isWholeSession && t >= l.startTime && t <= l.endTime);
  return laps.length > 1 ? laps.reduce((a, b) => (b.startTime > a.startTime ? b : a)) : laps[0];
}

/** 基準の周 (そのログのベストラップ) */
function referenceLap(session: Session): Lap | undefined {
  const best = session.laps[session.bestLapIndex];
  return best && !best.isWholeSession && !best.isPartialLap ? best : undefined;
}

/**
 * 基準の周との今の差 (秒。正なら遅い)。同じ距離を走ったときの経過時間で比べる (解析画面のタイム差と同じ考え)
 */
export function liveDelta(lap: Lap, t: number, ref: Lap): number | null {
  if (lap.points.length < 2 || ref.points.length < 2) return null;
  // 周の点は、周の始めを 0 とした時刻と距離 (extractLaps)
  const elapsed = t - lap.startTime;
  const lapDist = interpAt(lap.points, 'time', elapsed, 'distance');
  const refTotal = ref.points[ref.points.length - 1].distance;
  if (!(lapDist >= 0)) return null;
  // 長さが 10% より違う周 (別のコース) とは比べない
  const lapTotal = lap.points[lap.points.length - 1].distance;
  if (refTotal > 0 && Math.abs(lapTotal - refTotal) > refTotal * 0.1) return null;
  // 基準の周より長く走ったときは、基準の周の終わりと比べる
  const refElapsed = lapDist >= refTotal ? ref.lapTime : interpAt(ref.points, 'distance', lapDist, 'time');
  return elapsed - refElapsed;
}

/**
 * ラップの欄 (右上)。
 * Best (基準の周のタイム) / Lap (今の周の経過) / S1〜 (終わったセクターはタイムと基準との差、今のセクターは数えていく、まだのものは「...」) / Δ (今の差)
 * 周を終えたあと LAP_HOLD_SEC 秒は、終えた周のタイムと差を止めて出す。holdLap (前後を足した書き出しの周) は、周のあとずっと止める
 */
export function drawLapPanel(
  ctx: CanvasRenderingContext2D,
  w: number,
  t: number,
  session: Session,
  holdLap: Lap | null,
  /** 右の端からの距離 (PinP の小窓をよけるとき大きくする) */
  rightInset = 24,
  /** 比べる周 (Car で選んだ周など)。ないときは、そのログのベストラップ */
  reference: { lap: Lap; label: string } | null = null
): void {
  const ref = reference?.lap ?? referenceLap(session);
  const refLabel = reference?.label ?? 'Best';
  let lap = lapAt(session, t);
  let frozen = false;
  // 周に入る前 (前後を足した書き出しで、前の周がないとき): 0 で待つ。差は出さない
  let waiting = false;
  if (holdLap && t > holdLap.endTime) {
    lap = holdLap;
    frozen = true;
  } else if (lap) {
    // 周に入ったばかりなら、前の周のタイムを止めて出す
    const prev = session.laps.find(l => !l.isWholeSession && Math.abs(l.endTime - lap!.startTime) < 0.05);
    if (prev && t - lap.startTime < LAP_HOLD_SEC) {
      lap = prev;
      frozen = true;
    }
  } else if (holdLap && t < holdLap.startTime) {
    lap = holdLap;
    waiting = true;
  } else {
    // 最後の周を終えた直後も、その周のタイムを止めて出す
    const ended = session.laps.find(l => !l.isWholeSession && t > l.endTime && t - l.endTime < LAP_HOLD_SEC);
    if (ended) {
      lap = ended;
      frozen = true;
    }
  }
  const sectors = lap?.sectors ?? [];
  const rows = 2 + sectors.length + (ref && lap && !frozen && !waiting ? 1 : 0);
  const rowH = 22;
  const boxW = 236;
  const boxH = 14 + rows * rowH;
  const x = w - boxW - rightInset;
  const y = 24;
  ctx.save();
  plate(ctx, x, y, boxW, boxH);
  ctx.textBaseline = 'middle';
  const row = (i: number) => y + 7 + rowH * i + rowH / 2;
  const label = (i: number, text: string) => {
    ctx.fillStyle = COLOR_LABEL;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 12, row(i));
  };
  // 値は、見出し (Lap 11・Best など) と重ならない所から書く (2 桁の周で「Lap 110'15.971」と読めていた)
  const value = (i: number, text: string, color = COLOR_VALUE, xOff = 66) => {
    ctx.fillStyle = color;
    ctx.font = 'bold 15px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + xOff, row(i));
  };
  const diff = (i: number, d: number) => {
    ctx.fillStyle = diffColor(d);
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`(${signed(d)})`, x + boxW - 10, row(i));
  };

  label(0, refLabel);
  value(0, ref ? lapClock(ref.lapTime) : "-'--.---");

  const elapsed = lap ? (frozen ? lap.lapTime : Math.max(0, t - lap.startTime)) : NaN;
  label(1, lap ? `Lap ${lap.lapNumber}` : 'Lap');
  value(1, lap ? lapClock(elapsed) : "-'--.---");
  if (frozen && lap && ref && lap !== ref) diff(1, lap.lapTime - ref.lapTime);

  sectors.forEach((s, i) => {
    const r = 2 + i;
    label(r, `S${i + 1}`);
    const start = i > 0 ? sectors[i - 1].splitTime : 0;
    if (elapsed >= s.splitTime) {
      value(r, lapClock(s.time));
      // セクターの数が違う周 (別のコース・セクター線の違うログ) とは、セクターを比べない
      const refSector = ref && ref.sectors.length === sectors.length ? ref.sectors[i] : undefined;
      if (refSector && lap !== ref) diff(r, s.time - refSector.time);
    } else if (elapsed >= start) {
      value(r, lapClock(elapsed - start));
    } else {
      value(r, '...', COLOR_LABEL);
    }
  });

  if (ref && lap && !frozen && !waiting) {
    const r = 2 + sectors.length;
    // 比べる周そのものを走っているときは、差を出さない (セクター・周のタイムと同じ)
    const d = lap === ref ? null : liveDelta(lap, t, ref);
    label(r, 'Δ');
    if (d !== null) value(r, signed(d), diffColor(d));
  }
  ctx.restore();
}

/** 周の点を、コース図の四角に収める変換 (周ごとに 1 回だけ作る) */
const mapCache = new WeakMap<TelemetryPoint[], { minX: number; minY: number; scale: number; spanX: number; spanY: number; cosLat: number; path: Array<[number, number]>; paths: Map<string, Path2D> }>();

function mapOf(points: TelemetryPoint[]) {
  let m = mapCache.get(points);
  if (m) return m;
  const cosLat = Math.cos(((points[0]?.latitude ?? 0) * Math.PI) / 180);
  const xs = points.map(p => p.longitude * cosLat);
  const ys = points.map(p => -p.latitude);
  // 点が多いログ (60 Hz 以上・長い走行) でも落ちないよう、Math.min(...xs) は使わない
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);
  // 描く点は 400 ほどに間引く
  const stride = Math.max(1, Math.floor(points.length / 400));
  const path: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i += stride) path.push([xs[i], ys[i]]);
  path.push([xs[xs.length - 1], ys[ys.length - 1]]);
  m = { minX, minY, scale: 1, spanX, spanY, cosLat, path, paths: new Map() };
  mapCache.set(points, m);
  return m;
}

/** コース図に使う周 (ログごとに 1 回だけ選ぶ) */
const mapLapCache = new WeakMap<Session, Lap | null>();

/**
 * コース図に使う周: 計測線から計測線まで走った周のうち、GPS が途切れていない (点の間が 30 m 以内) で、
 * 長さがふつうの周 (周の長さの中央値の ±5%。ピットを通った周・ショートカットを除く) の中でいちばん速いもの。
 * GPS の軌跡をそのまま使うと、ピットアウトの周や途切れた周でコース図が崩れるため
 */
export function mapLap(session: Session): Lap | null {
  if (mapLapCache.has(session)) return mapLapCache.get(session)!;
  const full = session.laps.filter(l => !l.isWholeSession && !l.isPartialLap && l.points.length >= 10);
  const dists = full.map(l => l.distance).sort((a, b) => a - b);
  const median = dists[Math.floor((dists.length - 1) / 2)] ?? 0;
  const clean = full.filter(l => {
    if (median > 0 && Math.abs(l.distance - median) > median * 0.05) return false;
    const cosLat = Math.cos((l.points[0].latitude * Math.PI) / 180);
    for (let i = 1; i < l.points.length; i++) {
      const a = l.points[i - 1];
      const b = l.points[i];
      const m = Math.hypot((b.latitude - a.latitude) * 111320, (b.longitude - a.longitude) * 111320 * cosLat);
      if (m > 30) return false;
    }
    return true;
  });
  // 計測線で区切れないログ (ヒルクライムなど) は、走行全体の軌跡
  const whole = session.laps.find(l => l.isWholeSession && l.points.length >= 10) ?? null;
  const pick = (clean.length ? clean : full).reduce<Lap | null>((best, l) => (!best || l.lapTime < best.lapTime ? l : best), null) ?? whole;
  mapLapCache.set(session, pick);
  return pick;
}

/** コース図 (左上)。きれいに走れた周の軌跡と、今の位置の点 */
export function drawCourseMap(ctx: CanvasRenderingContext2D, h: number, t: number, session: Session, current: TelemetryPoint | null, leftInset = 24): void {
  const lap = mapLap(session) ?? lapAt(session, t);
  if (!lap || lap.points.length < 10) return;
  const m = mapOf(lap.points);
  const size = Math.round(Math.min(220, h * 0.3));
  const pad = 12;
  const x0 = leftInset;
  const y0 = 24;
  const inner = size - pad * 2;
  const scale = inner / Math.max(m.spanX, m.spanY);
  const offX = x0 + pad + (inner - m.spanX * scale) / 2;
  const offY = y0 + pad + (inner - m.spanY * scale) / 2;
  const toScreen = (px: number, py: number): [number, number] => [offX + (px - m.minX) * scale, offY + (py - m.minY) * scale];
  ctx.save();
  plate(ctx, x0, y0, size, size);
  // 今の位置がコース図の外 (ピット・コースの外) でも、箱の外に描かない
  ctx.beginPath();
  ctx.rect(x0, y0, size, size);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // 軌跡の線は、同じ大きさ・位置なら作り直さない (コマごとに 400 点を変換しない)
  const key = `${size}:${x0}:${y0}`;
  let path = m.paths.get(key);
  if (!path) {
    path = new Path2D();
    m.path.forEach(([px, py], i) => {
      const [sx, sy] = toScreen(px, py);
      if (i === 0) path!.moveTo(sx, sy);
      else path!.lineTo(sx, sy);
    });
    m.paths.set(key, path);
  }
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.75)';
  ctx.lineWidth = 3;
  ctx.stroke(path);
  if (current) {
    const [cx, cy] = toScreen(current.longitude * m.cosLat, -current.latitude);
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
  ctx.restore();
}
