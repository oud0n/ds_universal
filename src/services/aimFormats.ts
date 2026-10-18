// AiM (Race Studio) のログの読み込み: Race Studio が書き出す CSV と、ロガーのファイル (.xrk / 圧縮した .xrz)。
// .xrk は AiM の独自形式。ここでは GPS の記録 (<hGPS の枠に入った u-blox の NAV-SOL、56 バイト) だけを読む。
// 形式の手がかり: libxrk (MIT, https://github.com/m3rlin45/libxrk) の spec/xrk_format.py
import { calculateGeoDistanceAndHeading } from './physics';
import { finalizeImportedSamples, splitCsvLine, type ImportedLog, type RawSample } from './externalFormats';

// ============================================================================
// Race Studio の CSV ("Format","AiM CSV File")
// ============================================================================

export function isAimCsv(text: string): boolean {
  return /^"?Format"?\s*,\s*"?AiM CSV File"?/i.test(text.slice(0, 200).trimStart());
}

export function parseAimCsv(text: string): ImportedLog {
  const lines = text.split(/\r?\n/);
  // 先頭の情報の行 ("Date","Tuesday, December 16, 2025" / "Time","11:49 AM")
  const meta = new Map<string, string>();
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    const c = splitCsvLine(lines[i]);
    if (c[0] === 'Time' && c.length > 4) { headerIdx = i; break; }
    if (c.length >= 2) meta.set(c[0], c[1]);
  }
  if (headerIdx < 0) throw new Error('AiM の CSV の列見出しが見つかりません');
  const header = splitCsvLine(lines[headerIdx]);
  const col = (name: string) => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  const cTime = 0;
  const cLat = col('GPS Latitude');
  const cLon = col('GPS Longitude');
  const cSpeed = col('GPS Speed');
  const cAlt = col('GPS Altitude');
  const cHeading = col('GPS Heading');
  const cSat = col('GPS Nsat');
  if (cLat < 0 || cLon < 0) throw new Error('AiM の CSV に GPS Latitude / GPS Longitude の列がありません');
  // 単位の行 (見出しの次)。速度が km/h でなければ直す
  const units = splitCsvLine(lines[headerIdx + 1] || '');
  const speedUnit = (units[cSpeed] || 'km/h').toLowerCase();
  const speedFactor = speedUnit === 'm/s' ? 3.6 : speedUnit === 'mph' ? 1.609344 : 1;

  // 記録の開始時刻 (ロガーの時計。タイムゾーンは記録されていないので、この端末の時刻として読む)
  const start = parseAimDateTime(meta.get('Date'), meta.get('Time'));

  const samples: RawSample[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const c = splitCsvLine(lines[i]);
    const t = parseFloat(c[cTime]);
    if (!Number.isFinite(t)) continue; // 単位の行など
    // 衛星が 4 つ未満の行は位置が止まっているので使わない
    if (cSat >= 0 && parseFloat(c[cSat]) < 4) continue;
    samples.push({
      time: t,
      latitude: parseFloat(c[cLat]),
      longitude: parseFloat(c[cLon]),
      speedKmh: cSpeed >= 0 ? parseFloat(c[cSpeed]) * speedFactor : NaN,
      altitude: cAlt >= 0 ? parseFloat(c[cAlt]) : NaN,
      // AiM の方位は -180〜180 度
      heading: cHeading >= 0 ? (parseFloat(c[cHeading]) + 360) % 360 : NaN,
      timestamp: start ? new Date(start.getTime() + t * 1000) : undefined
    });
  }
  return finalizeImportedSamples(samples, 'AiM の CSV');
}

function parseAimDateTime(date?: string, time?: string): Date | undefined {
  if (!date) return undefined;
  const d = new Date(`${date.replace(/^[A-Za-z]+,\s*/, '')} ${time ?? ''}`);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

// ============================================================================
// .xrk / .xrz
// ============================================================================

/**
 * .xrz (zlib で圧縮した .xrk) なら展開する。
 * 終わりが切れた .xrz (圧縮の終わりの印がない) もあるので、展開できたところまでを使う
 */
export async function inflateXrz(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x78 || ![0x01, 0x5e, 0x9c, 0xda].includes(bytes[1])) return bytes;
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (err) {
    if (total === 0) throw err;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function isXrk(bytes: Uint8Array): boolean {
  // 先頭は '<h' の枠 (CNF など)
  return bytes.length > 12 && bytes[0] === 0x3c && bytes[1] === 0x68;
}

// GPS 時刻と UTC の差 (うるう秒、2017 年から 18 秒)
const GPS_LEAP_SECONDS = 18;
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

/** WGS84 の地心直交座標 (m) から緯度・経度 (度)・楕円体高 (m) */
function ecefToLla(x: number, y: number, z: number): { lat: number; lon: number; alt: number } {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  let alt = 0;
  for (let i = 0; i < 6; i++) {
    const sin = Math.sin(lat);
    const n = a / Math.sqrt(1 - e2 * sin * sin);
    alt = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - e2 * n / (n + alt)));
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, alt };
}

/** .xrk (展開済み) から GPS の走行ログを読む */
export function parseXrk(bytes: Uint8Array): ImportedLog {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fixes: { utcMs: number; lat: number; lon: number; alt: number; speedMs: number; headingDeg: number }[] = [];
  // '<h' + 'GPS' (4 文字目は 0x00 か空白) / 'GPS1' + 長さ (int32) + 版 + '>' + 本体 + '<' + 'GPS ' + 照合値 (本体の和) + '>'
  for (let pos = 0; pos + 12 < bytes.length; pos++) {
    if (bytes[pos] !== 0x3c || bytes[pos + 1] !== 0x68 || bytes[pos + 2] !== 0x47 || bytes[pos + 3] !== 0x50 || bytes[pos + 4] !== 0x53) continue;
    const tok = bytes[pos + 5];
    if (tok !== 0x00 && tok !== 0x20 && tok !== 0x31) continue;
    const len = v.getInt32(pos + 6, true);
    const body = pos + 12;
    const end = body + len;
    if (bytes[pos + 11] !== 0x3e || len < 56 || end + 8 > bytes.length) continue;
    if (bytes[end] !== 0x3c || v.getUint32(end + 1, true) !== v.getUint32(pos + 2, true) || bytes[end + 7] !== 0x3e) continue;
    let sum = 0;
    for (let i = body; i < end; i++) sum += bytes[i];
    if ((sum & 0xffff) !== v.getUint16(end + 5, true)) continue;

    // 本体: AiM の時刻 (4) + u-blox NAV-SOL (52)。56 バイトずつ並ぶ
    for (let r = body; r + 56 <= end; r += 56) {
      const fix = bytes[r + 14];
      const pdop = v.getUint16(r + 48, true) / 100;
      if (fix < 2 || pdop > 5) continue;
      const iTow = v.getUint32(r + 4, true);
      const fTowNs = v.getInt32(r + 8, true);
      const week = v.getUint16(r + 12, true);
      const x = v.getInt32(r + 16, true) / 100;
      const y = v.getInt32(r + 20, true) / 100;
      const z = v.getInt32(r + 24, true) / 100;
      if (x === 0 && y === 0 && z === 0) continue;
      const vx = v.getInt32(r + 32, true) / 100;
      const vy = v.getInt32(r + 36, true) / 100;
      const vz = v.getInt32(r + 40, true) / 100;
      const { lat, lon, alt } = ecefToLla(x, y, z);
      // 速度を東・北の成分に直して、水平の速さと進行方向にする
      const la = (lat * Math.PI) / 180;
      const lo = (lon * Math.PI) / 180;
      const east = -Math.sin(lo) * vx + Math.cos(lo) * vy;
      const north = -Math.sin(la) * Math.cos(lo) * vx - Math.sin(la) * Math.sin(lo) * vy + Math.cos(la) * vz;
      fixes.push({
        utcMs: GPS_EPOCH_MS + week * 604800000 + iTow + fTowNs / 1e6 - GPS_LEAP_SECONDS * 1000,
        lat,
        lon,
        alt,
        speedMs: Math.hypot(east, north),
        headingDeg: ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
      });
    }
    pos = end + 7;
  }
  if (fixes.length < 2) throw new Error('AiM のファイルに、測位できた GPS の記録がありません');
  fixes.sort((a, b) => a.utcMs - b.utcMs);
  const samples: RawSample[] = fixes.map((f, i) => {
    // 止まっているときは速度の向きがあてにならないので、前後の位置から求める
    let heading = f.headingDeg;
    if (f.speedMs < 1) {
      const a = fixes[Math.max(0, i - 1)];
      const b = fixes[Math.min(fixes.length - 1, i + 1)];
      if (a !== b) heading = calculateGeoDistanceAndHeading(a.lat, a.lon, b.lat, b.lon).headingDeg;
    }
    return {
      time: f.utcMs / 1000,
      latitude: f.lat,
      longitude: f.lon,
      speedKmh: f.speedMs * 3.6,
      altitude: f.alt,
      heading,
      timestamp: new Date(f.utcMs)
    };
  });
  return finalizeImportedSamples(samples, 'AiM のファイル');
}
