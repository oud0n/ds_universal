import { TelemetryPoint } from '../types/telemetry';

/**
 * 距離(km)に最も近いテレメトリポイントを二分探索 (O(log N)) で高速取得
 */
export function findClosestPointByDistance(
  points: TelemetryPoint[],
  targetDistanceKm: number
): TelemetryPoint | undefined {
  if (!points || points.length === 0) return undefined;
  if (points.length === 1) return points[0];

  let low = 0;
  let high = points.length - 1;

  if (targetDistanceKm <= points[0].distance) return points[0];
  if (targetDistanceKm >= points[high].distance) return points[high];

  while (low <= high) {
    const mid = (low + high) >> 1;
    const midDist = points[mid].distance;

    if (midDist === targetDistanceKm) {
      return points[mid];
    } else if (midDist < targetDistanceKm) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const p1 = points[Math.max(0, high)];
  const p2 = points[Math.min(points.length - 1, low)];
  return Math.abs(p1.distance - targetDistanceKm) <= Math.abs(p2.distance - targetDistanceKm)
    ? p1
    : p2;
}

/**
 * 経過時間(秒)に最も近いテレメトリポイントを二分探索 (O(log N)) で高速取得
 */
export function findClosestPointByTime(
  points: TelemetryPoint[],
  targetTimeSec: number
): TelemetryPoint | undefined {
  if (!points || points.length === 0) return undefined;
  if (points.length === 1) return points[0];

  let low = 0;
  let high = points.length - 1;

  if (targetTimeSec <= points[0].time) return points[0];
  if (targetTimeSec >= points[high].time) return points[high];

  while (low <= high) {
    const mid = (low + high) >> 1;
    const midTime = points[mid].time;

    if (midTime === targetTimeSec) {
      return points[mid];
    } else if (midTime < targetTimeSec) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const p1 = points[Math.max(0, high)];
  const p2 = points[Math.min(points.length - 1, low)];
  return Math.abs(p1.time - targetTimeSec) <= Math.abs(p2.time - targetTimeSec) ? p1 : p2;
}
