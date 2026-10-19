import { TelemetryPoint, Lap } from '../types/telemetry';
import { calculatePhysics } from './physics';
import { splitCsvLine } from './externalFormats';
import { formatMinSec } from '../utils/timeFormat';
import { tr } from '../utils/i18n';

/**
 * CSV 文字列を解析して TelemetryPoint 配列に変換
 * - デジスパイス公式 CSV
 * - MoTeC i2 CSV
 * - 汎用 GPS ロガー CSV
 */
export function parseCsv(csvText: string): { points: TelemetryPoint[]; samplingRate: number; startDate?: Date } {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error(tr('CSVデータが空または行数が不足しています', 'The CSV is empty or has too few rows'));
  }

  // ヘッダー行を検出（MoTeCの場合は数行のメタデータがある場合がある）
  let headerIndex = 0;
  let headers: string[] = [];

  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    // 引用符で囲んだ値の中のカンマで列がずれないよう、引用符に対応した分割を使う
    const cols = splitCsvLine(lines[i]);
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
    headers = splitCsvLine(lines[0]);
    headerIndex = 0;
  }

  // カラムのインデックスを特定
  let colTime = -1;
  let colClock = -1;
  let colLat = -1;
  let colLon = -1;
  let colAlt = -1;
  let colSpeed = -1;
  let colDist = -1;
  let colAccelG = -1;
  let colCornerG = -1;
  let colCombG = -1;
  let colRadius = -1;
  let colHeading = -1;
  let colSats = -1;

  headers.forEach((h, idx) => {
    const hl = h.toLowerCase();
    // 「Time (s)」のように単位が付いた見出しも時刻列として扱う
    const base = hl.replace(/\s*[(\[].*$/, '').trim();
    if (colTime === -1 && (base === '秒' || base === 'time' || base === 'sec' || base === 'seconds' || base === 'elapsed time' || base === 'elapsed_s')) colTime = idx;
    // 記録日時 (ISO 8601 など)。このアプリの変換ページの CSV の time_utc や、ほかのアプリ (RaceBox など) の日時の列
    if (colClock === -1 && ['time_utc', 'utc', 'utc time', 'gps time', 'timestamp', 'datetime', 'date time', 'date/time', 'date_time'].includes(base)) colClock = idx;
    if (colLat === -1 && (hl.includes('緯度') || hl.includes('lat'))) colLat = idx;
    if (colLon === -1 && (hl.includes('経度') || hl.includes('lon') || hl.includes('lng'))) colLon = idx;
    if (colAlt === -1 && (hl.includes('標高') || hl.includes('alt'))) colAlt = idx;
    if (colSpeed === -1 && (hl.includes('速度') || hl.includes('speed') || hl.includes('spd') || hl.includes('km/h'))) colSpeed = idx;
    if (colDist === -1 && (hl.includes('距離') || hl.includes('dist'))) colDist = idx;
    if (colCornerG === -1 && (hl.includes('コーナリングg') || hl.includes('lat g') || hl.includes('lateral g') || hl === 'g_lat')) colCornerG = idx;
    if (colAccelG === -1 && (hl.includes('加減速g') || hl.includes('long g') || hl.includes('longitudinal g') || hl === 'g_long')) colAccelG = idx;
    if (colCombG === -1 && (hl.includes('合算g') || hl.includes('combined g') || hl === 'g_sum')) colCombG = idx;
    if (colRadius === -1 && (hl.includes('旋回半径') || hl.includes('radius'))) colRadius = idx;
    // 進行方向・衛星数 (変換ページの CSV の heading_deg / satellites など)
    if (colHeading === -1 && (hl.includes('方位') || hl.includes('進行方向') || base === 'heading' || base === 'heading_deg' || base === 'bearing' || base === 'course')) colHeading = idx;
    if (colSats === -1 && (hl.includes('衛星') || base === 'satellites' || base === 'sats')) colSats = idx;
  });

  // 位置がなければ解析できない
  if (colLat === -1 || colLon === -1) {
    throw new Error(tr('CSV に緯度・経度の列が見つかりません', 'No latitude / longitude columns were found in the CSV'));
  }

  const points: TelemetryPoint[] = [];

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const rawCols = splitCsvLine(lines[i]);
    if (rawCols.length < 2) continue;

    // 時刻の列が日時 ("2026-08-30T00:57:00.100Z" など) のとき、または時刻の列がなく日時の列があるときは、日時から秒を求める
    const timeCell = colTime !== -1 ? rawCols[colTime] : '';
    const timeIsClock = colTime !== -1 && !/^\s*-?\d+([.,]\d+)?\s*$/.test(timeCell) && Number.isFinite(Date.parse(timeCell));
    const clockCell = timeIsClock ? timeCell : colClock !== -1 ? rawCols[colClock] : '';
    const rowClockMs = clockCell ? Date.parse(clockCell) : NaN;
    const time = timeIsClock || (colTime === -1 && Number.isFinite(rowClockMs)) ? rowClockMs / 1000
      : colTime !== -1 ? parseFloat(timeCell) : (i - headerIndex - 1) * 0.1;
    // 数値として読めない座標を 0 に置き換えない (その行を捨てる)
    const lat = parseFloat(rawCols[colLat]);
    const lon = parseFloat(rawCols[colLon]);
    const alt = colAlt !== -1 ? parseFloat(rawCols[colAlt]) : NaN;
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

    const clockMs = rowClockMs;
    const heading = colHeading !== -1 ? parseFloat(rawCols[colHeading]) : NaN;
    const sats = colSats !== -1 ? parseInt(rawCols[colSats], 10) : NaN;

    const validPosition = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
    const inOrder = points.length === 0 || time > points[points.length - 1].time;
    if (Number.isFinite(time) && validPosition && inOrder) {
      points.push({
        index: points.length,
        time: Number(time.toFixed(3)),
        latitude: Number(lat.toFixed(7)),
        longitude: Number(lon.toFixed(7)),
        altitude: Number.isFinite(alt) ? Number(alt.toFixed(2)) : 0,
        ...(Number.isFinite(alt) ? {} : { altitudeMissing: true }),
        speed: Number(speed.toFixed(2)),
        heading: Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : 0,
        distance: Number(dist.toFixed(4)),
        accelG: Number(accelG.toFixed(3)),
        corneringG: Number(cornerG.toFixed(3)),
        combinedG: Number(combG.toFixed(3)),
        turningRadius: Number(radius.toFixed(1)),
        driftAngle: 0,
        ...(Number.isFinite(clockMs) ? { timestamp: new Date(clockMs).toISOString() } : {}),
        ...(Number.isInteger(sats) && sats >= 0 ? { satellites: sats } : {})
      });
    }
  }

  // 先頭の時刻を 0 秒にそろえる (経過時間の列が 0 から始まらない CSV でも、他の形式と同じ扱いにする)
  if (points.length > 0 && points[0].time !== 0) {
    const t0 = points[0].time;
    for (const p of points) p.time = Number((p.time - t0).toFixed(3));
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

  const firstClock = enriched[0]?.timestamp;
  return { points: enriched, samplingRate, ...(firstClock ? { startDate: new Date(firstClock) } : {}) };
}

/**
 * デジスパイス公式フォーマットで走行データを CSV 文字列に変換
 */
export function exportDigispiceCsv(points: TelemetryPoint[]): string {
  const header = '秒,時間,緯度,経度,距離(km),標高(m),速度(km/h),旋回半径(m),コーナリングG,加減速G,合算G';
  const rows = points.map(p => {
    const timeStr = formatMinSec(p.time, 1, true);

    return [
      p.time.toFixed(3),
      timeStr,
      p.latitude.toFixed(6),
      p.longitude.toFixed(6),
      p.distance.toFixed(3),
      p.altitudeMissing ? '' : p.altitude.toFixed(2),
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
    const timeStr = formatMinSec(l.lapTime, 3, true);
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
