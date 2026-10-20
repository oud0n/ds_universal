/**
 * デジスパイスの生ログ (.bon4) を書く (2026-10-20)。読み方は rawBinaryParser.ts と同じ並び:
 * 先頭 8 バイトのあとに、1 点 26 バイトの記録が並ぶ。
 * 先頭の 8 バイトは、最初の点の速度・緯度・経度から求める確かめの値 (bon4Header)。実際のログ 4 つで一致を確かめた
 */

/** .bon4 に書く 1 点 (時刻は UTC のミリ秒) */
export interface Bon4Fix {
  tMs: number;
  latitude: number;
  longitude: number;
  speedKmh: number;
  /** 標高 (m)。無ければ 0 を書く */
  altitude?: number | null;
}

const HEADER = 8;
const RECORD = 26;

/** .bon4 の点に書く生の値 (書く点と先頭の値で同じものを使う) */
function rawOf(f: Bon4Fix): { speed: number; lat: number; lon: number } {
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
export function bon4Header(first: Bon4Fix | null): Uint8Array {
  const out = new Uint8Array(HEADER);
  if (!first) return out;
  const r = rawOf(first);
  const value = 5.83579 * ((r.lat / 1e7) * -3.9825) * (r.lon / 1e7 + 130.6307) + r.speed;
  new DataView(out.buffer).setFloat64(0, value, true);
  return out;
}

/** .bon4 の点の並び (rawBinaryParser.ts の読み方と同じ) */
export function bon4Records(fixes: Bon4Fix[]): Uint8Array {
  const out = new Uint8Array(fixes.length * RECORD);
  const v = new DataView(out.buffer);
  fixes.forEach((f, i) => {
    const o = i * RECORD;
    const d = new Date(f.tMs);
    const r = rawOf(f);
    // 実際のログでは、どの点もここは 0x2085 と 0x00C0 だった
    v.setUint16(o, 0x2085, true);
    v.setUint16(o + 2, r.speed, true);
    v.setInt32(o + 4, r.lat, true);
    v.setInt32(o + 8, r.lon, true);
    v.setInt32(o + 12, f.altitude != null && Number.isFinite(f.altitude) ? Math.round(f.altitude * 10) : 0, true);
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
export function toBon4(fixes: Bon4Fix[]): Uint8Array {
  const head = bon4Header(fixes[0] ?? null);
  const body = bon4Records(fixes);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}
