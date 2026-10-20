/**
 * 心拍計 (2026-10-20、PLAN-22)。Bluetooth の標準の心拍のサービス (Heart Rate Service)。
 * サービス 0x180D の Heart Rate Measurement (0x2A37) の通知を読む。
 *
 * 1 バイト目の印: bit 0 = 心拍が 16 ビットか、bit 1-2 = 肌に触れているか、bit 3 = 消費エネルギーがあるか、bit 4 = RR 間隔があるか
 */

export const HEART_RATE_SERVICE = '180d';
export const HEART_RATE_MEASUREMENT = '2a37';

export interface HeartRateSample {
  /** 心拍 (拍/分) */
  bpm: number;
  /** 肌に触れているか (分からない機器は null) */
  contact: boolean | null;
  /** 拍と拍の間 (ミリ秒) */
  rrMs: number[];
}

export function parseHeartRate(bytes: Uint8Array): HeartRateSample | null {
  if (bytes.length < 2) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = v.getUint8(0);
  let i = 1;
  const wide = (flags & 0x01) !== 0;
  if (bytes.length < i + (wide ? 2 : 1)) return null;
  const bpm = wide ? v.getUint16(i, true) : v.getUint8(i);
  i += wide ? 2 : 1;
  const contactSupported = (flags & 0x04) !== 0;
  const contact = contactSupported ? (flags & 0x02) !== 0 : null;
  if (flags & 0x08) i += 2; // 消費エネルギー (使わない)
  const rrMs: number[] = [];
  if (flags & 0x10) {
    // RR 間隔は 1/1024 秒の単位
    for (; i + 1 < bytes.length; i += 2) rrMs.push(Math.round((v.getUint16(i, true) / 1024) * 1000));
  }
  return { bpm, contact, rrMs };
}
