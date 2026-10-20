import { describe, expect, it } from 'vitest';
import { extractLaps } from './lapCalculator';
import type { ControlLine, Sector, TelemetryPoint } from '../types/telemetry';

/** 東西の線 (経度 140.000〜140.001、緯度 lat) */
const line = (lat: number, name = 'L'): ControlLine => ({ name, latA: lat, lonA: 139.9995, latB: lat, lonB: 140.0005 });
const START = line(35.0, 'Start');
const FINISH = line(35.005, 'Finish');
const M_PER_DEG_LAT = 111320;

/**
 * 南から北へ 20 m/s で走り、スタート (35.000) とゴール (35.005) を通る。
 * 戻りは東へ 0.01 度ずらした道を南へ走るので、線は通らない。これを runs 回くり返す
 */
function makeRuns(runs: number, abortFirst = false): TelemetryPoint[] {
  const pts: TelemetryPoint[] = [];
  let t = 0;
  let dist = 0;
  let prev: [number, number] | null = null;
  const push = (lat: number, lon: number) => {
    if (prev) dist += Math.hypot((lat - prev[0]) * M_PER_DEG_LAT, (lon - prev[1]) * M_PER_DEG_LAT * Math.cos(35 * Math.PI / 180)) / 1000;
    prev = [lat, lon];
    pts.push({ index: pts.length, time: Number(t.toFixed(2)), latitude: lat, longitude: lon, altitude: 0, speed: 72, heading: 0, distance: dist, accelG: 0, corneringG: 0, combinedG: 0, turningRadius: 9999, driftAngle: 0 } as TelemetryPoint);
    t += 0.1;
  };
  const step = 2 / M_PER_DEG_LAT; // 0.1 秒で 2 m
  for (let r = 0; r < runs; r++) {
    // 1 本目をやめるときは、ゴールの手前 (35.003) で東へ逸れて戻る
    const top = abortFirst && r === 0 ? 35.003 : 35.006;
    for (let lat = 34.999; lat <= top; lat += step) push(lat, 140.0);
    for (let k = 0; k < 50; k++) push(top, 140.0 + (k / 50) * 0.01);
    for (let lat = top; lat >= 34.999; lat -= step) push(lat, 140.01);
    for (let k = 0; k < 50; k++) push(34.999, 140.01 - (k / 50) * 0.01);
  }
  return pts;
}

describe('スタートとゴールが別のコース (ジムカーナ・ヒルクライム)', () => {
  it('スタートからゴールまでを 1 本として数える', () => {
    const { laps } = extractLaps(makeRuns(2), START, [], FINISH);
    const full = laps.filter(l => !l.isWholeSession && !l.isPartialLap);
    expect(full.length).toBe(2);
    // 2 つの線の間は 0.005 度 (約 557 m)。20 m/s で約 27.8 秒
    const expected = (0.005 * M_PER_DEG_LAT) / 20;
    full.forEach(l => expect(l.lapTime).toBeCloseTo(expected, 0));
    full.forEach(l => expect(l.distance).toBeCloseTo(0.005 * M_PER_DEG_LAT / 1000, 1));
  });

  it('途中のセクター線と、ゴールまでの最後のセクターを数える', () => {
    const mid: Sector = { ...line(35.0025), id: 's1', name: 'S1' };
    const { laps, sectors } = extractLaps(makeRuns(1), START, [mid], FINISH);
    const lap = laps.find(l => !l.isWholeSession)!;
    expect(sectors.map(x => x.name)).toEqual(['S1', 'S2']);
    expect(lap.sectors.length).toBe(2);
    expect(lap.sectors.every(s => !s.isEstimated)).toBe(true);
    expect(lap.sectors[0].time + lap.sectors[1].time).toBeCloseTo(lap.lapTime, 1);
  });

  it('ゴールまで行かずに次のスタートを通った本は数えない', () => {
    // 1 本目はゴールの手前で逸れて戻る (スタートだけ通る)
    const { laps } = extractLaps(makeRuns(2, true), START, [], FINISH);
    expect(laps.filter(l => !l.isWholeSession).length).toBe(1);
  });

  it('ゴールの線が無ければ、これまでどおり計測線から計測線まで', () => {
    const { laps } = extractLaps(makeRuns(3), START, []);
    // スタートの線を 3 回通る → 2 周
    expect(laps.filter(l => !l.isWholeSession && !l.isPartialLap).length).toBe(2);
  });
});
