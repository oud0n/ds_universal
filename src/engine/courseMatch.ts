import type { CircuitPreset, TelemetryPoint } from '../types/telemetry';
import { countGateCrossings, passesNearControlLine } from './lapCalculator';

export function findMatchingCourse<T extends Pick<CircuitPreset, 'centerLat' | 'centerLon' | 'controlLine'>>(presets: readonly T[], lat: number, lon: number, points?: TelemetryPoint[]): T | undefined {
  // 2. プリセットから検索
  let closest: T | undefined;
  let minDistance = 15000; // 15km以内
  const nearby: T[] = [];

  for (const circuit of presets) {
    const dLat = (circuit.centerLat - lat) * 111320;
    const dLon = (circuit.centerLon - lon) * (111320 * Math.cos((lat * Math.PI) / 180));
    const distMeters = Math.sqrt(dLat * dLat + dLon * dLon);

    if (distMeters < minDistance) {
      minDistance = distMeters;
      closest = circuit;
    }
    if (distMeters < 15000) nearby.push(circuit);
  }

  // 近くに候補が複数あるときは、実際の走行で計測線を通過しているコースを優先する
  if (points && nearby.length > 1) {
    let bestLaps = 0;
    let best: T | undefined;
    for (const circuit of nearby) {
      if (!circuit.controlLine) continue;
      // 周回の数ではなく計測線を通過した回数で比べる (通過が 1 回のログでも区別できるように)
      const count = countGateCrossings(points, circuit.controlLine);
      // 同数なら先頭位置に近い方 (closest) を残す
      if (count > bestLaps || (count === bestLaps && count > 0 && circuit === closest)) {
        bestLaps = count;
        best = circuit;
      }
    }
    if (best) return best;
  }

  // 計測線を持つコースは、ログがその線を通るか、すぐ近く (50 m 以内) まで来たときだけ使う。
  // 同じ施設の隣のコース (Willow Springs の Big Willow と Streets など) のログに、通らない計測線を当てて周回が 0 になるのを防ぐ。
  // 使わないときはコースが分からない扱いになり、走り始めに仮の計測線が置かれる
  if (points && closest?.controlLine && countGateCrossings(points, closest.controlLine) === 0 && !passesNearControlLine(points, closest.controlLine, 50)) {
    return undefined;
  }

  return closest;
}
