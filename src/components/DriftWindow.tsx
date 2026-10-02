import React from 'react';
import { Lap, SelectedCarSlot } from '../types/telemetry';
import { Gauge, Flame } from 'lucide-react';

interface DriftWindowProps {
  cars: {
    slot: SelectedCarSlot;
    lap: Lap;
  }[];
  currentDistance: number;
}

export const DriftWindow: React.FC<DriftWindowProps> = ({
  cars,
  currentDistance
}) => {
  const baseCar = cars[0];

  // 現在ポイント
  const curPt = baseCar?.lap.points.reduce((prev, curr) => {
    return Math.abs(curr.distance - currentDistance) < Math.abs(prev.distance - currentDistance)
      ? curr
      : prev;
  }, baseCar.lap.points[0]);

  // ドリフト統計の計算
  const driftStats = React.useMemo(() => {
    if (!baseCar) return { maxAngle: 0, avgAngle: 0, score: 0, driftCount: 0 };

    let maxAngle = 0;
    let sumAngle = 0;
    let driftPoints = 0;

    for (const p of baseCar.lap.points) {
      const angle = Math.abs(p.driftAngle);
      if (angle > 5) {
        if (angle > maxAngle) maxAngle = angle;
        sumAngle += angle;
        driftPoints++;
      }
    }

    const avgAngle = driftPoints > 0 ? sumAngle / driftPoints : 0;
    // ドリフトスコア算出 (公式準拠: 角度 × 速度 × 持続性)
    const score = Math.min(100, Math.round(maxAngle * 1.5 + avgAngle * 0.8 + (driftPoints / 10) * 0.5));

    return {
      maxAngle: Number(maxAngle.toFixed(1)),
      avgAngle: Number(avgAngle.toFixed(1)),
      score,
      driftCount: Math.round(driftPoints / 10)
    };
  }, [baseCar]);

  const currentAngle = curPt ? curPt.driftAngle : 0;
  const absAngle = Math.abs(currentAngle);

  return (
    <div className="flex flex-col h-full bg-[#161922] rounded-lg border border-[#262c3d] overflow-hidden select-none shadow-lg">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1b202d] border-b border-[#2a3245] text-xs">
        <span className="font-bold text-slate-200 flex items-center gap-1.5">
          <Flame size={14} className="text-orange-500" />
          ドリフト評価機能
        </span>
        <span className="text-[10px] text-orange-400 font-mono font-bold">
          総合スコア: {driftStats.score} 点
        </span>
      </div>

      <div className="flex-1 p-3 flex flex-col justify-around gap-2">
        {/* ドリフトアングルメーター */}
        <div className="flex flex-col items-center">
          <div className="text-[11px] text-slate-400 mb-1 flex items-center gap-1">
            <Gauge size={13} />
            リアルタイム ドリフトアングル
          </div>
          <div className="text-3xl font-black font-mono text-orange-400">
            {currentAngle > 0 ? 'R' : currentAngle < 0 ? 'L' : ''} {absAngle.toFixed(1)}°
          </div>

          {/* 角度バーメーター (-60° 〜 +60°) */}
          <div className="w-48 h-3 rounded-full bg-slate-800 border border-slate-700 relative overflow-hidden mt-1.5">
            <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-slate-400"></div>
            {currentAngle < 0 ? (
              <div
                style={{
                  right: '50%',
                  width: `${Math.min(50, (absAngle / 60) * 50)}%`
                }}
                className="absolute top-0 bottom-0 bg-gradient-to-l from-orange-500 to-red-500 rounded-l-full"
              />
            ) : (
              <div
                style={{
                  left: '50%',
                  width: `${Math.min(50, (absAngle / 60) * 50)}%`
                }}
                className="absolute top-0 bottom-0 bg-gradient-to-r from-orange-500 to-red-500 rounded-r-full"
              />
            )}
          </div>
          <div className="flex justify-between w-48 text-[9px] font-mono text-slate-500 mt-0.5">
            <span>-60° (左)</span>
            <span>0°</span>
            <span>+60° (右)</span>
          </div>
        </div>

        {/* ドリフト分析統計 */}
        <div className="grid grid-cols-3 gap-2 text-center bg-[#12141c] border border-[#262c3d] rounded p-2">
          <div>
            <div className="text-[10px] text-slate-400">最大アングル</div>
            <div className="text-sm font-bold font-mono text-slate-100">{driftStats.maxAngle}°</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-400">平均アングル</div>
            <div className="text-sm font-bold font-mono text-slate-100">{driftStats.avgAngle}°</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-400">ドリフト時間</div>
            <div className="text-sm font-bold font-mono text-slate-100">{driftStats.driftCount} 秒</div>
          </div>
        </div>
      </div>
    </div>
  );
};
