/**
 * ラップタイマーの測位を、ファイルの形にする (2026-10-20)。
 * - NMEA 0183 (GGA + RMC): いちばん多くのソフトが読める。ゆくゆくはこれに一本化するか、設定で選べるようにする
 * - .bon4: デジスパイスの生ログの形 (先頭 8 バイトのあとに 26 バイトの点が並ぶ)。このアプリの読み込み (rawBinaryParser.ts) と同じ並びで書く。
 *   先頭の 8 バイトは、最初の点の速度・緯度・経度から求める確かめの値 (bon4Header)。実際のログ 4 つで一致を確かめた
 * どちらも、まとめて作ることも、走っている間に後ろへ足していくこともできる
 */

import { convertToNmea, type ConvertedPoint } from './logConverter';
import type { LiveFix } from './liveLapTimer';
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

const BON4_HEADER = 8;
const BON4_RECORD = 26;

/** .bon4 の点に書く生の値 (書く点と先頭の値で同じものを使う) */
function rawOf(f: LiveFix): { speed: number; lat: number; lon: number } {
  return {
    speed: Math.max(0, Math.min(0xffff, Math.round((f.speedKmh / 3.6) * 100))),
    lat: Math.round(f.latitude * 1e7),
    lon: Math.round(f.longitude * 1e7)
  };
}

/**
 * .bon4 の先頭 8 バイト: 最初の点から求める確かめの値 (float64)。
 * 5.83579 × (緯度 × −3.9825) × (経度 + 130.6307) + 速度の生の値 (0.01 m/s)。緯度・経度は点に書く int32 ÷ 10,000,000。
 * これが合わないファイルは、デジスパイスのログとして扱われないことがある (実際のログ 4 つで、この式と先頭の値が一致した)
 */
export function bon4Header(first: LiveFix | null): Uint8Array {
  const out = new Uint8Array(BON4_HEADER);
  if (!first) return out;
  const r = rawOf(first);
  const value = 5.83579 * ((r.lat / 1e7) * -3.9825) * (r.lon / 1e7 + 130.6307) + r.speed;
  new DataView(out.buffer).setFloat64(0, value, true);
  return out;
}

/** .bon4 の点の並び (rawBinaryParser.ts の読み方と同じ) */
export function bon4Records(fixes: LiveFix[]): Uint8Array {
  const out = new Uint8Array(fixes.length * BON4_RECORD);
  const v = new DataView(out.buffer);
  fixes.forEach((f, i) => {
    const o = i * BON4_RECORD;
    const d = new Date(f.tMs);
    const r = rawOf(f);
    // 実際のログでは、どの点もここは 0x2085 と 0x00C0 だった
    v.setUint16(o, 0x2085, true);
    v.setUint16(o + 2, r.speed, true);
    v.setInt32(o + 4, r.lat, true);
    v.setInt32(o + 8, r.lon, true);
    v.setInt32(o + 12, f.altitude !== undefined && Number.isFinite(f.altitude) ? Math.round(f.altitude * 10) : 0, true);
    v.setUint16(o + 16, 0x00c0, true);
    v.setUint16(o + 18, d.getUTCFullYear(), true);
    v.setUint8(o + 20, d.getUTCMonth() + 1);
    v.setUint8(o + 21, d.getUTCDate());
    v.setUint8(o + 22, d.getUTCHours());
    v.setUint8(o + 23, d.getUTCMinutes());
    v.setUint8(o + 24, d.getUTCSeconds());
    // 1/100 秒。99 は印に使われる値なので書かない (98 まで)
    v.setUint8(o + 25, Math.min(98, Math.round(d.getUTCMilliseconds() / 10)));
  });
  return out;
}

/** .bon4 のファイル全体 */
export function fixesToBon4(fixes: LiveFix[]): Uint8Array {
  const head = bon4Header(fixes[0] ?? null);
  const body = bon4Records(fixes);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** ファイルの名前 (拡張子なし)。デジスパイスの生ログと同じく、走り始めの時刻 (端末の時刻) の YYYYMMDDhhmmss */
export function runFileBase(startedMs: number): string {
  const d = new Date(startedMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
