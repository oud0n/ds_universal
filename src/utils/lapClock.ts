import type { TelemetryPoint } from '../types/telemetry';
import { interpolatePoint } from './telemetrySearch';

/**
 * 走行全体の時刻 (動画の画面の時計) を、周の中の時刻と距離に読み替える。
 * コース図などの周を前提にした窓へ渡すため (BUG-43)。周の外の時刻は周の始め・終わりに寄せる
 */
export function sessionToLapClock(
  sessionTimeSec: number,
  lap: { startTime: number; points?: TelemetryPoint[] } | undefined
): { time: number; distance: number } | null {
  const pts = lap?.points;
  if (!lap || !pts || pts.length === 0) return null;
  const end = pts[pts.length - 1].time;
  const time = Math.max(0, Math.min(end, sessionTimeSec - lap.startTime));
  const p = interpolatePoint(pts, 'time', time);
  return { time, distance: p?.distance ?? 0 };
}
