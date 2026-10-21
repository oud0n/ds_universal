/**
 * Drogger (BizStation の GNSS 受信機: RWS・RZS シリーズ・DG-PRO1RWS) の Bluetooth LE (2026-10-21、PLAN-23)。
 * 公式の iOS サンプル (github.com/bizstationjp/DroggerSampleAppiOS、パブリック・ドメイン) に合わせる:
 * - 名前は RWS. / RZS. / DG-PRO1RWS で始まる
 * - サービス 0baba001-…、受け取る値 0baba002-… (通知)、送る値 0baba003-…
 * - 中身は NMEA 0183 の文。1 回の通知に文の途中までや 2 つ以上の文が入ることがあり、落ちることもあるので、
 *   $ から \r\n までをつなぎ、確かめの値 (*hh) が合う文だけ使う
 * iPhone で使うには、受信機に BLE のファームウェアを書き込んでおく (初めのファームウェアは Bluetooth Classic で、iPhone からはつなげない)
 */

export const DROGGER_SERVICE = '0baba001-0000-1000-8000-00805f9b34fb';
export const DROGGER_DATA_CHARACTERISTIC = '0baba002-0000-1000-8000-00805f9b34fb';
export const DROGGER_WRITE_CHARACTERISTIC = '0baba003-0000-1000-8000-00805f9b34fb';
export const DROGGER_NAME_PREFIXES = ['RWS.', 'RZS.', 'DG-PRO1RWS'];

/** 1 つの測位 (RMC が来たら出す。直前の GGA の高さ・衛星の数を添える) */
export interface DroggerFix {
  tMs: number;
  latitude: number;
  longitude: number;
  speedKmh: number;
  /** 進む向き (度、北から右回り) */
  course: number | null;
  altitude?: number;
  satellites?: number;
  /** GGA の測位の質 (1: 単独・2: DGPS・4: RTK FIX・5: RTK FLOAT) */
  quality?: number;
  valid: boolean;
}

/** 文の確かめの値 ($ と * の間の XOR) が合うか */
export function nmeaChecksumOk(sentence: string): boolean {
  const star = sentence.lastIndexOf('*');
  if (!sentence.startsWith('$') || star < 0 || star + 3 > sentence.length) return false;
  let x = 0;
  for (let i = 1; i < star; i++) x ^= sentence.charCodeAt(i);
  return x === parseInt(sentence.slice(star + 1, star + 3), 16);
}

function toDeg(v: string, hemi: string): number | null {
  if (!v) return null;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  const deg = Math.floor(n / 100);
  const d = deg + (n - deg * 100) / 60;
  return hemi === 'S' || hemi === 'W' ? -d : d;
}

/** hhmmss.ss を、その日の秒に */
function todSec(tod: string): number {
  return Number(tod.slice(0, 2)) * 3600 + Number(tod.slice(2, 4)) * 60 + parseFloat(tod.slice(4));
}

/** 届いたバイトを文に組み立て、測位にする */
export class DroggerStream {
  private buf = '';
  private gga: { sec: number; altitude?: number; satellites?: number; quality?: number } | null = null;
  private decoder = new TextDecoder('ascii');

  push(bytes: Uint8Array): DroggerFix[] {
    this.buf += this.decoder.decode(bytes, { stream: true });
    // 壊れたデータでたまり続けないように
    if (this.buf.length > 8192) this.buf = this.buf.slice(this.buf.lastIndexOf('$'));
    const out: DroggerFix[] = [];
    for (;;) {
      const start = this.buf.indexOf('$');
      if (start < 0) { this.buf = ''; break; }
      const end = this.buf.indexOf('\n', start);
      if (end < 0) { this.buf = this.buf.slice(start); break; }
      // 文の途中で次の $ が始まっていれば (前の文が落ちた)、そちらから読み直す
      const next = this.buf.indexOf('$', start + 1);
      if (next >= 0 && next < end) { this.buf = this.buf.slice(next); continue; }
      const line = this.buf.slice(start, end).replace(/\r$/, '');
      this.buf = this.buf.slice(end + 1);
      if (!nmeaChecksumOk(line)) continue;
      const fix = this.sentence(line);
      if (fix) out.push(fix);
    }
    return out;
  }

  private sentence(line: string): DroggerFix | null {
    const parts = line.slice(1, line.lastIndexOf('*')).split(',');
    const type = parts[0].slice(2);
    if (type === 'GGA') {
      const alt = parseFloat(parts[9]);
      const sats = parseInt(parts[7], 10);
      const q = parseInt(parts[6], 10);
      this.gga = {
        sec: todSec(parts[1]),
        ...(Number.isFinite(alt) ? { altitude: alt } : {}),
        ...(Number.isFinite(sats) ? { satellites: sats } : {}),
        ...(Number.isFinite(q) ? { quality: q } : {})
      };
      return null;
    }
    if (type !== 'RMC') return null;
    // $xxRMC,hhmmss.ss,A,llll.ll,a,yyyyy.yy,a,knots,course,ddmmyy,...
    const [, tod, status, lat, ns, lon, ew, knots, course, date] = parts;
    if (!tod || !date || date.length < 6) return null;
    const latitude = toDeg(lat, ns);
    const longitude = toDeg(lon, ew);
    if (latitude === null || longitude === null) return null;
    const tMs = Date.UTC(
      2000 + Number(date.slice(4, 6)), Number(date.slice(2, 4)) - 1, Number(date.slice(0, 2)),
      Number(tod.slice(0, 2)), Number(tod.slice(2, 4)), 0
    ) + Math.round(parseFloat(tod.slice(4)) * 1000);
    if (!Number.isFinite(tMs)) return null;
    const kn = parseFloat(knots);
    const crs = parseFloat(course);
    // 近い時刻 (1.5 秒以内。RMC と GGA の順や、GGA の方が少ない出し方でも) の GGA の、高さ・衛星の数・測位の質を添える
    const g = this.gga && Math.abs(((todSec(tod) - this.gga.sec + 43200 + 86400) % 86400) - 43200) <= 1.5 ? this.gga : null;
    return {
      tMs,
      latitude,
      longitude,
      speedKmh: Number.isFinite(kn) ? kn * 1.852 : 0,
      course: Number.isFinite(crs) ? crs : null,
      ...(g?.altitude !== undefined ? { altitude: g.altitude } : {}),
      ...(g?.satellites !== undefined ? { satellites: g.satellites } : {}),
      ...(g?.quality !== undefined ? { quality: g.quality } : {}),
      valid: status === 'A'
    };
  }
}
