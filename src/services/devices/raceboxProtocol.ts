/**
 * RaceBox Mini・Mini S・Micro の Bluetooth LE (2026-10-20、PLAN-22)。
 * メーカーが公開している「RaceBox BLE Protocol Documentation」(Revision 9) による。
 *
 * - UART のサービス 6E400001-…、通知は TX の特性 6E400003-… (つないで通知を受け取るとすぐ、最大 25 回/秒で届く)
 * - 1 つの通知に 1 つのパケットが入っているとは限らない (分かれる・つながる) ので、ためてから切り出す
 * - パケット: B5 62 | 種類 (class, id) | 長さ (2 バイト、little endian) | 中身 | 確かめの値 2 バイト
 * - データのメッセージ (class 0xFF・id 0x01、80 バイト) に、時刻・位置・速度・方位・G・回転の速さが入っている
 */

export const RACEBOX_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const RACEBOX_TX_CHARACTERISTIC = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
/** 探すときの名前の頭 (後ろに 10 桁の製造番号が付く) */
export const RACEBOX_NAME_PREFIXES = ['RaceBox Mini ', 'RaceBox Mini S ', 'RaceBox Micro '];

/** データのメッセージを読んだもの */
export interface RaceboxSample {
  /** UTC のミリ秒 (日時が正しくないときは NaN) */
  tMs: number;
  /** 位置が使えるか (3D の測位で、測位が有効で、位置が無効の印が無い) */
  valid: boolean;
  fixStatus: number;
  satellites: number;
  latitude: number;
  longitude: number;
  /** 標高 (海面からの高さ、m) */
  altitude: number;
  speedKmh: number;
  /** 進む向き (度。北が 0) */
  heading: number;
  /** 位置の誤差 (m) */
  horizontalAccuracy: number;
  /** G (前後・左右・上下) */
  gX: number;
  gY: number;
  gZ: number;
  /** 回転の速さ (度/秒。ロール・ピッチ・ヨー) */
  rollRate: number;
  pitchRate: number;
  yawRate: number;
  /** Mini・Mini S は電池の残り (%) と充電中か。Micro は入力の電圧 (V) */
  battery: { percent: number; charging: boolean } | null;
  inputVoltage: number | null;
}

/** 確かめの値 (class・id・長さ・中身を足していく 8 ビットの 2 つの和) */
export function raceboxChecksum(packet: Uint8Array, start: number, end: number): [number, number] {
  let a = 0;
  let b = 0;
  for (let i = start; i < end; i++) {
    a = (a + packet[i]) & 0xff;
    b = (b + a) & 0xff;
  }
  return [a, b];
}

/** データのメッセージの中身 (80 バイト) を読む。micro: RaceBox Micro なら電池の欄を電圧として読む */
export function parseRaceboxData(p: DataView, micro = false): RaceboxSample {
  const year = p.getUint16(4, true);
  const validity = p.getUint8(11);
  const nanos = p.getInt32(16, true);
  const dateOk = (validity & 0x03) === 0x03;
  const tMs = dateOk
    ? Date.UTC(year, p.getUint8(6) - 1, p.getUint8(7), p.getUint8(8), p.getUint8(9), p.getUint8(10)) + Math.round(nanos / 1e6)
    : NaN;
  const fixStatus = p.getUint8(20);
  const fixFlags = p.getUint8(21);
  const latLonFlags = p.getUint8(66);
  const batteryByte = p.getUint8(67);
  return {
    tMs,
    valid: fixStatus === 3 && (fixFlags & 0x01) === 1 && (latLonFlags & 0x01) === 0 && Number.isFinite(tMs),
    fixStatus,
    satellites: p.getUint8(23),
    longitude: p.getInt32(24, true) / 1e7,
    latitude: p.getInt32(28, true) / 1e7,
    altitude: p.getInt32(36, true) / 1000,
    speedKmh: (p.getInt32(48, true) / 1000) * 3.6,
    heading: p.getInt32(52, true) / 1e5,
    horizontalAccuracy: p.getUint32(40, true) / 1000,
    gX: p.getInt16(68, true) / 1000,
    gY: p.getInt16(70, true) / 1000,
    gZ: p.getInt16(72, true) / 1000,
    rollRate: p.getInt16(74, true) / 100,
    pitchRate: p.getInt16(76, true) / 100,
    yawRate: p.getInt16(78, true) / 100,
    battery: micro ? null : { percent: batteryByte & 0x7f, charging: (batteryByte & 0x80) !== 0 },
    inputVoltage: micro ? batteryByte / 10 : null
  };
}

/**
 * 届いた通知をためて、パケットを切り出す。データのメッセージだけを返す (ほかの種類は読み飛ばす)。
 * 確かめの値が合わないパケットは捨て、次の B5 62 から探し直す
 */
export class RaceboxStream {
  private buf = new Uint8Array(0);
  /** 捨てたパケットの数 (確かめの値が合わない) */
  dropped = 0;

  constructor(private readonly micro = false) {}

  push(chunk: Uint8Array): RaceboxSample[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    const out: RaceboxSample[] = [];
    let i = 0;
    while (i + 8 <= merged.length) {
      if (merged[i] !== 0xb5 || merged[i + 1] !== 0x62) { i++; continue; }
      const len = merged[i + 4] | (merged[i + 5] << 8);
      if (len > 504) { i++; continue; }
      const total = 6 + len + 2;
      if (i + total > merged.length) break; // 続きを待つ
      const [a, b] = raceboxChecksum(merged, i + 2, i + 6 + len);
      if (merged[i + 6 + len] !== a || merged[i + 7 + len] !== b) {
        this.dropped++;
        i++;
        continue;
      }
      if (merged[i + 2] === 0xff && merged[i + 3] === 0x01 && len === 80) {
        out.push(parseRaceboxData(new DataView(merged.buffer, merged.byteOffset + i + 6, 80), this.micro));
      }
      i += total;
    }
    // 残り (途中までのパケット) を取っておく。長くなりすぎたら捨てる
    this.buf = merged.slice(Math.min(i, merged.length));
    if (this.buf.length > 4096) this.buf = this.buf.slice(-512);
    return out;
  }
}
