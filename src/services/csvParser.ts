import { TelemetryPoint, Lap } from '../types/telemetry';
import { calculatePhysics } from './physics';

/**
 * CSV 文字列を解析して TelemetryPoint 配列に変換
 * - デジスパイス公式 CSV
 * - MoTeC i2 CSV
 * - 汎用 GPS ロガー CSV
 */
export function parseCsv(csvText: string): { points: TelemetryPoint[]; samplingRate: number } {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('CSVデータが空または行数が不足しています');
  }

  // ヘッダー行を検出（MoTeCの場合は数行のメタデータがある場合がある）
  let headerIndex = 0;
  let headers: string[] = [];

  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const colsLower = cols.map(c => c.toLowerCase());
    
    // デジスパイス公式: 秒, 時間, 緯度, 経度...
    // MoTeC: Time, Distance, GPS_Lat, GPS_Long, Speed...
    // 汎用: time, latitude, longitude, speed...
    const hasTime = colsLower.some(c => c.includes('秒') || c.includes('time') || c.includes('sec'));
    const hasLat = colsLower.some(c => c.includes('緯度') || c.includes('lat'));
    const hasLon = colsLower.some(c => c.includes('経度') || c.includes('lon') || c.includes('lng'));
    const hasSpeed = colsLower.some(c => c.includes('速度') || c.includes('speed') || c.includes('spd') || c.includes('km/h'));

    if ((hasTime && hasLat && hasLon) || (hasLat && hasLon) || (hasTime && hasSpeed)) {
      headerIndex = i;
      headers = cols;
      break;
    }
  }

  if (headers.length === 0) {
    // 最初の行をヘッダーとして試みる
    headers = lines[0].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    headerIndex = 0;
  }

  // カラムのインデックスを特定
  let colTime = -1;
  let colLat = -1;
  let colLon = -1;
  let colAlt = -1;
  let colSpeed = -1;
  let colDist = -1;
  let colAccelG = -1;
  let colCornerG = -1;
  let colCombG = -1;
  let colRadius = -1;

  headers.forEach((h, idx) => {
    const hl = h.toLowerCase();
    if (colTime === -1 && (hl === '秒' || hl === 'time' || hl === 'sec' || hl.startsWith('time('))) colTime = idx;
    if (colLat === -1 && (hl.includes('緯度') || hl.includes('lat'))) colLat = idx;
    if (colLon === -1 && (hl.includes('経度') || hl.includes('lon') || hl.includes('lng'))) colLon = idx;
    if (colAlt === -1 && (hl.includes('標高') || hl.includes('alt'))) colAlt = idx;
    if (colSpeed === -1 && (hl.includes('速度') || hl.includes('speed') || hl.includes('spd') || hl.includes('km/h'))) colSpeed = idx;
    if (colDist === -1 && (hl.includes('距離') || hl.includes('dist'))) colDist = idx;
    if (colCornerG === -1 && (hl.includes('コーナリングg') || hl.includes('lat g') || hl.includes('lateral g') || hl === 'g_lat')) colCornerG = idx;
    if (colAccelG === -1 && (hl.includes('加減速g') || hl.includes('long g') || hl.includes('longitudinal g') || hl === 'g_long')) colAccelG = idx;
    if (colCombG === -1 && (hl.includes('合算g') || hl.includes('combined g') || hl === 'g_sum')) colCombG = idx;
    if (colRadius === -1 && (hl.includes('旋回半径') || hl.includes('radius'))) colRadius = idx;
  });

  const points: TelemetryPoint[] = [];

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const rawCols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    if (rawCols.length < 2) continue;

    const time = colTime !== -1 ? parseFloat(rawCols[colTime]) || 0 : (i - headerIndex - 1) * 0.1;
    const lat = colLat !== -1 ? parseFloat(rawCols[colLat]) || 0 : 0;
    const lon = colLon !== -1 ? parseFloat(rawCols[colLon]) || 0 : 0;
    const alt = colAlt !== -1 ? parseFloat(rawCols[colAlt]) || 0 : 0;
    let speed = colSpeed !== -1 ? parseFloat(rawCols[colSpeed]) || 0 : 0;
    // もし m/s や mph の可能性がある場合 (km/h に補正)
    if (headers[colSpeed]?.toLowerCase().includes('m/s')) {
      speed = speed * 3.6;
    } else if (headers[colSpeed]?.toLowerCase().includes('mph')) {
      speed = speed * 1.60934;
    }

    const dist = colDist !== -1 ? parseFloat(rawCols[colDist]) || 0 : 0;
    const accelG = colAccelG !== -1 ? parseFloat(rawCols[colAccelG]) || 0 : 0;
    const cornerG = colCornerG !== -1 ? parseFloat(rawCols[colCornerG]) || 0 : 0;
    const combG = colCombG !== -1 ? parseFloat(rawCols[colCombG]) || 0 : 0;
    const radius = colRadius !== -1 ? parseFloat(rawCols[colRadius]) || 9999 : 9999;

    if (!isNaN(time) && !isNaN(lat) && !isNaN(lon)) {
      points.push({
        index: points.length,
        time: Number(time.toFixed(3)),
        latitude: Number(lat.toFixed(7)),
        longitude: Number(lon.toFixed(7)),
        altitude: Number(alt.toFixed(2)),
        speed: Number(speed.toFixed(2)),
        heading: 0,
        distance: Number(dist.toFixed(4)),
        accelG: Number(accelG.toFixed(3)),
        corneringG: Number(cornerG.toFixed(3)),
        combinedG: Number(combG.toFixed(3)),
        turningRadius: Number(radius.toFixed(1)),
        driftAngle: 0
      });
    }
  }

  // 物理計算の付与・更新
  const enriched = calculatePhysics(points);

  // サンプリングレート推定
  let avgDt = 0.1;
  if (points.length > 10) {
    const totalTime = points[points.length - 1].time - points[0].time;
    if (totalTime > 0) {
      avgDt = totalTime / (points.length - 1);
    }
  }
  const samplingRate = Math.round(1 / avgDt) || 10;

  return { points: enriched, samplingRate };
}

/**
 * デジスパイス公式フォーマットで走行データを CSV 文字列に変換
 */
export function exportDigispiceCsv(points: TelemetryPoint[]): string {
  const header = '秒,時間,緯度,経度,距離(km),標高(m),速度(km/h),旋回半径(m),コーナリングG,加減速G,合算G';
  const rows = points.map(p => {
    const mins = Math.floor(p.time / 60);
    const secs = (p.time % 60).toFixed(1).padStart(4, '0');
    const timeStr = `${mins.toString().padStart(2, '0')}:${secs}`;

    return [
      p.time.toFixed(3),
      timeStr,
      p.latitude.toFixed(6),
      p.longitude.toFixed(6),
      p.distance.toFixed(3),
      p.altitude.toFixed(2),
      p.speed.toFixed(2),
      p.turningRadius > 9998 ? '' : p.turningRadius.toFixed(2),
      p.corneringG.toFixed(3),
      p.accelG.toFixed(3),
      p.combinedG.toFixed(3)
    ].join(',');
  });

  return [header, ...rows].join('\r\n');
}

/**
 * ラップ一覧を CSV 文字列に変換
 */
export function exportLapListCsv(laps: Lap[]): string {
  const sectorHeaders = laps[0]?.sectors.map((s) => s.sectorName).join(',') || '';
  const header = `Lap,LapTime(s),LapTime(mm:ss.000),TopSpeed(km/h),MinSpeed(km/h),AvgSpeed(km/h),Distance(km)${sectorHeaders ? ',' + sectorHeaders : ''}`;

  const rows = laps.map(l => {
    const mins = Math.floor(l.lapTime / 60);
    const secs = (l.lapTime % 60).toFixed(3).padStart(6, '0');
    const timeStr = `${mins.toString().padStart(2, '0')}:${secs}`;
    const sectorTimes = l.sectors.map(s => s.time.toFixed(3)).join(',');

    return [
      l.lapNumber,
      l.lapTime.toFixed(3),
      timeStr,
      l.topSpeed.toFixed(1),
      l.bottomSpeed.toFixed(1),
      l.avgSpeed.toFixed(1),
      l.distance.toFixed(3),
      sectorTimes
    ].filter(Boolean).join(',');
  });

  return [header, ...rows].join('\r\n');
}
