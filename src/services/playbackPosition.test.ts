import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Lap, TelemetryPoint } from '../types/telemetry';
import {
  asLapSec, asSessionSec, getPlaybackPosition, lapDistanceToSessionSec, lapToSessionSec,
  type LapSec, type SessionSec,
} from './playbackPosition';

function sample(time: number, distance: number): TelemetryPoint {
  return { index: 0, time, distance, latitude: 0, longitude: 0, altitude: 0, speed: 0, heading: 0,
    accelG: 0, corneringG: 0, combinedG: 0, turningRadius: 0, driftAngle: 0 };
}

// 走行の 100 秒後に始まる周。後半の方が速いので距離と時刻は単純な比にならない。
const lap: Lap = {
  lapNumber: 2, startTime: 100, endTime: 120, lapTime: 20, startIndex: 40, endIndex: 42,
  distance: 1, topSpeed: 0, bottomSpeed: 0, avgSpeed: 0, sectors: [],
  points: [sample(0, 0), sample(10, 0.25), sample(20, 1)],
};

describe('再生位置', () => {
  it('走行の秒と周の秒は取り違えられない', () => {
    expectTypeOf<SessionSec>().not.toExtend<LapSec>();
    expectTypeOf<LapSec>().not.toExtend<SessionSec>();
  });

  it('有限でない時刻は時計に入れない', () => {
    expect(() => asSessionSec(NaN)).toThrow(RangeError);
    expect(() => asLapSec(Infinity)).toThrow(RangeError);
  });

  it('ログより先に始まった動画の時刻を保つ', () => {
    expect(getPlaybackPosition(asSessionSec(-5), lap)).toMatchObject({
      sessionSec: -5, lapSec: 0, lapDistanceKm: 0, inLap: false,
    });
  });

  it('走行の時計を保ち、選んだ周の中で時刻と距離を補間する', () => {
    const position = getPlaybackPosition(asSessionSec(115), lap);
    expect(position).toEqual({ sessionSec: 115, lapSec: 15, lapDistanceKm: 0.625, baseLap: lap, inLap: true });
    expect(lapDistanceToSessionSec(position.lapDistanceKm, lap)).toBe(115);
    expect(lapToSessionSec(position.lapSec, lap)).toBe(115);
  });

  it.each([
    [90, 0, 0, false], [100, 0, 0, true], [120, 20, 1, true], [130, 20, 1, false],
  ] as const)('走行 %i 秒で周の境界とその外を区別する', (sessionTime, lapTime, distance, inLap) => {
    expect(getPlaybackPosition(asSessionSec(sessionTime), lap)).toMatchObject({
      sessionSec: sessionTime, lapSec: lapTime, lapDistanceKm: distance, inLap,
    });
  });

  it('時間比較で基準車が終わったあとも、比較車の時計は進む', () => {
    expect(getPlaybackPosition(asSessionSec(128), lap, 32)).toMatchObject({
      sessionSec: 128, lapSec: 28, lapDistanceKm: 1, inLap: false,
    });
    expect(getPlaybackPosition(asSessionSec(145), lap, 32).lapSec).toBe(32);
    expect(lapToSessionSec(asLapSec(28), lap)).toBe(128);
  });

  it('周未選択や点のない走行は、動画の時計だけを進められる', () => {
    for (const baseLap of [undefined, { ...lap, points: [] }]) {
      expect(getPlaybackPosition(asSessionSec(115), baseLap)).toEqual({
        sessionSec: 115, lapSec: 0, lapDistanceKm: 0, inLap: false, baseLap,
      });
      expect(lapDistanceToSessionSec(0, baseLap)).toBeUndefined();
    }
  });

  it('距離のシークは、選んだ周の始点と終点までに収める', () => {
    expect(lapDistanceToSessionSec(-1, lap)).toBe(100);
    expect(lapDistanceToSessionSec(3, lap)).toBe(120);
    const laterLap = { ...lap, lapNumber: 3, startTime: 120, endTime: 140 };
    expect(lapDistanceToSessionSec(0.625, laterLap)).toBe(135);
  });
});
