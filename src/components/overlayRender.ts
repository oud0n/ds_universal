/**
 * メーターの並び (overlayLayout.ts) を canvas に描く (PLAN-08)。画面の重ね表示・焼き込みの書き出し・メーターだけの書き出しで同じものを使う。
 *
 * 部品の四角は映像の割合から px にする。形の決まった部品 (速度・G・ラップの欄) は、描く単位で描いて四角に合わせて縮める。
 * 四角の寄せ方: 映像の下半分にある部品は下に、右半分にある部品は右に寄せる (縦横の比が違っても隅から離れない)
 */
import type { Lap, Session, TelemetryPoint } from '../types/telemetry';
import { CHANNELS, type ChannelId, type OverlayPart } from '../services/overlayLayout';
import { drawCourseMapAt, drawLapPanelAt, hasTimedLaps, LAP_PANEL_W, liveDelta } from './overlayParts';
import { getTileImage, tilesForView } from '../services/mapTiles';

export interface OverlayFrameInput {
  /** ログの時刻 (秒) */
  t: number;
  session: Session;
  /** 今見ている周 (グラフ画面で選んだ周など) */
  lap: Lap | null;
  /** 書き出す周 (前後を足して書き出すとき。周の前後でタイムを止める) */
  holdLap: Lap | null;
  /** 比べる周 (ラップの欄・タイム差・グラフとコース図の Car 2)。無ければそのログのベスト */
  reference: { lap: Lap; label: string } | null;
  /** よける四角 (PinP の小窓。px) */
  avoid?: { x: number; y: number; w: number; h: number } | null;
}

const PLATE = 'rgba(15, 20, 30, 0.85)';
const EDGE = '#2d3852';
const LABEL = '#94a3b8';
const VALUE = '#f8fafc';
const COMPARE_COLOR = '#f59e0b';
const SLOWER = '#f87171';
const FASTER = '#34d399';

function plate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 4): void {
  ctx.fillStyle = PLATE;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 時刻にいちばん近い点の番号 (二分探索。点が無ければ -1) */
function indexAt(pts: TelemetryPoint[], t: number): number {
  if (!pts.length) return -1;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time < t) lo = mid; else hi = mid;
  }
  return Math.abs(pts[lo].time - t) <= Math.abs(pts[hi].time - t) ? lo : hi;
}

/** 時刻にいちばん近い点 (二分探索) */
export function pointAt(pts: TelemetryPoint[], t: number): TelemetryPoint | null {
  const i = indexAt(pts, t);
  return i < 0 ? null : pts[i];
}

/** 周の中の距離 d (km) にいちばん近い点 */
function pointAtLapDistance(lap: Lap, d: number): TelemetryPoint | null {
  const pts = lap.points;
  if (!pts.length) return null;
  const base = pts[0].distance;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].distance - base < d) lo = mid; else hi = mid;
  }
  return Math.abs(pts[lo].distance - base - d) <= Math.abs(pts[hi].distance - base - d) ? pts[lo] : pts[hi];
}

/** 時刻 t を走っている周 (周の境目ちょうどは、あとの周。走行全体の周は最後) */
function lapAtTime(session: Session, t: number): Lap | null {
  return session.laps.filter(l => t >= l.startTime && t <= l.endTime)
    .sort((a, b) => Number(!!a.isWholeSession) - Number(!!b.isWholeSession) || b.startTime - a.startTime)[0] ?? null;
}

/** そのログのベストラップ (比べる周が無いときの基準) */
function bestLap(session: Session): Lap | null {
  const laps = session.laps.filter(l => !l.isWholeSession && !l.isPartialLap);
  return laps.reduce<Lap | null>((b, l) => (!b || l.lapTime < b.lapTime ? l : b), null);
}

/** 形の決まった部品を、四角に合わせて縮めて置く位置 (下半分なら下に、右半分なら右に寄せる) */
function fit(part: OverlayPart, rx: number, ry: number, rw: number, rh: number, baseW: number, baseH: number) {
  const s = Math.max(0.2, Math.min(rw / baseW, rh / baseH));
  const dw = baseW * s, dh = baseH * s;
  const x = part.x + part.w / 2 > 0.5 ? rx + rw - dw : rx;
  const y = part.y + part.h / 2 > 0.5 ? ry + rh - dh : ry;
  return { x, y, s };
}

function fmtMinSec(sec: number): string {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = (Math.max(0, sec) - m * 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}

function drawSpeed(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, pt: TelemetryPoint): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  plate(ctx, 0, 0, 160, 72);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${pt.speed.toFixed(0)}`, 14, 44);
  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = LABEL;
  ctx.fillText('km/h', 105, 42);
  const ratio = Math.min(1, pt.speed / 200);
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(14, 54, 132, 6);
  ctx.fillStyle = ratio > 0.8 ? '#ef4444' : ratio > 0.5 ? '#f59e0b' : '#3b82f6';
  ctx.fillRect(14, 54, 132 * ratio, 6);
  ctx.restore();
}

function drawG(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, pt: TelemetryPoint): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  plate(ctx, 0, 0, 96, 72);
  const cX = 48, cY = 34, r = 22;
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cX, cY, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cX, cY, r * 0.5, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#1e293b';
  ctx.beginPath();
  ctx.moveTo(cX - r, cY); ctx.lineTo(cX + r, cY);
  ctx.moveTo(cX, cY - r); ctx.lineTo(cX, cY + r);
  ctx.stroke();
  const k = r / 1.5;
  ctx.fillStyle = '#ef4444';
  ctx.beginPath(); ctx.arc(cX - (pt.corneringG || 0) * k, cY + (pt.accelG || 0) * k, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.font = 'bold 8px monospace';
  ctx.fillStyle = LABEL;
  ctx.textAlign = 'center';
  ctx.fillText(`${(pt.combinedG || 0).toFixed(2)}G`, cX, 66);
  ctx.restore();
}

/** ラップの欄の無いログ (計測線で区切れない) の、小さなラップタイムの箱 */
function drawLapClock(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, input: OverlayFrameInput): void {
  const { t, session, lap: baseLap, holdLap } = input;
  const current = lapAtTime(session, t);
  let label = current ? `Lap ${current.lapNumber}` : baseLap ? `Lap ${baseLap.lapNumber}` : 'Out / In Lap';
  let time = current ? t - current.startTime : baseLap ? t - baseLap.startTime : t;
  if (holdLap && t > holdLap.endTime) { label = `Lap ${holdLap.lapNumber}`; time = holdLap.lapTime; }
  else if (holdLap && !current && t < holdLap.startTime) { label = `Lap ${holdLap.lapNumber}`; time = 0; }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  plate(ctx, 0, 0, 150, 52);
  ctx.fillStyle = LABEL;
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, 12, 18);
  ctx.fillStyle = VALUE;
  ctx.font = 'bold 18px monospace';
  ctx.fillText(fmtMinSec(time), 12, 42);
  ctx.restore();
}

/** 値の棒 (縦・横)。最小が 0 より小さい値 (G など) は、0 から上下 (左右) に伸ばす */
function drawBar(ctx: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number, part: Extract<OverlayPart, { type: 'bar' }>, pt: TelemetryPoint): void {
  const ch = CHANNELS[part.channel];
  const v = ch.get(pt);
  const min = part.min ?? ch.min, max = part.max ?? ch.max;
  const color = part.color ?? '#38bdf8';
  plate(ctx, rx, ry, rw, rh);
  const label = part.label ?? ch.short;
  const fontPx = Math.max(8, Math.min(rw, rh) * (part.horizontal ? 0.34 : 0.32));
  const pad = Math.max(2, Math.min(rw, rh) * 0.12);
  ctx.font = `bold ${Math.round(fontPx * 0.8)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (part.horizontal) {
    const labelW = Math.min(rw * 0.3, fontPx * 2.8);
    const tx = rx + pad, ty = ry + pad, tw = rw - pad * 2 - labelW, th = rh - pad * 2;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(tx, ty, tw, th);
    if (typeof v === 'number' && Number.isFinite(v)) {
      const f = (x: number) => Math.max(0, Math.min(1, (x - min) / (max - min || 1)));
      const zero = min < 0 ? f(0) : 0;
      const at = f(v);
      ctx.fillStyle = color;
      ctx.fillRect(tx + tw * Math.min(zero, at), ty, tw * Math.abs(at - zero), th);
    }
    ctx.fillStyle = LABEL;
    ctx.fillText(label, rx + rw - pad - labelW / 2, ry + rh / 2);
    return;
  }
  const labelH = fontPx * 1.1;
  const tx = rx + pad, ty = ry + pad, tw = rw - pad * 2, th = rh - pad * 2 - labelH;
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(tx, ty, tw, th);
  if (typeof v === 'number' && Number.isFinite(v)) {
    const f = (x: number) => Math.max(0, Math.min(1, (x - min) / (max - min || 1)));
    const zero = min < 0 ? f(0) : 0;
    const at = f(v);
    ctx.fillStyle = color;
    const top = ty + th * (1 - Math.max(zero, at));
    ctx.fillRect(tx, top, tw, th * Math.abs(at - zero));
  }
  ctx.fillStyle = LABEL;
  ctx.fillText(label, rx + rw / 2, ry + rh - pad - labelH / 2);
}

/** ハンドル (角度で回した絵と、角度の数字)。+ は右に切った角度 */
function drawSteering(ctx: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number, part: Extract<OverlayPart, { type: 'steering' }>, pt: TelemetryPoint): void {
  plate(ctx, rx, ry, rw, rh);
  const deg = typeof pt.steering === 'number' && Number.isFinite(pt.steering) ? pt.steering : 0;
  const maxDeg = part.maxDeg ?? 540;
  const shown = Math.max(-maxDeg, Math.min(maxDeg, deg));
  const textH = Math.min(rh * 0.24, rw * 0.22);
  const pad = Math.max(2, rh * 0.06);
  const r = Math.max(4, Math.min(rw * 0.4, (rh - textH - pad * 2) * 0.45));
  const cx = rx + rw / 2, cy = ry + pad + (rh - textH - pad * 2) / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((shown * Math.PI) / 180);
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = Math.max(2, r * 0.18);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = Math.max(1.5, r * 0.13);
  ctx.beginPath();
  ctx.moveTo(-r, 0); ctx.lineTo(r, 0);
  ctx.moveTo(0, 0); ctx.lineTo(0, r);
  ctx.stroke();
  // 真上の印 (どれだけ回したか分かるように)
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = Math.max(2, r * 0.2);
  ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2 - 0.18, -Math.PI / 2 + 0.18); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = VALUE;
  ctx.font = `bold ${Math.round(Math.max(8, textH * 0.8))}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${deg > 0 ? 'R' : deg < 0 ? 'L' : ''}${Math.abs(deg).toFixed(0)}°`, cx, ry + rh - textH / 2 - 2);
}

/** 数字の欄 (札と値) */
function drawValue(ctx: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number, part: Extract<OverlayPart, { type: 'value' }>, pt: TelemetryPoint): void {
  const ch = CHANNELS[part.channel];
  const v = ch.get(pt);
  plate(ctx, rx, ry, rw, rh);
  const pad = Math.max(2, rh * 0.12);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = LABEL;
  ctx.font = `bold ${Math.round(Math.max(7, rh * 0.26))}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(part.label ?? ch.short, rx + pad, ry + rh * 0.28);
  ctx.fillStyle = VALUE;
  ctx.font = `bold ${Math.round(Math.max(9, rh * 0.5))}px monospace`;
  ctx.textAlign = 'right';
  const text = typeof v === 'number' && Number.isFinite(v)
    ? (part.channel === 'gear' ? (v < 0 ? 'R' : v === 0 ? 'N' : String(Math.round(v))) : v.toFixed(ch.decimals))
    : '--';
  ctx.fillText(text, rx + rw - pad, ry + rh * 0.66);
}

/** タイム差の棒 (比べる周より速いと左に緑、遅いと右に赤) */
function drawDelta(ctx: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number, part: Extract<OverlayPart, { type: 'delta' }>, input: OverlayFrameInput): void {
  plate(ctx, rx, ry, rw, rh);
  const lap = lapAtTime(input.session, input.t);
  const ref = input.reference?.lap ?? bestLap(input.session);
  const d = lap && ref && lap !== ref && !lap.isWholeSession ? liveDelta(lap, input.t, ref) : null;
  const pad = Math.max(2, rh * 0.15);
  const cx = rx + rw / 2;
  const barH = rh * 0.32;
  const by = ry + rh - pad - barH;
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(rx + pad, by, rw - pad * 2, barH);
  ctx.fillStyle = '#475569';
  ctx.fillRect(cx - 1, by - 2, 2, barH + 4);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(Math.max(8, rh * 0.36))}px monospace`;
  if (d === null) {
    ctx.fillStyle = LABEL;
    ctx.fillText('Δ --', cx, ry + pad + rh * 0.18);
    return;
  }
  const maxSec = part.maxSec ?? 1;
  const f = Math.max(-1, Math.min(1, d / maxSec));
  const half = rw / 2 - pad;
  ctx.fillStyle = d > 0 ? SLOWER : FASTER;
  ctx.fillRect(f > 0 ? cx : cx + half * f, by, half * Math.abs(f), barH);
  ctx.fillText(`Δ ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}`, cx, ry + pad + rh * 0.18);
}

/** グラフの帯の線の形 (周・値・大きさが同じなら作り直さない) */
const graphCache = new WeakMap<Lap, Map<string, Path2D>>();
const GRAPH_COLORS: Record<string, string> = { speed: '#38bdf8', throttle: '#22c55e', brake: '#ef4444', accelG: '#a78bfa', corneringG: '#f472b6', combinedG: '#facc15', steering: '#e2e8f0', rpm: '#fb923c', gear: '#94a3b8', altitude: '#94a3b8' };

function lapPath(lap: Lap, channel: ChannelId, x: number, y: number, w: number, h: number, span: number, min: number, max: number): Path2D {
  let m = graphCache.get(lap);
  if (!m) { m = new Map(); graphCache.set(lap, m); }
  const key = `${channel}:${Math.round(x)}:${Math.round(y)}:${Math.round(w)}:${Math.round(h)}:${span.toFixed(4)}:${min}:${max}`;
  const hit = m.get(key);
  if (hit) return hit;
  const ch = CHANNELS[channel];
  const pts = lap.points;
  const base = pts[0]?.distance ?? 0;
  const path = new Path2D();
  // 幅 1px に 1 点ほどに間引く
  const stride = Math.max(1, Math.floor(pts.length / Math.max(50, w)));
  let started = false;
  for (let i = 0; i < pts.length; i += stride) {
    const v = ch.get(pts[i]);
    if (typeof v !== 'number' || !Number.isFinite(v)) { started = false; continue; }
    const px = x + ((pts[i].distance - base) / span) * w;
    const py = y + h - ((Math.max(min, Math.min(max, v)) - min) / (max - min || 1)) * h;
    if (!started) { path.moveTo(px, py); started = true; } else path.lineTo(px, py);
  }
  if (m.size > 40) m.clear();
  m.set(key, path);
  return path;
}

/** グラフの帯: 周全体 (距離) か前後 N 秒 (時刻)。今の位置に縦の線。比べる周の線も重ねられる */
function drawGraph(ctx: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number, part: Extract<OverlayPart, { type: 'graph' }>, input: OverlayFrameInput, pt: TelemetryPoint): void {
  plate(ctx, rx, ry, rw, rh);
  const pad = Math.max(3, rh * 0.08);
  // 上の 1 行は値の名前と今の値 (線と重ねない)
  const labelPx = Math.round(Math.max(8, rh * 0.13));
  const gx = rx + pad, gy = ry + pad + labelPx * 1.3, gw = rw - pad * 2, gh = rh - pad * 2 - labelPx * 1.3;
  const lap = lapAtTime(input.session, input.t) ?? input.lap;
  const ref = part.compare ? (input.reference?.lap ?? bestLap(input.session)) : null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(gx, gy, gw, gh);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.2, rh / 70);
  const range = (c: ChannelId) => {
    const ch = CHANNELS[c];
    if (c !== 'speed' || !lap) return [ch.min, ch.max];
    // 速度は周の最高速に合わせる (200 km/h の目盛りだと、遅いコースで線が下に寄るため)
    const top = Math.max(lap.topSpeed || 0, ref?.topSpeed || 0, 40);
    return [0, Math.ceil((top * 1.08) / 10) * 10];
  };
  if (part.window === 'lap' || part.window === undefined) {
    if (lap && lap.points.length > 1) {
      const span = Math.max(1e-6, Math.max(lap.distance, ref && ref !== lap ? ref.distance : 0));
      for (const c of part.channels) {
        const [min, max] = range(c);
        if (ref && ref !== lap && ref.points.length > 1) {
          ctx.strokeStyle = COMPARE_COLOR;
          ctx.globalAlpha = 0.75;
          ctx.setLineDash([4, 3]);
          ctx.stroke(lapPath(ref, c, gx, gy, gw, gh, span, min, max));
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = GRAPH_COLORS[c] ?? '#38bdf8';
        ctx.stroke(lapPath(lap, c, gx, gy, gw, gh, span, min, max));
      }
      const cur = (pt.distance - lap.points[0].distance) / span;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(gx + gw * Math.max(0, Math.min(1, cur)) - 1, gy, 2, gh);
    }
  } else {
    // 前後 N 秒 (今の時刻が真ん中)
    const half = part.window / 2;
    const pts = input.session.points;
    for (const c of part.channels) {
      const [min, max] = range(c);
      const ch = CHANNELS[c];
      ctx.strokeStyle = GRAPH_COLORS[c] ?? '#38bdf8';
      ctx.beginPath();
      let started = false;
      let i = Math.max(0, indexAt(pts, input.t - half));
      for (; i < pts.length && pts[i].time <= input.t + half; i++) {
        const v = ch.get(pts[i]);
        if (typeof v !== 'number' || !Number.isFinite(v)) { started = false; continue; }
        const px = gx + ((pts[i].time - (input.t - half)) / (half * 2)) * gw;
        const py = gy + gh - ((Math.max(min, Math.min(max, v)) - min) / (max - min || 1)) * gh;
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(gx + gw / 2 - 1, gy, 2, gh);
  }
  ctx.restore();
  // 値の名前と今の値 (左上)
  ctx.font = `bold ${labelPx}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let lx = gx + 2;
  for (const c of part.channels) {
    const ch = CHANNELS[c];
    const v = ch.get(pt);
    const text = `${ch.short} ${typeof v === 'number' && Number.isFinite(v) ? v.toFixed(ch.decimals) : '--'}`;
    ctx.fillStyle = GRAPH_COLORS[c] ?? VALUE;
    ctx.fillText(text, lx, ry + pad);
    lx += ctx.measureText(text).width + 10;
  }
}

const M_PER_DEG = 111320;
/** コースの道幅の目安 (m。コースの形の線を、この太さの道として描く) */
const TRACK_WIDTH_M = 11;
/** 走った線を明るく描く、今から前の秒 */
const TRAIL_SEC = 6;

/**
 * 線 (経度・緯度の点の列) のうち、点 (x, y。m・東と北) にいちばん近いところへの、進む向きに対する横の距離 (m。右が +)。
 * 近くに線が無ければ null。heading は進む向き (度、北から右回り)
 */
function lateralOffset(lines: Array<Array<[number, number]>>, lat0: number, lon0: number, cosLat: number, heading: number): number | null {
  let best: { d: number; side: number } | null = null;
  const hx = Math.sin((heading * Math.PI) / 180), hy = Math.cos((heading * Math.PI) / 180);
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][0] - lon0) * cosLat * M_PER_DEG, ay = (line[i - 1][1] - lat0) * M_PER_DEG;
      const bx = (line[i][0] - lon0) * cosLat * M_PER_DEG, by = (line[i][1] - lat0) * M_PER_DEG;
      // 遠い線は見ない (60 m より遠い線分)
      if (Math.min(Math.abs(ax), Math.abs(bx)) > 60 || Math.min(Math.abs(ay), Math.abs(by)) > 60) continue;
      const sx = bx - ax, sy = by - ay;
      const len2 = sx * sx + sy * sy;
      if (len2 < 1e-6) continue;
      const f = Math.max(0, Math.min(1, -(ax * sx + ay * sy) / len2));
      const px = ax + sx * f, py = ay + sy * f;
      const d = Math.hypot(px, py);
      if (best && d >= best.d) continue;
      // 線の向きを進む向きにそろえ、点が線のどちら側か (右が +)
      const dir = sx * hx + sy * hy >= 0 ? 1 : -1;
      const cross = (sx * dir) * (0 - py) - (sy * dir) * (0 - px);
      best = { d, side: cross < 0 ? 1 : -1 };
    }
  }
  return best && best.d < 30 ? best.d * best.side : null;
}

/**
 * 車のまわりを拡大した地図: 航空写真 (読めたら)・コースの形 (道幅の帯)・比べる周の線・この周の線 (今から前 TRAIL_SEC 秒は明るく)・車。
 * 進む向きを上にすると、地図の左右が車の左右と同じになる。下に、コースの真ん中 (無ければ比べる周の線) からの左右の距離
 */
function drawZoomMap(ctx: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number, part: Extract<OverlayPart, { type: 'zoomMap' }>, input: OverlayFrameInput, pt: TelemetryPoint): void {
  plate(ctx, rx, ry, rw, rh);
  const spanM = part.spanM ?? 140;
  const mpp = spanM / Math.max(1, rw);
  const lat0 = pt.latitude, lon0 = pt.longitude;
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) return;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const toLocal = (lat: number, lon: number): [number, number] => [((lon - lon0) * cosLat * M_PER_DEG) / mpp, (-(lat - lat0) * M_PER_DEG) / mpp];
  const heading = Number.isFinite(pt.heading) ? pt.heading : 0;
  const textH = Math.max(10, Math.min(rh * 0.14, 18));
  const cx = rx + rw / 2, cy = ry + (rh - textH) * 0.62;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(rx + 1, ry + 1, rw - 2, rh - textH - 2, 3);
  ctx.clip();
  ctx.translate(cx, cy);
  if (part.headingUp !== false) ctx.rotate((-heading * Math.PI) / 180);
  // 0. 航空写真 (読めたタイルだけ。まだのものは次のコマで)
  const radiusM = (Math.hypot(rw, rh) / 2) * mpp;
  let drewPhoto = false;
  if (part.photo !== false) {
    const dLat = radiusM / M_PER_DEG, dLon = radiusM / (M_PER_DEG * cosLat);
    const tiles = tilesForView('photo', { north: lat0 + dLat, south: lat0 - dLat, west: lon0 - dLon, east: lon0 + dLon }, mpp);
    ctx.globalAlpha = 0.85;
    for (const tile of tiles) {
      const img = getTileImage(tile, () => {});
      if (!img) continue;
      const [x1, y1] = toLocal(tile.north, tile.west);
      const [x2, y2] = toLocal(tile.south, tile.east);
      ctx.drawImage(img, x1, y1, x2 - x1 + 0.5, y2 - y1 + 0.5);
      drewPhoto = true;
    }
    ctx.globalAlpha = 1;
  }
  const lines = input.session.pathPolylines ?? [];
  // 1. コースの形 (航空写真が無いときは道幅の帯、あるときは真ん中の細い線)
  const strokeLine = (line: Array<[number, number]>) => {
    ctx.beginPath();
    line.forEach(([lon, lat], i) => { const [x, y] = toLocal(lat, lon); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const line of lines) {
    if (line.length < 2) continue;
    if (!drewPhoto) {
      ctx.strokeStyle = 'rgba(100, 116, 139, 0.55)';
      ctx.lineWidth = TRACK_WIDTH_M / mpp;
      strokeLine(line);
    }
    ctx.strokeStyle = drewPhoto ? 'rgba(255, 255, 255, 0.35)' : 'rgba(148, 163, 184, 0.6)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    strokeLine(line);
    ctx.setLineDash([]);
  }
  // 2. 比べる周の線
  const lap = lapAtTime(input.session, input.t);
  const ref = part.compare ? (input.reference?.lap ?? bestLap(input.session)) : null;
  const near = (p: TelemetryPoint) => Math.abs(p.latitude - lat0) * M_PER_DEG < radiusM * 1.2 && Math.abs(p.longitude - lon0) * cosLat * M_PER_DEG < radiusM * 1.2;
  const drawPoints = (pts: TelemetryPoint[], from: number, to: number) => {
    ctx.beginPath();
    let started = false;
    for (let i = from; i <= to && i < pts.length; i++) {
      if (!near(pts[i])) { started = false; continue; }
      const [x, y] = toLocal(pts[i].latitude, pts[i].longitude);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  if (ref && ref !== lap && ref.points.length > 1) {
    ctx.strokeStyle = COMPARE_COLOR;
    ctx.lineWidth = Math.max(1.5, 1.2 / mpp);
    ctx.setLineDash([5, 4]);
    drawPoints(ref.points, 0, ref.points.length - 1);
    ctx.setLineDash([]);
  }
  // 3. この周の線 (うすく) と、今から前 TRAIL_SEC 秒 (明るく)
  const pts = input.session.points;
  const nowIdx = indexAt(pts, input.t);
  if (nowIdx > 0) {
    const lapStart = lap && !lap.isWholeSession ? indexAt(pts, lap.startTime) : Math.max(0, nowIdx - 2000);
    const lapEnd = lap && !lap.isWholeSession ? indexAt(pts, lap.endTime) : Math.min(pts.length - 1, nowIdx + 2000);
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.35)';
    ctx.lineWidth = Math.max(1, 0.8 / mpp);
    drawPoints(pts, Math.max(0, lapStart), lapEnd);
    let trailFrom = nowIdx;
    while (trailFrom > 0 && pts[trailFrom - 1].time >= input.t - TRAIL_SEC) trailFrom--;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = Math.max(2, 1.6 / mpp);
    drawPoints(pts, trailFrom, nowIdx);
  }
  // 4. 車 (進む向きの三角)
  ctx.rotate((heading * Math.PI) / 180);
  const carL = Math.max(8, 4.5 / mpp);
  ctx.fillStyle = '#ef4444';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -carL * 0.6);
  ctx.lineTo(carL * 0.35, carL * 0.4);
  ctx.lineTo(-carL * 0.35, carL * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  // 5. 左右の距離: コースの真ん中から (C) と、比べる周の線から (REF)。右が R
  const center = lines.length ? lateralOffset(lines, lat0, lon0, cosLat, heading) : null;
  const fromRef = ref && ref !== lap && ref.points.length > 1
    ? lateralOffset([ref.points.map(p => [p.longitude, p.latitude] as [number, number])], lat0, lon0, cosLat, heading)
    : null;
  const fmt = (v: number) => `${v >= 0 ? 'R' : 'L'}${Math.abs(v).toFixed(1)}m`;
  const texts = [center !== null ? `C ${fmt(center)}` : null, fromRef !== null ? `REF ${fmt(fromRef)}` : null].filter(Boolean) as string[];
  ctx.font = `bold ${Math.round(textH * 0.7)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = texts.length ? VALUE : LABEL;
  ctx.fillText(texts.length ? texts.join('   ') : '--', rx + rw / 2, ry + rh - textH / 2 - 1);
}

/** 部品の四角 (px)。PinP の小窓に重なるときは、小窓の横へずらす */
export function partRect(part: OverlayPart, w: number, h: number, avoid?: OverlayFrameInput['avoid']): { x: number; y: number; w: number; h: number } {
  let x = part.x * w, y = part.y * h;
  const rw = part.w * w, rh = part.h * h;
  if (avoid && x < avoid.x + avoid.w && x + rw > avoid.x && y < avoid.y + avoid.h && y + rh > avoid.y) {
    const toLeft = x + rw / 2 < avoid.x + avoid.w / 2;
    x = toLeft ? avoid.x - rw - 8 : avoid.x + avoid.w + 8;
    x = Math.max(4, Math.min(w - rw - 4, x));
  }
  return { x, y, w: rw, h: rh };
}

/** 並びの部品を描く */
export function renderOverlayParts(ctx: CanvasRenderingContext2D, w: number, h: number, input: OverlayFrameInput, parts: OverlayPart[]): void {
  const pt = pointAt(input.session.points, input.t);
  if (!pt) return;
  for (const part of parts) {
    const r = partRect(part, w, h, input.avoid);
    ctx.save();
    ctx.globalAlpha = part.opacity ?? 1;
    switch (part.type) {
      case 'speed': { const f = fit(part, r.x, r.y, r.w, r.h, 160, 72); drawSpeed(ctx, f.x, f.y, f.s, pt); break; }
      case 'gmeter': { const f = fit(part, r.x, r.y, r.w, r.h, 96, 72); drawG(ctx, f.x, f.y, f.s, pt); break; }
      case 'lapPanel': {
        if (hasTimedLaps(input.session)) {
          const s = Math.max(0.2, r.w / LAP_PANEL_W);
          const x = part.x + part.w / 2 > 0.5 ? r.x + r.w - LAP_PANEL_W * s : r.x;
          ctx.translate(x, r.y);
          ctx.scale(s, s);
          drawLapPanelAt(ctx, 0, 0, input.t, input.session, input.holdLap, input.reference);
        } else {
          const f = fit(part, r.x, r.y, r.w, Math.min(r.h, r.w * (52 / 150)), 150, 52);
          drawLapClock(ctx, f.x, f.y, f.s, input);
        }
        break;
      }
      case 'lapClock': {
        const f = fit(part, r.x, r.y, r.w, Math.min(r.h, r.w * (52 / 150)), 150, 52);
        drawLapClock(ctx, f.x, f.y, f.s, input);
        break;
      }
      case 'map': {
        const size = Math.min(r.w, r.h);
        const x = part.x + part.w / 2 > 0.5 ? r.x + r.w - size : r.x;
        const y = part.y + part.h / 2 > 0.5 ? r.y + r.h - size : r.y;
        const others: Array<{ point: TelemetryPoint; color: string }> = [];
        if (part.compare) {
          const lap = lapAtTime(input.session, input.t);
          const ref = input.reference?.lap ?? bestLap(input.session);
          if (lap && ref && ref !== lap && !lap.isWholeSession && lap.points.length) {
            const p2 = pointAtLapDistance(ref, pt.distance - lap.points[0].distance);
            if (p2) others.push({ point: p2, color: COMPARE_COLOR });
          }
        }
        drawCourseMapAt(ctx, x, y, size, input.t, input.session, pt, others);
        break;
      }
      case 'zoomMap': drawZoomMap(ctx, r.x, r.y, r.w, r.h, part, input, pt); break;
      case 'bar': drawBar(ctx, r.x, r.y, r.w, r.h, part, pt); break;
      case 'steering': drawSteering(ctx, r.x, r.y, r.w, r.h, part, pt); break;
      case 'value': drawValue(ctx, r.x, r.y, r.w, r.h, part, pt); break;
      case 'delta': drawDelta(ctx, r.x, r.y, r.w, r.h, part, input); break;
      case 'graph': drawGraph(ctx, r.x, r.y, r.w, r.h, part, input, pt); break;
    }
    ctx.restore();
  }
}
