import { TelemetryPoint } from '../types/telemetry';
import { calculatePhysics } from './physics';

/**
 * デジスパイス3 / 4 の生ログファイル (.bnx4, .bon4, .binx, .bon) を解析
 */
export function parseDigispiceRawBinary(fileName: string, buffer: ArrayBuffer): {
  points: TelemetryPoint[];
  samplingRate: number;
  startDate?: Date;
} {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  interface RawPoint {
    lat: number;
    lon: number;
    speedKmh: number;
    timeSec: number;
    timestamp?: Date;
    heading?: number;
    altitude?: number;
  }

  const rawPoints: RawPoint[] = [];

  // ==========================================
  // 1. .bon / .bon4 フォーマット (26バイトレコード, offset 8開始)
  // ==========================================
  if (ext === 'bon' || ext === 'bon4') {
    const msMultiplier = ext === 'bon4' ? 10 : 100;
    let offset = 8;

    while (offset + 26 <= bytes.length) {
      try {
        const rawSpeed = view.getUint16(offset + 2, true);
        const rawLat = view.getInt32(offset + 4, true);
        const rawLon = view.getInt32(offset + 8, true);
        const year = view.getUint16(offset + 18, true);
        const month = view.getUint8(offset + 20);
        const day = view.getUint8(offset + 21);
        const hour = view.getUint8(offset + 22);
        const minute = view.getUint8(offset + 23);
        const second = view.getUint8(offset + 24);
        const subSec = view.getUint8(offset + 25);

        const speedKmh = (rawSpeed / 100) * 3.6;
        const lat = rawLat / 1e7;
        const lon = rawLon / 1e7;

        if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31 && lat !== 0 && lon !== 0) {
          const utcDate = new Date(
            Date.UTC(year, month - 1, day, hour, minute, second, subSec * msMultiplier)
          );
          const timeSec = utcDate.getTime() / 1000;

          rawPoints.push({
            lat,
            lon,
            speedKmh,
            timeSec,
            timestamp: utcDate,
            altitude: 0
          });
        }
      } catch {
        // Skip corrupt record
      }
      offset += 26;
    }
  } else {
    // ==========================================
    // 2. DigSpice IV セクター型 (.bnx4 / .binx, 4096バイトセクター, 0x200開始, 36バイト)
    // ==========================================
    const numSectors = Math.floor(bytes.length / 0x1000);
    if (numSectors > 0) {
      for (let s = 0; s < numSectors; s++) {
        const secOffset = s * 0x1000;
        let esi = 0x200;

        while (esi + 36 <= 0x1000) {
          const pos = secOffset + esi;
          if (pos + 36 > bytes.length) break;

          // プリアンブルタグのスキップ (0xAA*7 ... 0xBB*4)
          if (bytes[pos] === 0xaa && bytes[pos + 1] === 0xaa) {
            esi += 0x10;
            continue;
          }

          // 0xFF 未記録レコード領域のスキップ
          if (bytes[pos] === 0xff && bytes[pos + 1] === 0xff) {
            esi += 36;
            continue;
          }

          try {
            const ts = view.getUint32(pos + 0, true);
            const fix = view.getUint16(pos + 4, true);
            const lat = view.getFloat64(pos + 6, true);
            const lon = view.getFloat64(pos + 14, true);
            const alt = view.getFloat32(pos + 22, true);
            const spd = view.getFloat32(pos + 26, true);
            const hdg = view.getFloat32(pos + 30, true);

            // 妥当性判定: 3D/2D Fix, 有効な緯度経度, 2000年〜2050年頃のタイムスタンプ
            if (
              (fix === 2 || fix === 3) &&
              lat >= -90 && lat <= 90 && lat !== 0 &&
              lon >= -180 && lon <= 180 && lon !== 0 &&
              ts > 946684800 && ts < 2524608000
            ) {
              const cleanSpeed = !isNaN(spd) && spd >= 0 && spd < 500 ? spd : 0;
              const cleanHeading = !isNaN(hdg) && hdg >= 0 && hdg <= 360 ? hdg : 0;
              const cleanAltitude = !isNaN(alt) && alt >= -500 && alt < 10000 ? alt : 0;

              rawPoints.push({
                lat,
                lon,
                speedKmh: cleanSpeed,
                timeSec: ts, // 後で同一秒グループごとにサブ秒補間
                timestamp: new Date(ts * 1000),
                heading: cleanHeading,
                altitude: cleanAltitude
              });
            }
          } catch {
            // パース例外時はスキップ
          }

          esi += 36;
        }
      }

      // 同一秒（同じts）内のサブ秒補間 (20Hz / 10Hz)
      if (rawPoints.length > 0) {
        let i = 0;
        while (i < rawPoints.length) {
          const curTs = rawPoints[i].timeSec;
          let count = 1;
          while (i + count < rawPoints.length && rawPoints[i + count].timeSec === curTs) {
            count++;
          }
          for (let k = 0; k < count; k++) {
            const frac = count > 1 ? k / count : 0;
            const preciseTime = curTs + frac;
            rawPoints[i + k].timeSec = preciseTime;
            rawPoints[i + k].timestamp = new Date(preciseTime * 1000);
          }
          i += count;
        }
      }
    }

    // ==========================================
    // 3. レガシー・フラットバイナリ用フォールバック
    // ==========================================
    if (rawPoints.length === 0) {
      interface Layout {
        name: string;
        recordSize: number;
        parse: (v: DataView, z: number) => {
          lat: number;
          lon: number;
          speedKmh: number;
          heading: number;
          ms: number;
          u_t: number;
          alt: number;
        } | null;
      }

      const layouts: Layout[] = [
        {
          name: 'DigSpice 4 36-byte Flat',
          recordSize: 36,
          parse: (v, z) => {
            try {
              const u_t = v.getUint32(z + 0, true);
              const lat = v.getFloat64(z + 6, true);
              const lon = v.getFloat64(z + 14, true);
              const alt = v.getFloat32(z + 22, true);
              const speedKmh = v.getFloat32(z + 26, true);
              const heading = v.getFloat32(z + 30, true);
              return { lat, lon, speedKmh, heading, ms: 0, u_t, alt };
            } catch {
              return null;
            }
          }
        },
        {
          name: 'Legacy .binx 38-byte',
          recordSize: 38,
          parse: (v, z) => {
            try {
              const u_t = v.getUint32(z + 0, true);
              const lat = v.getFloat64(z + 4, true);
              const lon = v.getFloat64(z + 12, true);
              const heading = v.getFloat32(z + 20, true);
              const speedKmh = v.getFloat32(z + 24, true);
              const ms = v.getUint16(z + 34, true);
              return { lat, lon, speedKmh, heading, ms, u_t, alt: 0 };
            } catch {
              return null;
            }
          }
        }
      ];

      const isPossiblyValid = (lat: number, lon: number, u_t: number): boolean => {
        return (
          !isNaN(lat) &&
          Math.abs(lat) > 1 &&
          Math.abs(lat) <= 90 &&
          !isNaN(lon) &&
          Math.abs(lon) > 1 &&
          Math.abs(lon) <= 180 &&
          !isNaN(u_t) &&
          u_t > 5e8 &&
          u_t < 2.5e9
        );
      };

      let z = 0;
      // 4バイト境界でスキャンしてメインスレッドの過負荷を防止
      const step = 4;
      while (z + 36 <= bytes.length) {
        let matched = false;

        for (const layout of layouts) {
          if (z + layout.recordSize > bytes.length) continue;
          const rec = layout.parse(view, z);
          if (rec) {
            const { lat, lon, speedKmh, heading, ms, u_t, alt } = rec;
            if (isPossiblyValid(lat, lon, u_t)) {
              const cleanSpeed = !isNaN(speedKmh) && speedKmh >= 0 && speedKmh < 450 ? speedKmh : 0;
              const cleanHeading = !isNaN(heading) && heading >= 0 && heading <= 360 ? heading : undefined;
              const cleanMs = ms >= 0 && ms < 1000 ? ms : 0;
              const timeSec = u_t + cleanMs / 1000;

              rawPoints.push({
                lat,
                lon,
                speedKmh: cleanSpeed,
                timeSec,
                timestamp: new Date(timeSec * 1000),
                heading: cleanHeading,
                altitude: alt
              });

              z += layout.recordSize;
              matched = true;
              break;
            }
          }
        }

        if (!matched) {
          z += step;
        }
      }
    }
  }

  if (rawPoints.length === 0) {
    throw new Error(`${fileName} から有効なGPSログレコードを抽出できませんでした`);
  }

  // 時間順にソート & 重複除去
  rawPoints.sort((a, b) => a.timeSec - b.timeSec);

  // 最初の時間を t=0 とする相対時間計算
  const t0 = rawPoints[0].timeSec;
  const startDate = rawPoints[0].timestamp;

  const points: TelemetryPoint[] = rawPoints.map((r, i) => ({
    index: i,
    time: Number((r.timeSec - t0).toFixed(4)),
    timestamp: r.timestamp?.toISOString(),
    latitude: Number(r.lat.toFixed(7)),
    longitude: Number(r.lon.toFixed(7)),
    altitude: Number((r.altitude ?? 0).toFixed(1)),
    speed: Number(r.speedKmh.toFixed(2)),
    heading: r.heading ?? 0,
    distance: 0,
    accelG: 0,
    corneringG: 0,
    combinedG: 0,
    turningRadius: 9999,
    driftAngle: 0
  }));

  // 物理計算 (Gフォース、旋回半径、累積距離、方位角)
  const enriched = calculatePhysics(points);

  // サンプリング周波数判定 (10Hz / 20Hz 等)
  let samplingRate = 20;
  if (points.length > 20) {
    const totalDuration = points[points.length - 1].time - points[0].time;
    if (totalDuration > 0) {
      const hz = Math.round(points.length / totalDuration);
      if (hz >= 1 && hz <= 100) samplingRate = hz;
    }
  }

  return {
    points: enriched,
    samplingRate,
    startDate
  };
}
