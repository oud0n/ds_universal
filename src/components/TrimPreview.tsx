import React, { useEffect, useMemo, useState } from 'react';
import { Flag, RotateCcw } from 'lucide-react';
import { Session } from '../types/telemetry';

interface TrimPreviewProps {
  session: Session;
  // 書き出す範囲 (ログの先頭からの秒)
  startSec: number;
  endSec: number;
  // 範囲を変えられるか (ログ全体・ラップを選んでいるときも、操作したら時間指定に切り替える)
  onChange: (startSec: number, endSec: number) => void;
  onReset: () => void;
  // 表示する時刻の調整 (時間)。変換画面の「時刻の調整」と同じ
  offsetHours: number;
}

// 描く点の数の上限 (長いログでも重くならないよう間引く)
const MAX_DRAW_POINTS = 1500;
// 開始と終了の最小の間隔 (秒)
const MIN_SPAN_SEC = 1;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 変換画面の切り出しのプレビュー。コース図と車速のグラフで書き出す範囲を見せ、範囲を指定する。
 * グラフをなぞる (タップする) と、その地点を開始・終了に設定できる
 */
export const TrimPreview: React.FC<TrimPreviewProps> = ({ session, startSec, endSec, onChange, onReset, offsetHours }) => {
  const pts = session.points;
  const t0 = pts[0]?.time ?? 0;
  const duration = pts.length > 0 ? pts[pts.length - 1].time - t0 : 0;

  // 記録時刻 (UTC)。ないログは先頭からの経過時間で表示する
  const clockBaseMs = useMemo(() => {
    const ms = pts[0]?.timestamp ? Date.parse(pts[0].timestamp) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }, [pts]);

  // 秒 → 表示用の時刻 (HH:mm:ss)。記録時刻がなければ先頭からの mm:ss
  const formatSec = (sec: number): string => {
    if (clockBaseMs !== null) {
      const d = new Date(clockBaseMs + sec * 1000 + offsetHours * 3600 * 1000);
      return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
    }
    const s = Math.max(0, Math.round(sec));
    return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
  };
  // 表示用の時刻 → 秒。読めなければ null
  const parseTime = (text: string): number | null => {
    const parts = text.trim().split(':').map(Number);
    if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return null;
    if (clockBaseMs === null) {
      const [m, s] = parts.length === 3 ? [parts[0] * 60 + parts[1], parts[2]] : parts;
      return m * 60 + s;
    }
    const [h, m, s = 0] = parts;
    const base = new Date(clockBaseMs + offsetHours * 3600 * 1000);
    const baseOfDay = base.getUTCHours() * 3600 + base.getUTCMinutes() * 60 + base.getUTCSeconds() + base.getUTCMilliseconds() / 1000;
    let diff = h * 3600 + m * 60 + s - baseOfDay;
    // 日付をまたぐログ
    if (diff < -43200) diff += 86400;
    if (diff > 129600) diff -= 86400;
    return diff;
  };

  const clampRange = (a: number, b: number): [number, number] => {
    const start = Math.max(0, Math.min(a, duration - MIN_SPAN_SEC));
    const end = Math.min(duration, Math.max(b, start + MIN_SPAN_SEC));
    return [start, end];
  };
  const apply = (a: number, b: number) => {
    const [s, e] = clampRange(a, b);
    onChange(s, e);
  };

  // 描く点 (間引いたもの)
  const drawPts = useMemo(() => {
    const step = Math.max(1, Math.ceil(pts.length / MAX_DRAW_POINTS));
    return pts.filter((p, i) => (i % step === 0 || i === pts.length - 1) && Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  }, [pts]);

  // コース図: 緯度経度を平面に直して枠に収める
  const MAP_W = 1000;
  const MAP_H = 600;
  const mapXY = useMemo(() => {
    if (drawPts.length === 0) return [] as { x: number; y: number; t: number }[];
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of drawPts) {
      minLat = Math.min(minLat, p.latitude); maxLat = Math.max(maxLat, p.latitude);
      minLon = Math.min(minLon, p.longitude); maxLon = Math.max(maxLon, p.longitude);
    }
    const cosLat = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const w = (maxLon - minLon) * cosLat || 1e-9;
    const h = maxLat - minLat || 1e-9;
    const scale = Math.min((MAP_W - 40) / w, (MAP_H - 40) / h);
    const ox = (MAP_W - w * scale) / 2;
    const oy = (MAP_H - h * scale) / 2;
    return drawPts.map(p => ({ x: ox + (p.longitude - minLon) * cosLat * scale, y: MAP_H - (oy + (p.latitude - minLat) * scale), t: p.time - t0 }));
  }, [drawPts, t0]);

  const pathOf = (list: { x: number; y: number }[]) => list.map((q, i) => `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('');
  const inRange = (t: number) => t >= startSec && t <= endSec;

  // 車速のグラフ
  const CH_W = 1000;
  const CH_H = 160;
  const maxSpeed = useMemo(() => Math.max(10, ...drawPts.map(p => p.speed)), [drawPts]);
  const xOf = (t: number) => (duration > 0 ? (t / duration) * CH_W : 0);
  const yOf = (v: number) => CH_H - (v / (maxSpeed * 1.1)) * CH_H;
  const speedPath = useMemo(() => {
    if (drawPts.length === 0) return '';
    const line = drawPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.time - t0).toFixed(1)},${yOf(p.speed).toFixed(1)}`).join('');
    return `${line}L${CH_W},${CH_H}L0,${CH_H}Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawPts, t0, duration, maxSpeed]);

  // グラフ上でなぞっている (タップした) 地点
  const [cursorSec, setCursorSec] = useState<number | null>(null);
  const cursorPt = useMemo(() => {
    if (cursorSec === null || drawPts.length === 0) return null;
    let best = drawPts[0];
    for (const p of drawPts) if (Math.abs(p.time - t0 - cursorSec) < Math.abs(best.time - t0 - cursorSec)) best = p;
    return best;
  }, [cursorSec, drawPts, t0]);
  const cursorMap = useMemo(() => {
    if (!cursorPt) return null;
    const i = drawPts.indexOf(cursorPt);
    return mapXY[i] ?? null;
  }, [cursorPt, drawPts, mapXY]);
  useEffect(() => setCursorSec(null), [session.id]);

  // ラップの区切り (各ラップの始まりと最後のラップの終わり。ログの先頭からの秒)。グラフに目盛りとして出す
  const lapMarks = useMemo(() => {
    const laps = session.laps.filter(l => !l.isWholeSession);
    const marks = laps.map(l => ({ sec: l.startTime - t0, label: `L${l.lapNumber}` }));
    const last = laps[laps.length - 1];
    // 最後のラップの終わりも選べるようにする
    if (last) marks.push({ sec: last.endTime - t0, label: '終' });
    return marks.filter(m => m.sec >= 0 && m.sec <= duration);
  }, [session.laps, t0, duration]);

  const secFromPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return r * duration;
  };

  // 時刻の入力欄 (入力中の文字は、確定するまで範囲に反映しない)
  const [startText, setStartText] = useState(formatSec(startSec));
  const [endText, setEndText] = useState(formatSec(endSec));
  useEffect(() => setStartText(formatSec(startSec)), [startSec, clockBaseMs, offsetHours]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setEndText(formatSec(endSec)), [endSec, clockBaseMs, offsetHours]); // eslint-disable-line react-hooks/exhaustive-deps
  const commitStart = () => {
    const v = parseTime(startText);
    if (v === null) setStartText(formatSec(startSec));
    else apply(v, endSec);
  };
  const commitEnd = () => {
    const v = parseTime(endText);
    if (v === null) setEndText(formatSec(endSec));
    else apply(startSec, v);
  };

  const stepBtn = 'px-1.5 py-1 rounded bg-surface-4 hover:bg-surface-5 border border-line-4 text-[10px] font-mono text-slate-300';
  const timeInput = 'w-24 bg-surface-0 border border-line-3 rounded px-2 py-1 text-xs font-mono text-slate-200 outline-none focus:border-red-500';

  const timeControl = (label: string, text: string, setText: (v: string) => void, commit: () => void, adjust: (d: number) => void) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-slate-400 w-8">{label}</span>
      <button className={stepBtn} onClick={() => adjust(-60)}>-1分</button>
      <button className={stepBtn} onClick={() => adjust(-10)}>-10秒</button>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={timeInput}
        aria-label={`${label}の時刻`}
      />
      <button className={stepBtn} onClick={() => adjust(10)}>+10秒</button>
      <button className={stepBtn} onClick={() => adjust(60)}>+1分</button>
    </div>
  );

  if (pts.length < 2) return null;

  return (
    <div className="bg-surface-2 border border-line-2 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-300">切り出し（書き出す範囲）</span>
        <button onClick={onReset} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200">
          <RotateCcw size={12} />
          全体に戻す
        </button>
      </div>

      {/* コース図: 書き出す範囲を赤、外した部分を灰色で描く */}
      <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="w-full h-48 sm:h-56 bg-surface-1 rounded-lg border border-line-1" preserveAspectRatio="xMidYMid meet">
        <path d={pathOf(mapXY)} fill="none" stroke="var(--ds-line-4)" strokeWidth={4} strokeLinejoin="round" />
        <path d={pathOf(mapXY.filter(q => inRange(q.t)))} fill="none" stroke="#ef4444" strokeWidth={5} strokeLinejoin="round" />
        {cursorMap && <circle cx={cursorMap.x} cy={cursorMap.y} r={10} fill="#facc15" stroke="#0f172a" strokeWidth={2} />}
      </svg>

      {/* 車速のグラフ: なぞる (タップする) と地点を選ぶ */}
      <div className="space-y-1">
        <svg
          viewBox={`0 0 ${CH_W} ${CH_H}`}
          preserveAspectRatio="none"
          className="w-full h-28 bg-surface-1 rounded-lg border border-line-1 touch-none cursor-crosshair"
          onPointerMove={e => setCursorSec(secFromPointer(e))}
          onPointerDown={e => setCursorSec(secFromPointer(e))}
        >
          <path d={speedPath} fill="rgba(59,130,246,0.25)" stroke="#3b82f6" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {/* 外した部分を暗くする */}
          <rect x={0} y={0} width={xOf(startSec)} height={CH_H} fill="var(--ds-surface-0)" opacity={0.7} />
          <rect x={xOf(endSec)} y={0} width={Math.max(0, CH_W - xOf(endSec))} height={CH_H} fill="var(--ds-surface-0)" opacity={0.7} />
          <line x1={xOf(startSec)} x2={xOf(startSec)} y1={0} y2={CH_H} stroke="#22c55e" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          <line x1={xOf(endSec)} x2={xOf(endSec)} y1={0} y2={CH_H} stroke="#ef4444" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {/* ラップの区切りの目盛り */}
          {lapMarks.map((m, i) => (
            <line key={i} x1={xOf(m.sec)} x2={xOf(m.sec)} y1={0} y2={CH_H} stroke="var(--ds-canvas-axis)" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          ))}
          {cursorSec !== null && <line x1={xOf(cursorSec)} x2={xOf(cursorSec)} y1={0} y2={CH_H} stroke="#facc15" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        </svg>
        {/* ラップの番号 (押すと、そのラップの始まりの地点を選ぶ。「1〜3 周目を切り出す」ときなどに使う) */}
        {lapMarks.length > 0 && (
          <div className="relative h-5 text-[10px] font-mono">
            {lapMarks.filter(m => m.label).map((m, i) => (
              <button
                key={i}
                onClick={() => setCursorSec(m.sec)}
                title={m.label === '終' ? '最後のラップの終わりを選ぶ' : `${m.label} の始まりを選ぶ`}
                style={{ left: `${(m.sec / duration) * 100}%` }}
                className="absolute -translate-x-1/2 px-1 rounded text-slate-400 hover:text-slate-100 hover:bg-surface-4"
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 min-h-[28px]">
          {cursorPt ? (
            <>
              <span className="font-mono text-slate-200">{formatSec(cursorPt.time - t0)}</span>
              <span className="font-mono">{cursorPt.speed.toFixed(1)} km/h</span>
              <button
                onClick={() => apply(cursorPt.time - t0, endSec)}
                className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
              >
                <Flag size={11} />
                ここを開始地に設定
              </button>
              <button
                onClick={() => apply(startSec, cursorPt.time - t0)}
                className="flex items-center gap-1 px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-bold"
              >
                <Flag size={11} />
                ここを終了地に設定
              </button>
            </>
          ) : (
            <span>グラフをなぞる（タップする）と、その地点を開始地・終了地に設定できます。</span>
          )}
        </div>
      </div>

      {/* 範囲のスライダー */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-slate-400 space-y-1 block">
          <span>開始</span>
          <input type="range" min={0} max={duration} step={0.1} value={startSec} onChange={e => apply(Number(e.target.value), endSec)} className="w-full accent-emerald-500" />
        </label>
        <label className="text-xs text-slate-400 space-y-1 block">
          <span>終了</span>
          <input type="range" min={0} max={duration} step={0.1} value={endSec} onChange={e => apply(startSec, Number(e.target.value))} className="w-full accent-red-500" />
        </label>
      </div>

      {/* 時刻の入力と微調整 */}
      <div className="flex flex-col gap-2">
        {timeControl('開始', startText, setStartText, commitStart, d => apply(startSec + d, endSec))}
        {timeControl('終了', endText, setEndText, commitEnd, d => apply(startSec, endSec + d))}
        <span className="text-[11px] text-slate-500">
          長さ: {(endSec - startSec).toFixed(1)} 秒 / ログ全体 {duration.toFixed(1)} 秒
          {clockBaseMs === null ? '（このログは記録時刻がないため、先頭からの経過時間で表示しています）' : ''}
        </span>
      </div>
    </div>
  );
};
