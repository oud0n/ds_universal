import { describe, expect, it } from 'vitest';
import { liveDelta, mapLap } from './overlayParts';
import type { Lap, Session, TelemetryPoint } from '../types/telemetry';

/** 周の点 (周の始めを 0 とした時刻と距離。extractLaps と同じ形)。速さ v (km/s) で直線を走る */
function lapOf(n: number, startTime: number, lapTime: number, lengthKm: number, opts: { jumpAt?: number } = {}): Lap {
  const points: TelemetryPoint[] = [];
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const d = lengthKm * f;
    // 緯度を距離ぶん進める (1 km ≒ 0.009 度)。jumpAt の点だけ 100 m 飛ばす (GPS の途切れ)
    const lat = 35 + d * 0.009 + (opts.jumpAt === i ? 0.0009 : 0);
    points.push({ index: i, time: lapTime * f, latitude: lat, longitude: 140, altitude: 0, speed: 100, heading: 0, distance: d, accelG: 0, corneringG: 0, combinedG: 0, turningRadius: 0, driftAngle: 0 });
  }
  return { lapNumber: n, lapTime, startTime, endTime: startTime + lapTime, startIndex: 0, endIndex: steps, distance: lengthKm, topSpeed: 100, bottomSpeed: 100, avgSpeed: 100, sectors: [], points };
}

function sessionOf(laps: Lap[], bestLapIndex: number): Session {
  return { id: 's', fileName: 'x', sessionName: 'x', date: '', circuitName: '', samplingRate: 20, totalDistance: 0, points: [], laps, bestLapIndex, theoreticalBestTime: 0, sectors: [] };
}

describe('overlayParts', () => {
  it('タイム差: 同じ距離を走ったときの経過時間の差 (周の点は周の始めを 0 とした時刻・距離)', () => {
    const ref = lapOf(1, 100, 60, 2);
    const slow = lapOf(2, 200, 66, 2);
    // 遅い周の半分 (33 秒) では、基準は同じ距離を 30 秒で走っている
    expect(liveDelta(slow, 200 + 33, ref)).toBeCloseTo(3, 1);
    // 周の終わりでは、周のタイムの差
    expect(liveDelta(slow, 200 + 66, ref)).toBeCloseTo(6, 1);
  });

  it('コース図の周: GPS が途切れた周・長さが違う周は使わず、残りでいちばん速い周', () => {
    const fastButGap = lapOf(1, 0, 58, 2, { jumpAt: 100 });
    const pitThrough = lapOf(2, 60, 57, 2.4);
    const clean = lapOf(3, 120, 60, 2);
    const s = sessionOf([fastButGap, pitThrough, clean], 1);
    expect(mapLap(s)?.lapNumber).toBe(3);
  });
});
