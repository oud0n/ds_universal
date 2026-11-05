import type { Lap } from '../types/telemetry';
import { sessionToLapClock } from '../utils/lapClock';
import { interpolatePoint } from '../utils/telemetrySearch';

declare const clock: unique symbol;
export type SessionSec = number & { readonly [clock]: 'session' };
export type LapSec = number & { readonly [clock]: 'lap' };

function finiteSeconds(sec: number): number {
  if (!Number.isFinite(sec)) throw new RangeError('Playback time must be finite');
  return sec;
}

export const asSessionSec = (sec: number): SessionSec => finiteSeconds(sec) as SessionSec;
export const asLapSec = (sec: number): LapSec => finiteSeconds(sec) as LapSec;

export interface PlaybackPosition {
  sessionSec: SessionSec;
  lapSec: LapSec;
  lapDistanceKm: number;
  baseLap: Lap | undefined;
  inLap: boolean;
}

/** 走行の時計はそのまま保つ。周の時計は通常、周の外で止まる。時間で比べる解析では遅い車の終点まで進める。 */
export function getPlaybackPosition(sessionSec: SessionSec, baseLap?: Lap, lapEndSec?: number): PlaybackPosition {
  const point = sessionToLapClock(sessionSec, baseLap);
  if (!baseLap || !point) {
    return { sessionSec, baseLap, lapSec: asLapSec(0), lapDistanceKm: 0, inLap: false };
  }
  const lapTime = lapEndSec === undefined ? point.time : Math.max(0, Math.min(lapEndSec, sessionSec - baseLap.startTime));
  return {
    sessionSec, baseLap, lapSec: asLapSec(lapTime), lapDistanceKm: point.distance,
    inLap: sessionSec >= baseLap.startTime && sessionSec <= baseLap.endTime,
  };
}

export function lapToSessionSec(lapSec: LapSec, baseLap: Lap): SessionSec {
  return asSessionSec(baseLap.startTime + lapSec);
}

/** 周の中の距離でシークする。範囲の外は最初または最後の記録点に寄せる。 */
export function lapDistanceToSessionSec(distanceKm: number, baseLap?: Lap): SessionSec | undefined {
  if (!baseLap) return undefined;
  const point = interpolatePoint(baseLap.points, 'distance', distanceKm);
  return point && lapToSessionSec(asLapSec(point.time), baseLap);
}
