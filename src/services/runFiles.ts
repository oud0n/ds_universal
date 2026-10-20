/**
 * ラップタイマーの測位を、ファイルの形にする (2026-10-20)。
 * - NMEA 0183 (GGA + RMC): いちばん多くのソフトが読める。ゆくゆくはこれに一本化するか、設定で選べるようにする
 * - .bon4: デジスパイスの生ログの形 (先頭 8 バイトのあとに 26 バイトの点が並ぶ)。このアプリの読み込み (rawBinaryParser.ts) と同じ並びで書く。
 *   先頭の 8 バイトは、最初の点の速度・緯度・経度から求める確かめの値 (bon4Header)。実際のログ 4 つで一致を確かめた
 * どちらも、まとめて作ることも、走っている間に後ろへ足していくこともできる
 */

import { convertToNmea, type ConvertedPoint } from './logConverter';
import type { LiveFix } from './liveLapTimer';
import { toBon4 } from './bon4Writer';
import type { TelemetryPoint } from '../types/telemetry';

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * cosLat * 111.32, (lat2 - lat1) * 111.32);
}

/** 測位を、書き出しの形 (logConverter) にする。方位は前後の測位から求める */
export function toConvertedPoints(fixes: LiveFix[], prev: LiveFix | null = null): ConvertedPoint[] {
  const out: ConvertedPoint[] = [];
  let dist = 0;
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    const before = i > 0 ? fixes[i - 1] : prev;
    if (before) dist += distanceKm(before.latitude, before.longitude, f.latitude, f.longitude);
    const from = before ?? f;
    const to = fixes[i + 1] ?? f;
    const dLon = (to.longitude - from.longitude) * Math.cos((f.latitude * Math.PI) / 180);
    const dLat = to.latitude - from.latitude;
    const heading = dLon === 0 && dLat === 0 ? 0 : ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
    out.push({
      time: new Date(f.tMs),
      elapsed: (f.tMs - (fixes[0]?.tMs ?? f.tMs)) / 1000,
      latitude: f.latitude,
      longitude: f.longitude,
      altitude: f.altitude ?? null,
      speed: f.speedKmh,
      heading,
      satellites: null,
      distance: dist,
      source: undefined as unknown as TelemetryPoint
    });
  }
  return out;
}

/** NMEA の文 (まとめて作るときも、後ろへ足すときも同じ。prev は前の塊の最後の測位で、方位を続けるため) */
export function fixesToNmea(fixes: LiveFix[], prev: LiveFix | null = null): string {
  return convertToNmea(toConvertedPoints(fixes, prev));
}

/** .bon4 は変換の画面と同じもの (bon4Writer.ts) で書く */
export { bon4Header, bon4Records } from './bon4Writer';

/** .bon4 のファイル全体 */
export function fixesToBon4(fixes: LiveFix[]): Uint8Array {
  return toBon4(fixes);
}

/** ファイルの名前 (拡張子なし)。デジスパイスの生ログと同じく、走り始めの時刻 (端末の時刻) の YYYYMMDDhhmmss */
export function runFileBase(startedMs: number): string {
  const d = new Date(startedMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
