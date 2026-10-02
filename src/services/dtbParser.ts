import { TelemetryPoint } from '../types/telemetry';
import { calculatePhysics } from './physics';

/**
 * x87 80-bit Extended Precision Float (10 bytes) を JavaScript number にデコード
 */
export function decodeExtendedFloat(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 10);
  const mantissaLow = view.getUint32(0, true);
  const mantissaHigh = view.getUint32(4, true);
  const expSign = view.getUint16(8, true);

  const sign = (expSign >> 15) & 1;
  const exp = expSign & 0x7fff;

  if (exp === 0 && mantissaHigh === 0 && mantissaLow === 0) {
    return 0.0;
  }

  // 64-bit mantissa as a fraction: (mantissaHigh * 2^32 + mantissaLow) / 2^63
  // JavaScript double (53-bit mantissa) handles this with high accuracy
  const mantissa = mantissaHigh * 4294967296 + mantissaLow;
  const fraction = mantissa / 9223372036854775808; // 2^63
  const value = fraction * Math.pow(2, exp - 16383);

  return sign ? -value : value;
}

/**
 * JavaScript number を x87 80-bit Extended Precision Float (10 bytes) にエンコード
 */
export function encodeExtendedFloat(value: number, bytes: Uint8Array, offset: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 10);
  if (value === 0 || !isFinite(value)) {
    for (let i = 0; i < 10; i++) view.setUint8(i, 0);
    return;
  }

  const sign = value < 0 ? 1 : 0;
  const absVal = Math.abs(value);

  const expRaw = Math.floor(Math.log2(absVal));
  const exp = expRaw + 16383;
  const normalized = absVal / Math.pow(2, expRaw); // [1.0, 2.0)
  const mantissaFull = Math.floor(normalized * 9223372036854775808); // * 2^63

  const mantissaHigh = Math.floor(mantissaFull / 4294967296);
  const mantissaLow = mantissaFull >>> 0;
  const expSign = ((sign << 15) | (exp & 0x7fff)) >>> 0;

  view.setUint32(0, mantissaLow, true);
  view.setUint32(4, mantissaHigh, true);
  view.setUint16(8, expSign, true);
}

/**
 * OLE Automation Date (COM Date: 1899-12-30からの日数) を Date オブジェクトに変換
 */
export function oleDateToDate(oleDate: number): Date {
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const ms = oleDate * 86400000;
  return new Date(epoch.getTime() + ms);
}

/**
 * Date オブジェクトを OLE Automation Date に変換
 */
export function dateToOleDate(date: Date): number {
  const epoch = new Date(Date.UTC(1899, 11, 30));
  return (date.getTime() - epoch.getTime()) / 86400000;
}

/**
 * デジスパイス .dtb バイナリファイルを解析
 */
export function parseDtb(buffer: ArrayBuffer): {
  points: TelemetryPoint[];
  samplingRate: number;
  startDate?: Date;
} {
  const bytes = new Uint8Array(buffer);
  const RECORD_SIZE = 128; // 64-byte chunks * 2 = 128 bytes per sample
  const numRecords = Math.floor(bytes.length / RECORD_SIZE);

  if (numRecords === 0) {
    throw new Error('無効な .dtb ファイルです (ファイルサイズが短すぎます)');
  }

  const view = new DataView(buffer);
  const points: TelemetryPoint[] = [];
  let samplingRate = 10;
  let firstDate: Date | undefined;

  for (let i = 0; i < numRecords; i++) {
    const offset = i * RECORD_SIZE;

    // off 0..8: OLE Automation Date (Double)
    const oleDate = view.getFloat64(offset + 0, true);
    if (!firstDate && oleDate > 30000 && oleDate < 60000) {
      firstDate = oleDateToDate(oleDate);
    }

    // off 16: time (Extended)
    const time = decodeExtendedFloat(bytes, offset + 16);
    // off 32: latitude (Extended)
    const latitude = decodeExtendedFloat(bytes, offset + 32);
    // off 48: longitude (Extended)
    const longitude = decodeExtendedFloat(bytes, offset + 48);
    // off 64: altitude (Extended)
    const altitude = decodeExtendedFloat(bytes, offset + 64);
    // off 80: speed (Extended, km/h)
    const speed = decodeExtendedFloat(bytes, offset + 80);
    // off 96: heading (Extended, deg)
    const heading = decodeExtendedFloat(bytes, offset + 96);
    // off 112: distance (Extended, km)
    const distance = decodeExtendedFloat(bytes, offset + 112);

    // off 124: sampling rate (int32)
    if (offset + 128 <= bytes.length) {
      const rate = view.getInt32(offset + 124, true);
      if (rate >= 1 && rate <= 100) {
        samplingRate = rate;
      }
    }

    // 妥当性チェック
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      points.push({
        index: i,
        time: Number(time.toFixed(4)),
        oleDate,
        timestamp: oleDate > 0 ? oleDateToDate(oleDate).toISOString() : undefined,
        latitude: Number(latitude.toFixed(7)),
        longitude: Number(longitude.toFixed(7)),
        altitude: Number(altitude.toFixed(2)),
        speed: Number(speed.toFixed(2)),
        heading: Number(heading.toFixed(2)),
        distance: Number(distance.toFixed(4)),
        accelG: 0,
        corneringG: 0,
        combinedG: 0,
        turningRadius: 9999,
        driftAngle: 0
      });
    }
  }

  // 物理計算（加減速G、横G、合算G、旋回半径、ドリフトアングル）を付与
  const enrichedPoints = calculatePhysics(points);

  return {
    points: enrichedPoints,
    samplingRate,
    startDate: firstDate
  };
}

/**
 * TelemetryPoint 配列からデジスパイス .dtb バイナリを生成 (エクスポート用)
 */
export function exportDtb(points: TelemetryPoint[], samplingRate = 10, startDate = new Date()): Uint8Array {
  const RECORD_SIZE = 128;
  const buffer = new ArrayBuffer(points.length * RECORD_SIZE);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const startOle = dateToOleDate(startDate);

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const offset = i * RECORD_SIZE;

    // OLE Date (経過時間を加算)
    const curOle = p.oleDate || (startOle + p.time / 86400);
    view.setFloat64(offset + 0, curOle, true);

    encodeExtendedFloat(p.time, bytes, offset + 16);
    encodeExtendedFloat(p.latitude, bytes, offset + 32);
    encodeExtendedFloat(p.longitude, bytes, offset + 48);
    encodeExtendedFloat(p.altitude, bytes, offset + 64);
    encodeExtendedFloat(p.speed, bytes, offset + 80);
    encodeExtendedFloat(p.heading, bytes, offset + 96);
    encodeExtendedFloat(p.distance, bytes, offset + 112);

    view.setInt32(offset + 124, samplingRate, true);
  }

  return bytes;
}
