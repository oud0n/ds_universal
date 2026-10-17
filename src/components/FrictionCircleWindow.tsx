import React, { useRef, useEffect, useState } from 'react';
import { canvasColors, useResolvedTheme } from '../utils/theme';
import { useCompactLayout } from '../hooks/useCompactLayout';
import { CompareAxis, Lap, SelectedCarSlot } from '../types/telemetry';
import { CircleDot, Disc } from 'lucide-react';
import { findCarPoint } from '../utils/telemetrySearch';

interface FrictionCircleWindowProps {
  cars: {
    slot: SelectedCarSlot;
    lap: Lap;
  }[];
  currentDistance: number;
  currentTime: number;
  compareAxis: CompareAxis;
  // G のならし方を「強」にしているか。トグルで「強」と「標準」を切り替える (データ管理タブの設定と同じもの)
  smoothStrong?: boolean;
  onToggleSmooth?: () => void;
}

export const FrictionCircleWindow: React.FC<FrictionCircleWindowProps> = ({
  cars,
  currentDistance,
  currentTime,
  compareAxis,
  smoothStrong,
  onToggleSmooth
}) => {
  // テーマを切り替えたら canvas を描き直す
  const theme = useResolvedTheme();
  // スマートフォンでは高さが足りず数値の欄が切れるので、ウインドウの中をスクロールできるようにする
  const compact = useCompactLayout();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const baseCar = cars[0];

  // 現在ポイントの取得 (O(log N) 二分探索。距離基準: 基準車と同じ距離 / 時間基準: 同じ経過時間)
  const currentPoints = cars.map(c => {
    const pts = c.lap.points;
    if (pts.length === 0) return null;
    return findCarPoint(pts, compareAxis, currentDistance, currentTime) || pts[0];
  });

  const basePoint = currentPoints[0];

  // 表示領域の大きさが変わったら描き直す (スマートフォンを回したとき・ルーラーが出たときなど)
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setResizeTick(t => t + 1));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // テーマの色 (テーマを切り替えたら描き直す)
    const C = canvasColors();

    const dpr = window.devicePixelRatio || 1;
    // 隠しているとき (たたんだウインドウ・切り替えで見えていないパネル) は描かない。見えたら大きさの変化で描き直す
    const width = canvas.parentElement?.clientWidth ?? 0;
    const height = canvas.parentElement?.clientHeight ?? 0;
    if (width === 0 || height === 0) return;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);

    // 背景
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.min(centerX, centerY) * 0.82;

    // スケール: ±1.5G を基準円半径
    const maxG = 1.6;
    const toPx = (gVal: number) => (gVal / maxG) * maxRadius;

    // 1. 同心円ガイドライン (0.5G, 1.0G, 1.5G)
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.font = '9px monospace';

    [0.5, 1.0, 1.5].forEach(g => {
      const r = toPx(g);
      ctx.strokeStyle = g === 1.0 ? '#38bdf8' : C.grid;
      ctx.lineWidth = g === 1.0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = g === 1.0 ? '#38bdf8' : C.axis;
      ctx.fillText(`${g.toFixed(1)}G`, centerX + r - 12, centerY - 3);
    });

    // 2. 十字軸 (X: コーナリングG, Y: 加減速G)
    ctx.strokeStyle = C.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX - maxRadius - 10, centerY);
    ctx.lineTo(centerX + maxRadius + 10, centerY);
    ctx.moveTo(centerX, centerY - maxRadius - 10);
    ctx.lineTo(centerX, centerY + maxRadius + 10);
    ctx.stroke();

    // 軸ラベル (モータースポーツG-Gダイアグラム標準: ブレーキング=上, 加速=下, 右旋回遠心G=左, 左旋回遠心G=右)
    ctx.fillStyle = C.label;
    ctx.font = 'bold 9px sans-serif';
    ctx.fillText('減速 (ブレーキ)', centerX, centerY - maxRadius - 4);
    ctx.fillText('加速', centerX, centerY + maxRadius + 12);
    ctx.textAlign = 'left';
    ctx.fillText('右G (左旋回)', centerX + maxRadius + 4, centerY + 3);
    ctx.textAlign = 'right';
    ctx.fillText('左G (右旋回)', centerX - maxRadius - 4, centerY + 3);

    if (cars.length === 0) return;

    // 3. 全走行データのG分布 (散布図: 薄いドット)
    cars.forEach(car => {
      ctx.fillStyle = car.slot.colorHex + '25'; // 非常に薄い色
      for (const p of car.lap.points) {
        // X: 右旋回時(corneringG>0)に左(-X), 左旋回時(corneringG<0)に右(+X)
        // Y: 減速時(accelG<0)に上(-Y), 加速時(accelG>0)に下(+Y)
        const px = centerX - toPx(p.corneringG);
        const py = centerY + toPx(p.accelG);
        ctx.fillRect(px - 1, py - 1, 2, 2);
      }
    });

    // 4. 現在値プロット (大きなサークル & グロー)
    cars.forEach((car, idx) => {
      const pt = currentPoints[idx];
      if (!pt) return;

      const px = centerX - toPx(pt.corneringG);
      const py = centerY + toPx(pt.accelG);

      // グロー
      ctx.shadowColor = car.slot.colorHex;
      ctx.shadowBlur = 10;
      ctx.fillStyle = car.slot.colorHex;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 中心白点
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [cars, currentDistance, currentPoints, theme, resizeTick]);

  return (
    <div className={`flex flex-col h-full bg-surface-2 rounded-lg border border-line-2 select-none shadow-lg ${compact ? 'overflow-y-auto' : 'overflow-hidden'}`}>
      {/* ツールバー */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 py-1.5 bg-surface-3 border-b border-line-2 text-xs whitespace-nowrap shrink-0">
        <span className="font-bold text-slate-200 flex items-center gap-1.5">
          <Disc size={14} className="text-cyan-400" />
          フリクションサークル
        </span>
        <div className="flex items-center gap-2">
          {onToggleSmooth && (
            <button
              onClick={onToggleSmooth}
              aria-pressed={!!smoothStrong}
              title="G のならし方を「強」にして、点の動きを落ち着かせます (データ管理タブの「G のならし方」と同じ設定。急な変化は鈍く出ます)"
              className={`px-2 py-0.5 rounded border text-[11px] font-medium transition-colors ${
                smoothStrong ? 'bg-cyan-600 border-cyan-500 text-white' : 'border-line-3 text-slate-400 hover:text-slate-200'
              }`}
            >
              なめらか{smoothStrong ? ': ON' : ''}
            </button>
          )}
          <span className="text-[10px] text-cyan-400 font-mono">限界円 1.0G</span>
        </div>
      </div>

      {/* メインCanvas & 数値表示 */}
      <div className={`flex-1 flex flex-col md:flex-row items-center p-2 gap-3 min-h-[200px] ${compact ? 'shrink-0' : ''}`}>
        {/* Canvas */}
        <div className={`flex-1 w-full h-full relative ${compact ? 'min-h-[220px]' : 'min-h-[170px]'}`}>
          <canvas ref={canvasRef} className="w-full h-full block" />
        </div>

        {/* リアルタイム計測値パネル */}
        {basePoint && (
          <div className="w-full md:w-36 bg-surface-1 border border-line-2 rounded p-2.5 flex flex-col gap-2 text-xs">
            <div className="text-[11px] font-bold text-slate-400 border-b border-line-2 pb-1">
              基準車 (Red) テレメトリ
            </div>

            <div className="flex justify-between items-center font-mono">
              <span className="text-slate-400 text-[11px]">合算 G:</span>
              <span className="font-bold text-amber-400 text-sm">{basePoint.combinedG.toFixed(2)} G</span>
            </div>

            <div className="flex justify-between items-center font-mono">
              <span className="text-slate-400 text-[11px]">加減速 G:</span>
              <span className={`font-bold ${basePoint.accelG >= 0 ? 'text-cyan-400' : 'text-red-400'}`}>
                {basePoint.accelG > 0 ? '+' : ''}{basePoint.accelG.toFixed(2)} G
              </span>
            </div>

            <div className="flex justify-between items-center font-mono">
              <span className="text-slate-400 text-[11px]">横 G:</span>
              <span className="font-bold text-emerald-400">
                {basePoint.corneringG > 0 ? 'R' : 'L'} {Math.abs(basePoint.corneringG).toFixed(2)} G
              </span>
            </div>

            <div className="flex justify-between items-center font-mono">
              <span className="text-slate-400 text-[11px]">旋回半径 R:</span>
              <span className="font-bold text-purple-400">
                {basePoint.turningRadius > 2000 ? '直線' : `${basePoint.turningRadius.toFixed(0)} m`}
              </span>
            </div>

            {/* 縦横G比率バー (公式アプリ仕様) */}
            <div className="flex flex-col gap-1 mt-1 pt-1 border-t border-line-2">
              <span className="text-[10px] text-slate-400">縦横G比率:</span>
              <div className="w-full h-2 rounded bg-slate-800 overflow-hidden flex">
                {basePoint.combinedG > 0.05 && (
                  <>
                    <div
                      style={{
                        width: `${Math.min(100, (Math.abs(basePoint.accelG) / basePoint.combinedG) * 100)}%`
                      }}
                      className="h-full bg-red-500"
                      title="縦G (加減速)"
                    />
                    <div
                      style={{
                        width: `${Math.min(100, (Math.abs(basePoint.corneringG) / basePoint.combinedG) * 100)}%`
                      }}
                      className="h-full bg-emerald-500"
                      title="横G (コーナリング)"
                    />
                  </>
                )}
              </div>
              <div className="flex justify-between text-[9px] text-slate-400">
                <span className="text-red-400">縦: 加減速</span>
                <span className="text-emerald-400">横: コーナリング</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
