import React, { useEffect, useMemo, useRef, useState } from 'react';
import { canvasColors, useResolvedTheme } from '../utils/theme';
import { tr, useLang, useT } from '../utils/i18n';
import { OctagonAlert } from 'lucide-react';
import { Lap, SelectedCarSlot } from '../types/telemetry';
import { useLapGeometries } from '../hooks/useLapGeometries';
import { detectBrakingZones, indexAtDistance, matchBrakingZones, matchIndex } from '../services/drivingAnalysis';

interface BrakingAnalysisWindowProps {
  cars: { slot: SelectedCarSlot; lap: Lap }[];
  currentDistance: number;
  onSeekDistance: (distKm: number) => void;
}

// グラフに表示する、制動開始の手前と制動終了の先の距離
const CHART_MARGIN_BEFORE_M = 25;
const CHART_MARGIN_AFTER_M = 25;

export const BrakingAnalysisWindow: React.FC<BrakingAnalysisWindowProps> = ({ cars, currentDistance, onSeekDistance }) => {
  const t = useT();
  // 言語を切り替えたら canvas の文字も描き直す
  const lang = useLang();
  // テーマを切り替えたら canvas を描き直す
  const theme = useResolvedTheme();
  const analysed = useLapGeometries(cars);
  const base = analysed[0];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [resizeTick, setResizeTick] = useState(0);

  const result = useMemo(() => {
    if (!base) return null;
    const baseZones = detectBrakingZones(base.geo);
    const perCar = analysed.map(car => ({
      car,
      zones: car === base ? baseZones : matchBrakingZones(base.geo, baseZones, car.geo, detectBrakingZones(car.geo))
    }));
    return { baseZones, perCar };
  }, [analysed, base]);

  // 表示領域の大きさが変わったら描き直す (グラフは制動区間があるときだけ表示される)
  const hasChart = !!result && result.baseZones.length > 0;
  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setResizeTick(t => t + 1));
    observer.observe(parent);
    return () => observer.disconnect();
  }, [hasChart]);

  // 未選択のときは、現在位置を含む (または次に来る) 制動区間を表示する
  // ログの距離欄ではなく、解析用に積算し直した距離で比べる
  const currentM = base ? base.geo.s[indexAtDistance(base.lap.points, currentDistance)] ?? 0 : 0;
  const autoIndex = result
    ? Math.max(0, result.baseZones.findIndex(z => currentM <= base!.geo.s[z.endIndex]))
    : 0;
  const zoneIndex = selected !== null && result && selected < result.baseZones.length ? selected : autoIndex;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result || !base || result.baseZones.length === 0) return;
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
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);

    const zone = result.baseZones[zoneIndex];
    const g = base.geo;
    const from = g.s[zone.onsetIndex] - CHART_MARGIN_BEFORE_M;
    const to = g.s[zone.endIndex] + CHART_MARGIN_AFTER_M;
    const pad = { l: 34, r: 8, t: 8, b: 18 };
    const maxG = 1.2;
    const xOf = (m: number) => pad.l + ((m - from) / (to - from)) * (width - pad.l - pad.r);
    const yOf = (gVal: number) => pad.t + ((maxG - gVal) / (maxG * 2)) * (height - pad.t - pad.b);

    // 目盛り
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const gv of [-1, -0.5, 0, 0.5, 1]) {
      ctx.strokeStyle = gv === 0 ? C.gridStrong : C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, yOf(gv));
      ctx.lineTo(width - pad.r, yOf(gv));
      ctx.stroke();
      ctx.fillStyle = C.axis;
      ctx.fillText(`${gv > 0 ? '+' : ''}${gv.toFixed(1)}G`, pad.l - 4, yOf(gv));
    }
    // 基準車の制動区間
    ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
    ctx.fillRect(xOf(g.s[zone.onsetIndex]), pad.t, xOf(g.s[zone.endIndex]) - xOf(g.s[zone.onsetIndex]), height - pad.t - pad.b);
    ctx.fillStyle = C.axis;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(tr('基準車の制動開始からの距離 (m)  実線: 前後G / 破線: 横G', 'Distance from the reference car\'s braking point (m)  solid: long. G / dashed: lat. G'), (pad.l + width - pad.r) / 2, height - 2);

    // 各車両の前後 G (実線) と横 G の絶対値 (破線)。横軸は基準車の位置に対応させる
    result.perCar.forEach(({ car }) => {
      const cg = car.geo;
      const start = car === base ? zone.onsetIndex : matchIndex(g, zone.onsetIndex, cg);
      if (start < 0) return;
      // 基準車の制動開始位置を 0 として、各車両の走行距離で並べる
      const offset = cg.s[start] - g.s[zone.onsetIndex];
      for (const { series, dashed } of [{ series: cg.longG, dashed: false }, { series: cg.latG, dashed: true }]) {
        ctx.strokeStyle = car.slot.colorHex;
        ctx.lineWidth = dashed ? 1 : 2;
        ctx.setLineDash(dashed ? [3, 3] : []);
        ctx.beginPath();
        let started = false;
        for (let k = 0; k < cg.s.length; k++) {
          const m = cg.s[k] - offset;
          if (m < from) continue;
          if (m > to) break;
          const v = dashed ? Math.abs(series[k]) : series[k];
          const y = yOf(Math.max(-maxG, Math.min(maxG, v)));
          if (started) ctx.lineTo(xOf(m), y);
          else { ctx.moveTo(xOf(m), y); started = true; }
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    });

    // 現在位置
    if (currentM >= from && currentM <= to) {
      ctx.strokeStyle = C.sector;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xOf(currentM), pad.t);
      ctx.lineTo(xOf(currentM), height - pad.b);
      ctx.stroke();
    }
  }, [result, base, zoneIndex, currentM, resizeTick, theme, lang]);

  if (!base || !result) {
    return <div className="h-full flex items-center justify-center text-xs text-slate-500 bg-surface-1">{t('走行データを読み込むとブレーキングの診断を表示します', 'Load driving data to see the braking analysis')}</div>;
  }
  if (result.baseZones.length === 0) {
    return <div className="h-full flex items-center justify-center text-xs text-slate-500 bg-surface-1">{t('このラップから制動区間 (0.3G 以上の減速) を検出できませんでした', 'No braking zones (deceleration of 0.3 G or more) were found in this lap')}</div>;
  }

  return (
    <div className="h-full flex flex-col bg-surface-1 text-slate-200 overflow-hidden" data-testid="braking-analysis">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-line-1 text-[11px] shrink-0">
        <span className="font-bold flex items-center gap-1.5">
          <OctagonAlert size={13} className="text-red-400" />
          {t(`ブレーキング診断 (${result.baseZones.length} 区間)`, `Braking analysis (${result.baseZones.length} zones)`)}
        </span>
        <span className="text-slate-500 truncate ml-2" title={t('GPS の車速から算出した減速 G による推定です。ブレーキ操作そのものは記録されていないため、アクセルオフによる減速と区別できない場合があります', 'Estimated from deceleration G calculated from GPS speed. Brake use itself is not recorded, so it may not be distinguishable from lifting off the throttle')}>{t('減速 G からの推定', 'Estimated from deceleration G')}</span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-[11px] font-mono border-collapse">
          <thead className="sticky top-0 bg-surface-3 text-slate-400 whitespace-nowrap">
            <tr>
              <th className="px-2 py-1 text-left font-medium">{t('区間', 'Zone')}</th>
              <th className="px-2 py-1 text-left font-medium">{t('車両', 'Car')}</th>
              <th className="px-2 py-1 text-right font-medium">{t('開始位置', 'Start')}</th>
              <th className="px-2 py-1 text-right font-medium">{t('車速 (km/h)', 'Speed (km/h)')}</th>
              <th className="px-2 py-1 text-right font-medium">{t('制動距離', 'Distance')}</th>
              <th className="px-2 py-1 text-right font-medium" title={t('最大減速 G / 区間平均', 'Peak deceleration G / zone average')}>{t('最大G / 平均', 'Peak G / avg')}</th>
              <th className="px-2 py-1 text-right font-medium" title={t('踏み始めから最大減速の 80% に達するまでの時間と、その間の増加率', 'Time from the start of braking to 80% of peak deceleration, and the rate of increase')}>{t('立ち上がり', 'Build-up')}</th>
              <th className="px-2 py-1 text-right font-medium" title={t('最大減速の 80% を下回ってから制動が終わるまでの時間と、その間の減速 G の最大変化率 (小さいほど滑らか)', 'Time from dropping below 80% of peak deceleration to the end of braking, and the largest rate of change of deceleration G (smaller is smoother)')}>{t('リリース', 'Release')}</th>
              <th className="px-2 py-1 text-right font-medium" title={t('横 G が 0.3G 以上出ている状態で制動している時間と、その間の最大横 G', 'Time spent braking with 0.3 G or more lateral G, and the peak lateral G during it')}>{t('トレイル', 'Trail')}</th>
            </tr>
          </thead>
          <tbody>
            {result.baseZones.map((bz, i) => result.perCar.map(({ car, zones }, ci) => {
              const z = zones[i];
              return (
                <tr
                  key={`${i}-${car.slot.slot}`}
                  onClick={() => { setSelected(i); onSeekDistance(base.lap.points[bz.onsetIndex].distance); }}
                  className={`cursor-pointer hover:bg-surface-4 ${ci === 0 ? 'border-t border-line-2' : ''} ${i === zoneIndex ? 'bg-surface-4' : ''}`}
                >
                  <td className="px-2 py-1 font-bold text-slate-100">{ci === 0 ? `B${bz.number}` : ''}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: car.slot.colorHex }} />
                    Car {car.slot.slot + 1}
                  </td>
                  {z ? (
                    <>
                      <td className="px-2 py-1 text-right">{z.onsetDistanceM.toFixed(0)}m</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">{z.startSpeed.toFixed(0)} → {z.endSpeed.toFixed(0)}</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">{z.distanceM.toFixed(0)}m / {z.durationS.toFixed(2)}s</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap"><span className="font-bold">{z.peakG.toFixed(2)}</span> / {z.averageG.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">{z.buildUpS.toFixed(2)}s ({z.buildUpRate.toFixed(1)}G/s)</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">{z.releaseS.toFixed(2)}s ({z.releaseMaxRate.toFixed(1)}G/s)</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">{z.trailS > 0 ? `${z.trailS.toFixed(2)}s (${t('横', 'lat ')}${z.trailMaxLatG.toFixed(2)}G)` : t('なし', 'none')}</td>
                    </>
                  ) : (
                    <td colSpan={7} className="px-2 py-1 text-center text-slate-600">{t('この位置での制動なし', 'No braking here')}</td>
                  )}
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>

      <div className="h-[38%] min-h-[90px] border-t border-line-1 shrink-0">
        <canvas ref={canvasRef} className="block w-full h-full" />
      </div>
    </div>
  );
};
