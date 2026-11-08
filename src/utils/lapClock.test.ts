import { describe, it, expect } from 'vitest';
import { sessionToLapClock } from './lapClock';
import type { TelemetryPoint } from '../types/telemetry';

const pt = (time: number, distance: number) => ({ time, distance }) as unknown as TelemetryPoint;
const lap = { startTime: 100, points: [pt(0, 0), pt(10, 0.5), pt(20, 1.0)] };

describe('sessionToLapClock', () => {
  it('走行全体の時刻を周の中の時刻と距離にする', () => {
    expect(sessionToLapClock(105, lap)).toEqual({ time: 5, distance: 0.25 });
  });
  it('周の外は始め・終わりに寄せる', () => {
    expect(sessionToLapClock(50, lap)).toEqual({ time: 0, distance: 0 });
    expect(sessionToLapClock(500, lap)).toEqual({ time: 20, distance: 1.0 });
  });
  it('周が無ければ null', () => {
    expect(sessionToLapClock(5, undefined)).toBeNull();
    expect(sessionToLapClock(5, { startTime: 0, points: [] })).toBeNull();
  });
});
