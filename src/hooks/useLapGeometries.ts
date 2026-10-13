import { useMemo } from 'react';
import { Lap, SelectedCarSlot } from '../types/telemetry';
import { buildLapGeometry, LapGeometry, originOf } from '../services/drivingAnalysis';

export interface AnalysisCar {
  slot: SelectedCarSlot;
  lap: Lap;
  geo: LapGeometry;
}

/**
 * 選択中の各車両 (最大 4 台) のラップを、基準車 (先頭) と同じ平面座標へ投影した解析用データを返す。
 * ラップの中身が変わらない限り再計算しない
 */
export function useLapGeometries(cars: { slot: SelectedCarSlot; lap: Lap }[]): AnalysisCar[] {
  const l0 = cars[0]?.lap;
  const l1 = cars[1]?.lap;
  const l2 = cars[2]?.lap;
  const l3 = cars[3]?.lap;
  const geos = useMemo(() => {
    const laps = [l0, l1, l2, l3].filter((l): l is Lap => !!l && l.points.length > 1);
    if (laps.length === 0 || laps[0] !== l0) return [];
    const origin = originOf(laps[0]);
    return laps.map(l => buildLapGeometry(l, origin));
  }, [l0, l1, l2, l3]);

  const s0 = cars[0]?.slot;
  const s1 = cars[1]?.slot;
  const s2 = cars[2]?.slot;
  const s3 = cars[3]?.slot;
  // 再生中は毎フレーム再描画されるため、結果の配列も同じものを返す (利用側の useMemo を無駄に再計算させない)
  return useMemo(() => {
    const slots = [s0, s1, s2, s3];
    const laps = [l0, l1, l2, l3];
    const out: AnalysisCar[] = [];
    for (let i = 0; i < 4; i++) {
      const geo = geos.find(g => g.lap === laps[i]);
      if (slots[i] && laps[i] && geo) out.push({ slot: slots[i]!, lap: laps[i]!, geo });
    }
    return out;
  }, [geos, s0, s1, s2, s3, l0, l1, l2, l3]);
}
