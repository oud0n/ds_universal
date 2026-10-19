/// <reference lib="webworker" />
/**
 * 2 つのログの比べ (clockOffsetEstimator.ts の analyseTimed) を、画面を止めずに行う。
 * 点は [t, lat, lon, speed] を並べた Float64Array で受け取る
 */
import { analyseTimed, TimedPoint } from './clockOffsetEstimator';

function unpack(a: Float64Array): TimedPoint[] {
  const out: TimedPoint[] = new Array(a.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = { t: a[i * 4], lat: a[i * 4 + 1], lon: a[i * 4 + 2], speed: a[i * 4 + 3] };
  return out;
}

self.onmessage = (e: MessageEvent<{ id: number; ref: Float64Array; other: Float64Array }>) => {
  const { id, ref, other } = e.data;
  let result = null;
  try { result = analyseTimed(unpack(ref), unpack(other)); } catch { result = null; }
  (self as unknown as Worker).postMessage({ id, result });
};
