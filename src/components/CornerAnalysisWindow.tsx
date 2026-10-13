import React, { useMemo } from 'react';
import { CornerDownRight } from 'lucide-react';
import { Lap, SelectedCarSlot } from '../types/telemetry';
import { useLapGeometries } from '../hooks/useLapGeometries';
import { computeCorrectedLineDelta, detectCorners, insideOutside, matchIndex, measureCorners } from '../services/drivingAnalysis';

interface CornerAnalysisWindowProps {
  cars: { slot: SelectedCarSlot; lap: Lap }[];
  currentDistance: number;
  onSeekDistance: (distKm: number) => void;
}

// 基準車との車速差の表示 (速いほうが緑)
const Diff: React.FC<{ value: number }> = ({ value }) => {
  if (Math.abs(value) < 0.05) return <span className="text-slate-600"> ±0.0</span>;
  return (
    <span className={value > 0 ? 'text-emerald-400' : 'text-red-400'}>
      {' '}{value > 0 ? '+' : ''}{value.toFixed(1)}
    </span>
  );
};

export const CornerAnalysisWindow: React.FC<CornerAnalysisWindowProps> = ({ cars, currentDistance, onSeekDistance }) => {
  const analysed = useLapGeometries(cars);
  const base = analysed[0];

  const result = useMemo(() => {
    if (!base) return null;
    const corners = detectCorners(base.geo);
    const perCar = analysed.map(car => {
      const metrics = measureCorners(base.geo, corners, car.geo);
      // 基準車のアペックス位置での走行ラインのズレ (ラップ間の GPS の位置ずれは補正する)
      const delta = car === base ? null : computeCorrectedLineDelta(base.geo, car.geo);
      const apexOffsets = corners.map(c => {
        if (!delta) return null;
        const idx = matchIndex(base.geo, c.apexIndex, car.geo);
        if (idx < 0 || !Number.isFinite(delta.offsetM[idx])) return null;
        return { offsetM: delta.offsetM[idx], side: insideOutside(delta.offsetM[idx], delta.refCurvature[idx]) };
      });
      return { car, metrics, apexOffsets };
    });
    return { corners, perCar };
  }, [analysed, base]);

  if (!base || !result) {
    return <div className="h-full flex items-center justify-center text-xs text-slate-500 bg-[#141722]">走行データを読み込むとコーナー別の速度を表示します</div>;
  }
  if (result.corners.length === 0) {
    return <div className="h-full flex items-center justify-center text-xs text-slate-500 bg-[#141722]">このラップからコーナーを検出できませんでした</div>;
  }

  const currentM = currentDistance * 1000;
  const baseMetrics = result.perCar[0].metrics;

  return (
    <div className="h-full flex flex-col bg-[#141722] text-slate-200 overflow-hidden" data-testid="corner-analysis">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#22293a] text-[11px] shrink-0">
        <span className="font-bold flex items-center gap-1.5">
          <CornerDownRight size={13} className="text-amber-400" />
          コーナー別速度 ({result.corners.length} コーナー)
        </span>
        <span className="text-slate-500 truncate ml-2">行クリックで移動 / 差は Car 1 比</span>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] font-mono border-collapse">
          <thead className="sticky top-0 bg-[#1b202d] text-slate-400">
            <tr>
              <th className="px-2 py-1 text-left font-medium" rowSpan={2}>コーナー</th>
              <th className="px-2 py-1 text-right font-medium" rowSpan={2}>最小R</th>
              {result.perCar.map(({ car }) => (
                <th key={car.slot.slot} className="px-2 py-1 text-center font-medium border-l border-[#2a3245]" colSpan={car === base ? 3 : 4}>
                  <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: car.slot.colorHex }} />
                  Car {car.slot.slot + 1} (L{car.lap.lapNumber})
                </th>
              ))}
            </tr>
            <tr>
              {result.perCar.map(({ car }) => (
                <React.Fragment key={car.slot.slot}>
                  <th className="px-2 py-1 text-right font-medium border-l border-[#2a3245]">進入</th>
                  <th className="px-2 py-1 text-right font-medium">ボトム</th>
                  <th className="px-2 py-1 text-right font-medium">脱出</th>
                  {car !== base && <th className="px-2 py-1 text-right font-medium">ライン</th>}
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.corners.map((c, i) => {
              const active = currentM >= c.startDistanceM && currentM <= c.endDistanceM;
              return (
                <tr
                  key={c.number}
                  onClick={() => onSeekDistance(base.lap.points[c.apexIndex].distance)}
                  className={`cursor-pointer border-t border-[#1f2533] hover:bg-[#1f2636] ${active ? 'bg-[#232b3e]' : ''}`}
                >
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className="font-bold text-slate-100">C{c.number}</span>
                    <span className={`ml-1.5 ${c.direction === 'R' ? 'text-sky-400' : 'text-amber-400'}`}>{c.direction === 'R' ? '右' : '左'}</span>
                    <span className="ml-1.5 text-slate-500">{c.headingChangeDeg.toFixed(0)}°</span>
                  </td>
                  <td className="px-2 py-1 text-right text-slate-400">{c.minRadiusM.toFixed(0)}m</td>
                  {result.perCar.map(({ car, metrics, apexOffsets }) => {
                    const m = metrics[i];
                    const b = baseMetrics[i];
                    if (!m || !b) {
                      return <td key={car.slot.slot} colSpan={car === base ? 3 : 4} className="px-2 py-1 text-center text-slate-600 border-l border-[#2a3245]">対応区間なし</td>;
                    }
                    const off = apexOffsets[i];
                    return (
                      <React.Fragment key={car.slot.slot}>
                        <td className="px-2 py-1 text-right border-l border-[#2a3245] whitespace-nowrap">{m.entrySpeed.toFixed(1)}{car !== base && <Diff value={m.entrySpeed - b.entrySpeed} />}</td>
                        <td className="px-2 py-1 text-right font-bold whitespace-nowrap">{m.bottomSpeed.toFixed(1)}{car !== base && <Diff value={m.bottomSpeed - b.bottomSpeed} />}</td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">{m.exitSpeed.toFixed(1)}{car !== base && <Diff value={m.exitSpeed - b.exitSpeed} />}</td>
                        {car !== base && (
                          <td className="px-2 py-1 text-right whitespace-nowrap text-slate-300">
                            {off ? `${off.side === 'IN' ? 'イン' : off.side === 'OUT' ? 'アウト' : ''} ${Math.abs(off.offsetM).toFixed(1)}m` : '---'}
                          </td>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-3 py-1 border-t border-[#22293a] text-[10px] text-slate-500 shrink-0">
        車速は km/h。進入 = ターンイン時 / ボトム = コーナー内の最低車速 / 脱出 = コーナー出口。コーナーは基準車の走行ラインの曲率から自動検出。
        ラインは基準車のアペックス位置での左右のズレ (ラップ間の GPS の位置ずれを補正済み。1 m 未満の差は参考値)
      </div>
    </div>
  );
};
