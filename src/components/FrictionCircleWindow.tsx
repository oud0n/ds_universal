import React, { useRef, useEffect } from 'react';
import { Lap, SelectedCarSlot } from '../types/telemetry';
import { CircleDot, Disc } from 'lucide-react';

interface FrictionCircleWindowProps {
  cars: {
    slot: SelectedCarSlot;
    lap: Lap;
  }[];
  currentDistance: number;
}

export const FrictionCircleWindow: React.FC<FrictionCircleWindowProps> = ({
  cars,
  currentDistance
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const baseCar = cars[0];

  // 現在ポイントの取得
  const currentPoints = cars.map(c => {
    const pts = c.lap.points;
    if (pts.length === 0) return null;
    return pts.reduce((prev, curr) => {
      return Math.abs(curr.distance - currentDistance) < Math.abs(prev.distance - currentDistance)
        ? curr
        : prev;
    }, pts[0]);
  });

  const basePoint = currentPoints[0];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 300;
    const height = canvas.parentElement?.clientHeight || 300;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);

    // 背景
    ctx.fillStyle = '#141722';
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
      ctx.strokeStyle = g === 1.0 ? '#38bdf8' : '#273147';
      ctx.lineWidth = g === 1.0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = g === 1.0 ? '#38bdf8' : '#64748b';
      ctx.fillText(`${g.toFixed(1)}G`, centerX + r - 12, centerY - 3);
    });

    // 2. 十字軸 (X: コーナリングG, Y: 加減速G)
    ctx.strokeStyle = '#2e384f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX - maxRadius - 10, centerY);
    ctx.lineTo(centerX + maxRadius + 10, centerY);
    ctx.moveTo(centerX, centerY - maxRadius - 10);
    ctx.lineTo(centerX, centerY + maxRadius + 10);
    ctx.stroke();

    // 軸ラベル (モータースポーツG-Gダイアグラム標準: ブレーキング=上, 加速=下, 右旋回遠心G=左, 左旋回遠心G=右)
    ctx.fillStyle = '#94a3b8';
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
  }, [cars, currentDistance, currentPoints]);

  return (
    <div className="flex flex-col h-full bg-[#161922] rounded-lg border border-[#262c3d] overflow-hidden select-none shadow-lg">
      {/* ツールバー */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1b202d] border-b border-[#2a3245] text-xs">
        <span className="font-bold text-slate-200 flex items-center gap-1.5">
          <Disc size={14} className="text-cyan-400" />
          フリクションサークル (GGダイアグラム)
        </span>
        <span className="text-[10px] text-cyan-400 font-mono">タイヤグリップ限界円 (1.0G)</span>
      </div>

      {/* メインCanvas & 数値表示 */}
      <div className="flex-1 flex flex-col md:flex-row items-center p-2 gap-3 min-h-[200px]">
        {/* Canvas */}
        <div className="flex-1 w-full h-full min-h-[170px] relative">
          <canvas ref={canvasRef} className="w-full h-full block" />
        </div>

        {/* リアルタイム計測値パネル */}
        {basePoint && (
          <div className="w-full md:w-36 bg-[#12141c] border border-[#262c3d] rounded p-2.5 flex flex-col gap-2 text-xs">
            <div className="text-[11px] font-bold text-slate-400 border-b border-[#262c3d] pb-1">
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
            <div className="flex flex-col gap-1 mt-1 pt-1 border-t border-[#262c3d]">
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
