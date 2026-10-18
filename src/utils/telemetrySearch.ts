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

/**
 * 時間または距離の値で、前後の点の間を線形補間した点を返す (二分探索 O(log N))。
 * 記録点に吸い付かせると、記録レートより細かいコマで再生したときに位置がカクつき、
 * 車両ごとに進むコマがずれて前後にぶれて見えるため、表示用の位置はこちらで求める
 */
export function interpolatePoint(
  points: TelemetryPoint[],
  key: 'time' | 'distance',
  value: number
): TelemetryPoint | undefined {
  if (!points || points.length === 0) return undefined;
  const n = points.length;
  if (n === 1 || value <= points[0][key]) return points[0];
  if (value >= points[n - 1][key]) return points[n - 1];

  // points[lo][key] <= value < points[lo + 1][key] となる lo を探す
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][key] <= value) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b[key] - a[key];
  if (span <= 0) return a;
  const r = (value - a[key]) / span;
  const lerp = (x: number, y: number) => x + (y - x) * r;
  // 進行方向は 0/360 度をまたぐので、近い向きに回して補間する
  let dh = b.heading - a.heading;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  return {
    ...a,
    time: lerp(a.time, b.time),
    distance: lerp(a.distance, b.distance),
    latitude: lerp(a.latitude, b.latitude),
    longitude: lerp(a.longitude, b.longitude),
    altitude: lerp(a.altitude, b.altitude),
    altitudeMissing: a.altitudeMissing || b.altitudeMissing ? true : undefined,
    speed: lerp(a.speed, b.speed),
    heading: (a.heading + dh * r + 360) % 360,
    // G も記録点の間で補間する (手前の点の値のままだと、記録の間隔ごとに段差で跳ぶ)
    accelG: lerp(a.accelG, b.accelG),
    corneringG: lerp(a.corneringG, b.corneringG),
    combinedG: lerp(a.combinedG, b.combinedG)
  };
}

/**
 * 比べる基準に合わせて、各車両の現在の位置を取る (前後の点の間を補間)。
 * 距離基準では基準車と同じ距離の位置、時間基準では周の開始からの経過時間が同じ位置
 */
export function findCarPoint(
  points: TelemetryPoint[],
  axis: 'distance' | 'time',
  distanceKm: number,
  timeSec: number
): TelemetryPoint | undefined {
  return interpolatePoint(points, axis, axis === 'time' ? timeSec : distanceKm);
}
