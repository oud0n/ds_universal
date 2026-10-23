import React, { useMemo } from 'react';
import { CornerDownRight } from 'lucide-react';
import { Lap, SelectedCarSlot } from '../types/telemetry';
import { useLapGeometries } from '../hooks/useLapGeometries';
import { useT } from '../utils/i18n';
import { cornerLabel, useNamedCorners } from '../hooks/useNamedCorners';
import { computeCorrectedLineDelta, indexAtDistance, insideOutside, matchIndex, measureCorners } from '../services/drivingAnalysis';

interface CornerAnalysisWindowProps {
  cars: { slot: SelectedCarSlot; lap: Lap }[];
  currentDistance: number;
  onSeekDistance: (distKm: number) => void;
  /** Car 1 のコースの名前 (コーナーの名前を、コースのフォルダの corners.json から出す) */
  circuitName?: string;
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

export const CornerAnalysisWindow: React.FC<CornerAnalysisWindowProps> = ({ cars, currentDistance, onSeekDistance, circuitName }) => {
  const t = useT();
  const analysed = useLapGeometries(cars);
  const base = analysed[0];
  const { corners } = useNamedCorners(base?.geo, circuitName);

  const result = useMemo(() => {
    if (!base) return null;
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
  }, [analysed, base, corners]);

  if (!base || !result) {
    return <div className="h-full flex items-center justify-center text-xs text-slate-500 bg-surface-1">{t('走行データを読み込むとコーナー別の速度を表示します', 'Load driving data to see speeds for each corner')}</div>;
  }
  if (result.corners.length === 0) {
    return <div className="h-full flex items-center justify-center text-xs text-slate-500 bg-surface-1">{t('このラップからコーナーを検出できませんでした', 'No corners were found in this lap')}</div>;
  }

  // 現在位置は、ログの距離欄ではなく解析用に積算し直した距離で比べる (両者の尺度が違う場合があるため)
  const currentM = base.geo.s[indexAtDistance(base.lap.points, currentDistance)] ?? 0;
  const baseMetrics = result.perCar[0].metrics;

  return (
    <div className="h-full flex flex-col bg-surface-1 text-slate-200 overflow-hidden" data-testid="corner-analysis">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-line-1 text-[11px] shrink-0">
        <span className="font-bold flex items-center gap-1.5">
          <CornerDownRight size={13} className="text-amber-400" />
          {t(`コーナー別速度 (${result.corners.length} コーナー)`, `Corner speeds (${result.corners.length} corner${(result.corners.length) === 1 ? '' : 's'})`)}
        </span>
        <span className="text-slate-500 truncate ml-2">{t('行クリックで移動 / 差は Car 1 比', 'Click a row to jump / differences vs Car 1')}</span>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] font-mono border-collapse">
          <thead className="sticky top-0 bg-surface-3 text-slate-400 whitespace-nowrap">
            <tr>
              <th className="px-2 py-1 text-left font-medium" rowSpan={2}>{t('コーナー', 'Corner')}</th>
              <th className="px-2 py-1 text-right font-medium" rowSpan={2}>{t('最小R', 'Min R')}</th>
              {result.perCar.map(({ car }) => (
                <th key={car.slot.slot} className="px-2 py-1 text-center font-medium border-l border-line-2" colSpan={car === base ? 3 : 4}>
                  <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: car.slot.colorHex }} />
                  Car {car.slot.slot + 1} (L{car.lap.lapNumber})
                </th>
              ))}
            </tr>
            <tr>
              {result.perCar.map(({ car }) => (
                <React.Fragment key={car.slot.slot}>
                  <th className="px-2 py-1 text-right font-medium border-l border-line-2">{t('進入', 'Entry')}</th>
                  <th className="px-2 py-1 text-right font-medium">{t('ボトム', 'Min')}</th>
                  <th className="px-2 py-1 text-right font-medium">{t('脱出', 'Exit')}</th>
                  {car !== base && <th className="px-2 py-1 text-right font-medium">{t('ライン', 'Line')}</th>}
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
                  className={`cursor-pointer border-t border-line-1 hover:bg-surface-4 ${active ? 'bg-surface-4' : ''}`}
                >
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className="font-bold text-slate-100">{cornerLabel(c)}</span>
                    <span className={`ml-1.5 ${c.direction === 'R' ? 'text-sky-400' : 'text-amber-400'}`}>{c.direction === 'R' ? t('右', 'R') : t('左', 'L')}</span>
                    <span className="ml-1.5 text-slate-500">{c.headingChangeDeg.toFixed(0)}°</span>
                  </td>
                  <td className="px-2 py-1 text-right text-slate-400">{c.minRadiusM.toFixed(0)}m</td>
                  {result.perCar.map(({ car, metrics, apexOffsets }) => {
                    const m = metrics[i];
                    const b = baseMetrics[i];
                    if (!m || !b) {
                      return <td key={car.slot.slot} colSpan={car === base ? 3 : 4} className="px-2 py-1 text-center text-slate-600 border-l border-line-2">{t('対応区間なし', 'No matching section')}</td>;
                    }
                    const off = apexOffsets[i];
                    return (
                      <React.Fragment key={car.slot.slot}>
                        <td className="px-2 py-1 text-right border-l border-line-2 whitespace-nowrap">{m.entrySpeed.toFixed(1)}{car !== base && <Diff value={m.entrySpeed - b.entrySpeed} />}</td>
                        <td className="px-2 py-1 text-right font-bold whitespace-nowrap">{m.bottomSpeed.toFixed(1)}{car !== base && <Diff value={m.bottomSpeed - b.bottomSpeed} />}</td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">{m.exitSpeed.toFixed(1)}{car !== base && <Diff value={m.exitSpeed - b.exitSpeed} />}</td>
                        {car !== base && (
                          <td className="px-2 py-1 text-right whitespace-nowrap text-slate-300">
                            {off ? `${off.side === 'IN' ? t('イン', 'In') : off.side === 'OUT' ? t('アウト', 'Out') : ''} ${Math.abs(off.offsetM).toFixed(1)}m` : '---'}
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

      <div className="px-3 py-1 border-t border-line-1 text-[10px] text-slate-500 shrink-0">
        {t('車速は km/h。進入 = ターンイン時 / ボトム = コーナー内の最低車速 / 脱出 = コーナー出口。コーナーは基準車の走行ラインの曲率から自動検出。 ラインは基準車のアペックス位置での左右のズレ (ラップ間の GPS の位置ずれを補正済み。1 m 未満の差は参考値)',
          'Speeds in km/h. Entry = at turn-in / Min = lowest speed in the corner / Exit = corner exit. Corners are detected automatically from the curvature of the reference car\'s line. Line = left/right offset at the reference car\'s apex (GPS offset between laps corrected; differences under 1 m are indicative only)')}
      </div>
    </div>
  );
};
