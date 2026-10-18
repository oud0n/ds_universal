import { TelemetryPoint } from '../types/telemetry';
import { calculatePhysics } from './physics';
import { tr } from '../utils/i18n';

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
// .dtb の日時は「保存した PC の現地時刻」で記録されている (同じ走行の .bnx4 の UTC 時刻と照合して確認)。
// そのため、この PC のタイムゾーンの現地時刻として解釈する
export function oleDateToDate(oleDate: number): Date {
  const wall = new Date(Date.UTC(1899, 11, 30) + oleDate * 86400000);
  return new Date(
    wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(),
    wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), wall.getUTCMilliseconds()
  );
}

/**
 * Date オブジェクトを OLE Automation Date に変換
 */
export function dateToOleDate(date: Date): number {
  const wall = Date.UTC(
    date.getFullYear(), date.getMonth(), date.getDate(),
    date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()
  );
  return (wall - Date.UTC(1899, 11, 30)) / 86400000;
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
    throw new Error(tr('無効な .dtb ファイルです (ファイルサイズが短すぎます)', 'Invalid .dtb file (too short)'));
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

    // off 8: 先頭からの経過時間 (日単位, Double)。off 16 の秒と同じ内容
    // off 124: 衛星数とみられる値 (int32)。記録レートではない。再保存で失わないよう保持する
    const tail = view.getInt32(offset + 124, true);

    // 妥当性チェック (壊れたファイルの無限大・非数・範囲外の値は取り込まない)
    const values = [time, latitude, longitude, altitude, speed, heading, distance];
    if (
      values.every(Number.isFinite) &&
      Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 &&
      time >= 0 && speed >= 0 && speed < 1000 && Math.abs(heading) <= 360 &&
      (points.length === 0 || time >= points[points.length - 1].time)
    ) {
      points.push({
        index: i,
        time: Number(time.toFixed(4)),
        oleDate,
        satellites: tail,
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

  // 記録レートは時刻の刻み (中央値) から求める
  if (points.length > 2) {
    const steps: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const dt = points[i].time - points[i - 1].time;
      if (dt > 0) steps.push(dt);
    }
    steps.sort((x, y) => x - y);
    const median = steps[steps.length >> 1];
    if (median > 0) samplingRate = Math.max(1, Math.round(1 / median));
  }

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

    // 日時 (PC の現地時刻)。ログの記録時刻があればそれを使う
    const curOle = p.oleDate || (p.timestamp ? dateToOleDate(new Date(p.timestamp)) : startOle + p.time / 86400);
    view.setFloat64(offset + 0, curOle, true);
    // 経過時間 (日単位)。off 16 の秒と同じ値を単位だけ変えて入れる
    view.setFloat64(offset + 8, p.time / 86400, true);

    encodeExtendedFloat(p.time, bytes, offset + 16);
    encodeExtendedFloat(p.latitude, bytes, offset + 32);
    encodeExtendedFloat(p.longitude, bytes, offset + 48);
    encodeExtendedFloat(p.altitude, bytes, offset + 64);
    encodeExtendedFloat(p.speed, bytes, offset + 80);
    encodeExtendedFloat(p.heading, bytes, offset + 96);
    encodeExtendedFloat(p.distance, bytes, offset + 112);

    // off 124 (衛星数とみられる値): 元の値があればそのまま書き戻す。他形式から変換した点は値を持たないため、従来どおり記録レートの数値を入れる
    view.setInt32(offset + 124, Number.isInteger(p.satellites) ? (p.satellites as number) : samplingRate, true);
  }

  return bytes;
}
