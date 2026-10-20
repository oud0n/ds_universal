/**
 * X/Y グラフ (2026-10-20)。好きな 2 つの値 (速度と横 G など) を、選んだ周ごとに点で重ねる。
 * 今いる場所 (再生の位置) の点は大きく出す
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { canvasColors, useResolvedTheme } from '../utils/theme';
import { useLang, useT } from '../utils/i18n';
import type { Lap, SelectedCarSlot, TelemetryPoint } from '../types/telemetry';
import { niceStep, valueRange } from '../utils/chartScale';

interface Props {
  cars: { slot: SelectedCarSlot; lap: Lap }[];
  currentDistance: number;
}

/** 選べる値 (ログにある値と、アプリが求めた値) */
export const XY_CHANNELS = [
  { key: 'speed', ja: '速度 (km/h)', en: 'Speed (km/h)', get: (p: TelemetryPoint) => p.speed },
  { key: 'accelG', ja: '加減速 G', en: 'Long. G', get: (p: TelemetryPoint) => p.accelG },
  { key: 'corneringG', ja: '横 G', en: 'Lat. G', get: (p: TelemetryPoint) => p.corneringG },
  { key: 'combinedG', ja: '合算 G', en: 'Combined G', get: (p: TelemetryPoint) => p.combinedG },
  { key: 'turningRadius', ja: '旋回半径 (m)', en: 'Turn radius (m)', get: (p: TelemetryPoint) => (p.turningRadius >= 9999 ? NaN : p.turningRadius) },
  { key: 'altitude', ja: '標高 (m)', en: 'Altitude (m)', get: (p: TelemetryPoint) => (p.altitudeMissing ? NaN : p.altitude) },
  { key: 'distance', ja: '距離 (km)', en: 'Distance (km)', get: (p: TelemetryPoint) => p.distance },
  { key: 'time', ja: '時間 (秒)', en: 'Time (s)', get: (p: TelemetryPoint) => p.time }
] as const;
export type XYChannel = (typeof XY_CHANNELS)[number]['key'];

const STORE_KEY = 'ds_xy_channels';
function loadChannels(): [XYChannel, XYChannel] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    const ok = (k: unknown) => XY_CHANNELS.some(c => c.key === k);
    if (Array.isArray(v) && ok(v[0]) && ok(v[1])) return [v[0], v[1]];
  } catch { /* 覚えていなければ既定 */ }
  return ['speed', 'corneringG'];
}

export const XYGraphWindow: React.FC<Props> = ({ cars, currentDistance }) => {
  const t = useT();
  const lang = useLang();
  const theme = useResolvedTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [[xKey, yKey], setKeys] = useState<[XYChannel, XYChannel]>(loadChannels);
  const [resizeTick, setResizeTick] = useState(0);

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([xKey, yKey])); } catch { /* 覚えられなくてもよい */ }
  }, [xKey, yKey]);

  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setResizeTick(n => n + 1));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const xc = XY_CHANNELS.find(c => c.key === xKey)!;
  const yc = XY_CHANNELS.find(c => c.key === yKey)!;

  // 周ごとの点 (値の無い点は除く)
  const series = useMemo(() => cars.map(({ slot, lap }) => {
    const xs: number[] = [];
    const ys: number[] = [];
    const ds: number[] = [];
    for (const p of lap.points) {
      const x = xc.get(p);
      const y = yc.get(p);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      xs.push(x);
      ys.push(y);
      ds.push(p.distance);
    }
    return { color: slot.colorHex, xs, ys, ds };
  }), [cars, xc, yc]);

  const ranges = useMemo(() => ({
    x: valueRange(series.flatMap(s => s.xs)),
    y: valueRange(series.flatMap(s => s.ys))
  }), [series]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !parent || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = canvasColors();
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);
    const left = 44, right = 10, top = 8, bottom = 26;
    const pw = w - left - right;
    const ph = h - top - bottom;
    if (pw < 20 || ph < 20) return;
    const [x0, x1] = ranges.x;
    const [y0, y1] = ranges.y;
    const sx = (v: number) => left + ((v - x0) / (x1 - x0)) * pw;
    const sy = (v: number) => top + ph - ((v - y0) / (y1 - y0)) * ph;

    // 目盛り
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = c.label;
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    const fmt = (v: number, step: number) => (step >= 1 ? v.toFixed(0) : v.toFixed(Math.min(3, Math.ceil(-Math.log10(step)))));
    const stepX = niceStep(x1 - x0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let v = Math.ceil(x0 / stepX) * stepX; v <= x1; v += stepX) {
      const x = sx(v);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke();
      ctx.fillText(fmt(v, stepX), x, top + ph + 4);
    }
    const stepY = niceStep(y1 - y0);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(y0 / stepY) * stepY; v <= y1; v += stepY) {
      const y = sy(v);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + pw, y); ctx.stroke();
      ctx.fillText(fmt(v, stepY), left - 4, y);
    }
    // 0 の線は濃く
    ctx.strokeStyle = c.gridStrong;
    if (x0 < 0 && x1 > 0) { ctx.beginPath(); ctx.moveTo(sx(0), top); ctx.lineTo(sx(0), top + ph); ctx.stroke(); }
    if (y0 < 0 && y1 > 0) { ctx.beginPath(); ctx.moveTo(left, sy(0)); ctx.lineTo(left + pw, sy(0)); ctx.stroke(); }

    // 点 (基準車を最後に描いて上に出す)
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, pw, ph); ctx.clip();
    [...series].reverse().forEach(s => {
      ctx.fillStyle = s.color;
      ctx.globalAlpha = 0.35;
      for (let i = 0; i < s.xs.length; i++) ctx.fillRect(sx(s.xs[i]) - 1, sy(s.ys[i]) - 1, 2, 2);
    });
    // 今いる場所
    ctx.globalAlpha = 1;
    series.forEach(s => {
      if (s.ds.length === 0) return;
      let best = 0;
      for (let i = 1; i < s.ds.length; i++) if (Math.abs(s.ds[i] - currentDistance) < Math.abs(s.ds[best] - currentDistance)) best = i;
      ctx.fillStyle = s.color;
      ctx.strokeStyle = c.strong;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx(s.xs[best]), sy(s.ys[best]), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    ctx.restore();
  }, [series, ranges, currentDistance, theme, lang, resizeTick]);

  const select = (axis: 'x' | 'y', value: XYChannel) => setKeys(([x, y]) => (axis === 'x' ? [value, y] : [x, value]));
  const selectCls = 'bg-surface-0 border border-line-3 rounded px-1.5 py-0.5 text-[11px] text-slate-200';

  return (
    <div className="h-full flex flex-col" data-testid="xy-graph">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-[11px] text-slate-400">
        <label className="flex items-center gap-1">{t('横', 'X')}
          <select value={xKey} onChange={e => select('x', e.target.value as XYChannel)} className={selectCls} data-testid="xy-x">
            {XY_CHANNELS.map(ch => <option key={ch.key} value={ch.key}>{t(ch.ja, ch.en)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">{t('縦', 'Y')}
          <select value={yKey} onChange={e => select('y', e.target.value as XYChannel)} className={selectCls} data-testid="xy-y">
            {XY_CHANNELS.map(ch => <option key={ch.key} value={ch.key}>{t(ch.ja, ch.en)}</option>)}
          </select>
        </label>
        {cars.length === 0 && <span>{t('データ管理で周を選ぶと出ます', 'Choose laps in Data to show them')}</span>}
      </div>
      <div className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="absolute inset-0" />
      </div>
    </div>
  );
};
