import React, { useEffect, useMemo, useState } from 'react';
import { Flag, RotateCcw, Maximize2, Minimize2, Car } from 'lucide-react';
import { Session } from '../types/telemetry';
import { useLang, useT } from '../utils/i18n';

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
// 走っているとみなす車速 (km/h) と、グラフで走っている部分の前後に付ける余白 (秒)
const MOVING_KMH = 10;
const VIEW_MARGIN_SEC = 30;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 変換画面の切り出しのプレビュー。コース図と車速のグラフで書き出す範囲を見せ、範囲を指定する。
 * グラフをなぞる (タップする) と、その地点を開始・終了に設定できる
 */
export const TrimPreview: React.FC<TrimPreviewProps> = ({ session, startSec, endSec, onChange, onReset, offsetHours }) => {
  const t = useT();
  const lang = useLang();
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
    // 先頭より前の時刻は、日付をまたいだ翌日とみなす (秒未満の切り捨ての分の差は除く)
    if (diff < -1) diff += 86400;
    return Math.max(0, diff);
  };

  const clampRange = (a: number, b: number): [number, number] => {
    const start = Math.max(0, Math.min(a, duration - MIN_SPAN_SEC));
    const end = Math.min(duration, Math.max(b, start + MIN_SPAN_SEC));
    return [start, end];
  };
  const apply = (a: number, b: number): [number, number] => {
    const [s, e] = clampRange(a, b);
    onChange(s, e);
    return [s, e];
  };

  // 描ける点 (位置と車速が数値のもの)
  const isValid = (p: Session['points'][number]) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Number.isFinite(p.speed);

  // 走っている部分 (ログの先頭からの秒)。走り終わってもロガーを点けたままにしたログ (駐車中の記録が長く続く) で、
  // グラフが左に寄って見えないよう、はじめはこの部分を (前後に余白を付けて) 大きく出す。「全体を表示」で全体に切り替える
  const driving = useMemo(() => {
    const first = pts.find(p => p.speed >= MOVING_KMH);
    let last: typeof first;
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].speed >= MOVING_KMH) { last = pts[i]; break; }
    return first && last ? { start: first.time - t0, end: last.time - t0 } : null;
  }, [pts, t0]);
  // 走っている部分がログの 8 割より短いときだけ、寄せて出せる
  const canZoom = !!driving && duration > 0 && (driving.end - driving.start) < duration * 0.8;
  const [showWhole, setShowWhole] = useState(false);
  useEffect(() => setShowWhole(false), [session.id]);
  const view: [number, number] = canZoom && !showWhole && driving
    ? [Math.max(0, driving.start - VIEW_MARGIN_SEC), Math.min(duration, driving.end + VIEW_MARGIN_SEC)]
    : [0, duration];
  const viewSpan = Math.max(1e-6, view[1] - view[0]);

  // 描く点 (間引いたもの)
  const drawPts = useMemo(() => {
    const step = Math.max(1, Math.ceil(pts.length / MAX_DRAW_POINTS));
    return pts.filter((p, i) => (i % step === 0 || i === pts.length - 1) && isValid(p));
  }, [pts]);
  // グラフに描く点: 見ている部分の中の点を間引く (寄せて出しても線が粗くならないように)
  const chartPts = useMemo(() => {
    const inside = pts.filter(p => p.time - t0 >= view[0] && p.time - t0 <= view[1] && isValid(p));
    const step = Math.max(1, Math.ceil(inside.length / MAX_DRAW_POINTS));
    return inside.filter((_, i) => i % step === 0 || i === inside.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, t0, view[0], view[1]]);

  // コース図: 緯度経度を平面に直して枠に収める
  const MAP_W = 1000;
  const MAP_H = 600;
  const projection = useMemo(() => {
    if (drawPts.length === 0) return null;
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
    return (p: { latitude: number; longitude: number; time: number }) => ({
      x: ox + (p.longitude - minLon) * cosLat * scale,
      y: MAP_H - (oy + (p.latitude - minLat) * scale),
      t: p.time - t0
    });
  }, [drawPts, t0]);
  const mapXY = useMemo(() => (projection ? drawPts.map(projection) : []), [projection, drawPts]);
  // 範囲の部分は、全体を間引いた点でなく範囲の中の点から描く (短い範囲でも線が消えないように)
  const rangeXY = useMemo(() => {
    if (!projection) return [];
    const inside = pts.filter(p => p.time - t0 >= startSec && p.time - t0 <= endSec && isValid(p));
    const step = Math.max(1, Math.ceil(inside.length / MAX_DRAW_POINTS));
    return inside.filter((_, i) => i % step === 0 || i === inside.length - 1).map(projection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection, pts, t0, startSec, endSec]);

  const pathOf = (list: { x: number; y: number }[]) => list.map((q, i) => `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('');

  // 車速のグラフ
  const CH_W = 1000;
  const CH_H = 160;
  const maxSpeed = useMemo(() => drawPts.reduce((m, p) => Math.max(m, p.speed), 10), [drawPts]);
  // 見ている部分の外は端にそろえる
  const xOf = (t: number) => (Math.min(view[1], Math.max(view[0], t)) - view[0]) / viewSpan * CH_W;
  const yOf = (v: number) => CH_H - (v / (maxSpeed * 1.1)) * CH_H;
  const speedPath = useMemo(() => {
    if (chartPts.length === 0) return '';
    const line = chartPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.time - t0).toFixed(1)},${yOf(p.speed).toFixed(1)}`).join('');
    // 塗りは、最初と最後の点の真下で閉じる
    const xFirst = xOf(chartPts[0].time - t0).toFixed(1);
    const xLast = xOf(chartPts[chartPts.length - 1].time - t0).toFixed(1);
    return `${line}L${xLast},${CH_H}L${xFirst},${CH_H}Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartPts, t0, view[0], view[1], maxSpeed]);

  // グラフ上でなぞっている (タップした) 地点 (ログの先頭からの秒。ラップの番号を押したときはその区切りちょうど)
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
    const marks = laps.map(l => ({ sec: l.startTime - t0, label: `L${l.lapNumber}`, end: false }));
    const last = laps[laps.length - 1];
    // 最後のラップの終わりも選べるようにする
    if (last) marks.push({ sec: last.endTime - t0, label: t('終', 'End'), end: true });
    return marks.filter(m => m.sec >= 0 && m.sec <= duration);
  }, [session.laps, t0, duration, lang]);

  const secFromPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return view[0] + r * viewSpan;
  };

  // 時刻の入力欄 (入力中の文字は、確定するまで範囲に反映しない)
  const [startText, setStartText] = useState(formatSec(startSec));
  const [endText, setEndText] = useState(formatSec(endSec));
  useEffect(() => setStartText(formatSec(startSec)), [startSec, clockBaseMs, offsetHours]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setEndText(formatSec(endSec)), [endSec, clockBaseMs, offsetHours]); // eslint-disable-line react-hooks/exhaustive-deps
  // 入力を確定する。文字を変えていなければ何もしない (表示は秒未満を切り捨てているので、そのまま確定すると範囲がずれる。
  // ラップ・全体の指定も時間指定に変わってしまう)。確定したら、丸めた後の値で表示し直す
  const commitStart = () => {
    if (startText === formatSec(startSec)) return;
    const v = parseTime(startText);
    setStartText(formatSec(v === null ? startSec : apply(v, endSec)[0]));
  };
  const commitEnd = () => {
    if (endText === formatSec(endSec)) return;
    const v = parseTime(endText);
    setEndText(formatSec(v === null ? endSec : apply(startSec, v)[1]));
  };

  const stepBtn = 'px-1.5 py-1 rounded bg-surface-4 hover:bg-surface-5 border border-line-4 text-[10px] font-mono text-slate-300';
  const timeInput = 'w-24 bg-surface-0 border border-line-3 rounded px-2 py-1 text-xs font-mono text-slate-200 outline-none focus:border-red-500';

  const timeControl = (label: string, text: string, setText: (v: string) => void, commit: () => void, adjust: (d: number) => void) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-slate-400 w-8">{label}</span>
      <button className={stepBtn} onClick={() => adjust(-60)}>{t('-1分', '-1 min')}</button>
      <button className={stepBtn} onClick={() => adjust(-10)}>{t('-10秒', '-10 s')}</button>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={timeInput}
        aria-label={t(`${label}の時刻`, `${label} time`)}
      />
      <button className={stepBtn} onClick={() => adjust(10)}>{t('+10秒', '+10 s')}</button>
      <button className={stepBtn} onClick={() => adjust(60)}>{t('+1分', '+1 min')}</button>
    </div>
  );

  if (pts.length < 2) return null;

  return (
    <div className="bg-surface-2 border border-line-2 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-300">{t('切り出し（書き出す範囲）', 'Trim (export range)')}</span>
        <button onClick={onReset} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200">
          <RotateCcw size={12} />
          {t('全体に戻す', 'Reset to whole log')}
        </button>
      </div>

      {/* コース図: 書き出す範囲を赤、外した部分を灰色で描く */}
      <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="w-full h-48 sm:h-56 bg-surface-1 rounded-lg border border-line-1" preserveAspectRatio="xMidYMid meet">
        <path d={pathOf(mapXY)} fill="none" stroke="var(--ds-line-4)" strokeWidth={4} strokeLinejoin="round" />
        <path d={pathOf(rangeXY)} fill="none" stroke="#ef4444" strokeWidth={5} strokeLinejoin="round" />
        {cursorMap && <circle cx={cursorMap.x} cy={cursorMap.y} r={10} fill="#facc15" stroke="#0f172a" strokeWidth={2} />}
      </svg>

      {/* 車速のグラフ: なぞる (タップする) と地点を選ぶ */}
      <div className="space-y-1">
        {canZoom && driving && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span>
              {showWhole
                ? t(`ログ全体 (${formatSec(0)}〜${formatSec(duration)})`, `Whole log (${formatSec(0)}-${formatSec(duration)})`)
                : t(`走っている部分 (${formatSec(driving.start)}〜${formatSec(driving.end)})。前後は止まっていた記録です`, `Driving part (${formatSec(driving.start)}-${formatSec(driving.end)}). The rest is recorded while stopped`)}
            </span>
            <button onClick={() => setShowWhole(v => !v)} className="flex items-center gap-1 px-2 py-0.5 rounded border border-line-3 hover:text-slate-200">
              {showWhole ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
              {showWhole ? t('走っている部分を表示', 'Show the driving part') : t('全体を表示', 'Show the whole log')}
            </button>
            <button
              onClick={() => apply(Math.max(0, driving.start - 5), Math.min(duration, driving.end + 5))}
              className="flex items-center gap-1 px-2 py-0.5 rounded border border-line-3 hover:text-slate-200"
              title={t('書き出す範囲を、走っている部分 (前後 5 秒を含む) にします', 'Set the export range to the driving part (with 5 s before and after)')}
            >
              <Car size={11} />
              {t('走っている部分だけ書き出す', 'Export only the driving part')}
            </button>
          </div>
        )}
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
          {lapMarks.filter(m => m.sec >= view[0] && m.sec <= view[1]).map((m, i) => (
            <line key={i} x1={xOf(m.sec)} x2={xOf(m.sec)} y1={0} y2={CH_H} stroke="var(--ds-canvas-axis)" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          ))}
          {cursorSec !== null && <line x1={xOf(cursorSec)} x2={xOf(cursorSec)} y1={0} y2={CH_H} stroke="#facc15" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        </svg>
        {/* ラップの番号 (押すと、そのラップの始まりの地点を選ぶ。「1〜3 周目を切り出す」ときなどに使う) */}
        {lapMarks.length > 0 && (
          <div className="relative h-5 text-[10px] font-mono">
            {lapMarks.filter(m => m.label && m.sec >= view[0] && m.sec <= view[1]).map((m, i) => (
              <button
                key={i}
                onClick={() => setCursorSec(m.sec)}
                title={m.end ? t('最後のラップの終わりを選ぶ', 'Select the end of the last lap') : t(`${m.label} の始まりを選ぶ`, `Select the start of ${m.label}`)}
                style={{ left: `${((m.sec - view[0]) / viewSpan) * 100}%` }}
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
              <span className="font-mono text-slate-200">{formatSec(cursorSec ?? cursorPt.time - t0)}</span>
              <span className="font-mono">{cursorPt.speed.toFixed(1)} km/h</span>
              <button
                onClick={() => cursorSec !== null && apply(cursorSec, endSec)}
                className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
              >
                <Flag size={11} />
                {t('ここを開始地に設定', 'Set as start')}
              </button>
              <button
                onClick={() => cursorSec !== null && apply(startSec, cursorSec)}
                className="flex items-center gap-1 px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-bold"
              >
                <Flag size={11} />
                {t('ここを終了地に設定', 'Set as end')}
              </button>
            </>
          ) : (
            <span>{t('グラフをなぞる（タップする）と、その地点を開始地・終了地に設定できます。', 'Hover over (tap) the graph to pick a point and set it as the start or end.')}</span>
          )}
        </div>
      </div>

      {/* 範囲のスライダー */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-slate-400 space-y-1 block">
          <span>{t('開始', 'Start')}</span>
          <input type="range" min={0} max={duration} step={0.1} value={startSec} onChange={e => apply(Number(e.target.value), endSec)} className="w-full accent-emerald-500" />
        </label>
        <label className="text-xs text-slate-400 space-y-1 block">
          <span>{t('終了', 'End')}</span>
          <input type="range" min={0} max={duration} step={0.1} value={endSec} onChange={e => apply(startSec, Number(e.target.value))} className="w-full accent-red-500" />
        </label>
      </div>

      {/* 時刻の入力と微調整 */}
      <div className="flex flex-col gap-2">
        {timeControl(t('開始', 'Start'), startText, setStartText, commitStart, d => apply(startSec + d, endSec))}
        {timeControl(t('終了', 'End'), endText, setEndText, commitEnd, d => apply(startSec, endSec + d))}
        <span className="text-[11px] text-slate-500">
          {t(`長さ: ${(endSec - startSec).toFixed(1)} 秒 / ログ全体 ${duration.toFixed(1)} 秒`, `Length: ${(endSec - startSec).toFixed(1)} s / whole log ${duration.toFixed(1)} s`)}
          {clockBaseMs === null ? t('（このログは記録時刻がないため、先頭からの経過時間で表示しています）', ' (this log has no recorded clock time, so times are shown as elapsed time from the start)') : ''}
        </span>
      </div>
    </div>
  );
};
