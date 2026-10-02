/**
 * NMEA-0183 & GPX エクスポーター (RaceChrono / サードパーティGPS解析アプリ連携)
 * ds4_convert の NMEA 生成仕様に完全準拠
 */
import { Session, TelemetryPoint } from '../types/telemetry';

export function calculateNmeaChecksum(sentence: string): string {
  let checksum = 0;
  for (let i = 0; i < sentence.length; i++) {
    checksum ^= sentence.charCodeAt(i);
  }
  return checksum.toString(16).toUpperCase().padStart(2, '0');
}

export function createNmeaSentence(bodyWithoutDollarAndChecksum: string): string {
  const checksum = calculateNmeaChecksum(bodyWithoutDollarAndChecksum);
  return `$${bodyWithoutDollarAndChecksum}*${checksum}\r\n`;
}

/**
 * 10進度数から NMEA 座標形式 (DDMM.MMMMMM) への変換
 */
export function formatNmeaCoord(val: number, isLat: boolean): { nmea: string; dir: string } {
  const sign = val >= 0;
  const absVal = Math.abs(val);
  const degrees = Math.floor(absVal);
  const minutes = (absVal - degrees) * 60;

  const degStr = isLat
    ? degrees.toString().padStart(2, '0')
    : degrees.toString().padStart(3, '0');
  const minStr = minutes.toFixed(6).padStart(9, '0');
  const dir = isLat ? (sign ? 'N' : 'S') : (sign ? 'E' : 'W');

  return {
    nmea: `${degStr}${minStr}`,
    dir
  };
}

/**
 * デジスパイス走行ログから RaceChrono 等で読み込める NMEA-0183 形式テキストを生成
 */
export function exportSessionToNmea(
  session: Session,
  options?: {
    lapNumber?: number; // 指定があればそのラップのみ抽出、なければ全セッション
    talkerId?: 'GP' | 'GN'; // デフォルト: 'GP'
    exportBothGgaAndRmc?: boolean; // デフォルト: true
  }
): string {
  const { lapNumber, talkerId = 'GP', exportBothGgaAndRmc = true } = options || {};

  let targetPoints: TelemetryPoint[] = session.points;

  if (lapNumber !== undefined) {
    const lap = session.laps.find(l => l.lapNumber === lapNumber);
    if (lap) {
      targetPoints = session.points.filter(p => p.time >= lap.startTime && p.time <= lap.endTime);
    }
  }

  if (targetPoints.length === 0) {
    return '';
  }

  const p0Time = session.points[0]?.timestamp ? new Date(session.points[0].timestamp) : new Date();
  let nmeaOutput = '';

  for (const pt of targetPoints) {
    // タイムスタンプの決定
    const dt = pt.timestamp ? new Date(pt.timestamp) : new Date(p0Time.getTime() + pt.time * 1000);

    const hh = dt.getUTCHours().toString().padStart(2, '0');
    const mm = dt.getUTCMinutes().toString().padStart(2, '0');
    const ss = dt.getUTCSeconds().toString().padStart(2, '0');
    const msPart = Math.round(dt.getUTCMilliseconds()).toString().padStart(3, '0');
    const timeStr = `${hh}${mm}${ss}.${msPart}`;

    const dy = dt.getUTCDate().toString().padStart(2, '0');
    const mo = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
    const yr = (dt.getUTCFullYear() % 100).toString().padStart(2, '0');
    const dateStr = `${dy}${mo}${yr}`;

    const { nmea: latNmea, dir: latDir } = formatNmeaCoord(pt.latitude, true);
    const { nmea: lonNmea, dir: lonDir } = formatNmeaCoord(pt.longitude, false);

    const speedKnots = (pt.speed || 0) / 1.852;
    const heading = pt.heading || 0;
    const altitude = pt.altitude || 10.0;

    // GGA センテンス (位置 & 標高 & 衛星数)
    if (exportBothGgaAndRmc) {
      const ggaBody = `${talkerId}GGA,${timeStr},${latNmea},${latDir},${lonNmea},${lonDir},1,12,0.9,${altitude.toFixed(1)},M,,M,,`;
      nmeaOutput += createNmeaSentence(ggaBody);
    }

    // RMC センテンス (推奨最小ナビゲーションデータ: 速度 & 方位 & 日付)
    const rmcBody = `${talkerId}RMC,${timeStr},A,${latNmea},${latDir},${lonNmea},${lonDir},${speedKnots.toFixed(1)},${heading.toFixed(2)},${dateStr},,,A`;
    nmeaOutput += createNmeaSentence(rmcBody);
  }

  return nmeaOutput;
}

/**
 * GPX 1.1 形式 XML の生成
 */
export function exportSessionToGpx(
  session: Session,
  lapNumber?: number
): string {
  let targetPoints: TelemetryPoint[] = session.points;

  if (lapNumber !== undefined) {
    const lap = session.laps.find(l => l.lapNumber === lapNumber);
    if (lap) {
      targetPoints = session.points.filter(p => p.time >= lap.startTime && p.time <= lap.endTime);
    }
  }

  const p0Time = session.points[0]?.timestamp ? new Date(session.points[0].timestamp) : new Date();

  const trkpts = targetPoints.map(pt => {
    const dt = pt.timestamp ? new Date(pt.timestamp) : new Date(p0Time.getTime() + pt.time * 1000);
    const speedMps = ((pt.speed || 0) / 3.6).toFixed(2);
    const alt = (pt.altitude || 0).toFixed(1);
    const course = (pt.heading || 0).toFixed(1);

    return `      <trkpt lat="${pt.latitude.toFixed(7)}" lon="${pt.longitude.toFixed(7)}">
        <ele>${alt}</ele>
        <time>${dt.toISOString()}</time>
        <course>${course}</course>
        <extensions>
          <speed>${speedMps}</speed>
        </extensions>
      </trkpt>`;
  }).join('\n');

  const lapLabel = lapNumber !== undefined ? `_Lap${lapNumber}` : '';
  const trackName = `${session.sessionName}${lapLabel}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DigiSpice Universal Suite" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${trackName}</name>
    <desc>Converted from DigiSpice GPS log file</desc>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${trackName}</name>
    <desc>${session.circuitName || 'Motorsport Circuit'} Tracklog</desc>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

/**
 * ファイルダウンロード発火ヘルパー
 */
export function triggerFileDownload(filename: string, content: string, mimeType: string = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
