import { TelemetryPoint } from '../types/telemetry';
import { calculatePhysics } from './physics';

/**
 * NMEAセンテンスのチェックサムを計算
 */
function calculateNmeaChecksum(sentence: string): string {
  let checksum = 0;
  for (let i = 0; i < sentence.length; i++) {
    checksum ^= sentence.charCodeAt(i);
  }
  return checksum.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * 10進度を NMEA 形式 (ddmm.mmmmmm) に変換
 */
function degToNmea(deg: number, isLat: boolean): { valStr: string; dirStr: string } {
  const abs = Math.abs(deg);
  const degrees = Math.floor(abs);
  const minutes = (abs - degrees) * 60;

  const degDigits = isLat ? 2 : 3;
  const degStr = degrees.toString().padStart(degDigits, '0');
  const minStr = minutes.toFixed(6).padStart(9, '0');
  const dirStr = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');

  return { valStr: `${degStr}${minStr}`, dirStr };
}

/**
 * NMEA 形式 (ddmm.mmmm) を 10進度に変換
 */
function nmeaToDeg(raw: string, dir: string): number {
  if (!raw || !dir) return 0;
  const isLat = dir === 'N' || dir === 'S';
  const degDigits = isLat ? 2 : 3;
  const deg = parseFloat(raw.substring(0, degDigits)) || 0;
  const min = parseFloat(raw.substring(degDigits)) || 0;
  const dec = deg + min / 60;
  return dir === 'S' || dir === 'W' ? -dec : dec;
}

/**
 * NMEA テキスト ($GPRMC / $GPGGA) をパース
 */
export function parseNmea(nmeaText: string): { points: TelemetryPoint[]; samplingRate: number } {
  const lines = nmeaText.split(/\r?\n/).filter(l => l.startsWith('$GP') || l.startsWith('$GN'));
  const points: TelemetryPoint[] = [];

  let startTimeSec: number | null = null;
  let currentAlt = 0;

  for (const line of lines) {
    const starIdx = line.indexOf('*');
    const content = starIdx !== -1 ? line.substring(1, starIdx) : line.substring(1);
    const parts = content.split(',');

    const type = parts[0].substring(2); // RMC or GGA

    if (type === 'GGA' && parts.length >= 10) {
      currentAlt = parseFloat(parts[9]) || currentAlt;
    } else if (type === 'RMC' && parts.length >= 10) {
      const status = parts[2];
      if (status !== 'A') continue; // Invalid fix

      const timeStr = parts[1]; // hhmmss.sss
      const latRaw = parts[3];
      const latDir = parts[4];
      const lonRaw = parts[5];
      const lonDir = parts[6];
      const speedKnots = parseFloat(parts[7]) || 0;
      const heading = parseFloat(parts[8]) || 0;

      const lat = nmeaToDeg(latRaw, latDir);
      const lon = nmeaToDeg(lonRaw, lonDir);
      const speedKmh = speedKnots * 1.852;

      let timeSec = 0;
      if (timeStr.length >= 6) {
        const h = parseInt(timeStr.substring(0, 2), 10);
        const m = parseInt(timeStr.substring(2, 4), 10);
        const s = parseFloat(timeStr.substring(4));
        const total = h * 3600 + m * 60 + s;
        if (startTimeSec === null) startTimeSec = total;
        timeSec = total - startTimeSec;
      } else {
        timeSec = points.length * 0.1;
      }

      points.push({
        index: points.length,
        time: Number(timeSec.toFixed(3)),
        latitude: Number(lat.toFixed(7)),
        longitude: Number(lon.toFixed(7)),
        altitude: Number(currentAlt.toFixed(2)),
        speed: Number(speedKmh.toFixed(2)),
        heading: Number(heading.toFixed(2)),
        distance: 0,
        accelG: 0,
        corneringG: 0,
        combinedG: 0,
        turningRadius: 9999,
        driftAngle: 0
      });
    }
  }

  const enriched = calculatePhysics(points);
  return { points: enriched, samplingRate: 10 };
}

/**
 * 走行データを NMEA 0183 ($GPRMC + $GPGGA) 形式でエクスポート (公式ツール & RaceChrono完全互換)
 */
export function exportNmea(points: TelemetryPoint[], baseDate = new Date(), talkerId: 'GP' | 'GN' = 'GP'): string {
  const lines: string[] = [];

  for (const p of points) {
    const curTime = new Date(baseDate.getTime() + p.time * 1000);
    const hh = curTime.getUTCHours().toString().padStart(2, '0');
    const mm = curTime.getUTCMinutes().toString().padStart(2, '0');
    const ss = curTime.getUTCSeconds().toString().padStart(2, '0');
    const mss = Math.floor(curTime.getUTCMilliseconds() / 10).toString().padStart(2, '0');
    const timeStr = `${hh}${mm}${ss}.${mss}`;

    const dd = curTime.getUTCDate().toString().padStart(2, '0');
    const mo = (curTime.getUTCMonth() + 1).toString().padStart(2, '0');
    const yy = (curTime.getUTCFullYear() % 100).toString().padStart(2, '0');
    const dateStr = `${dd}${mo}${yy}`;

    const latNmea = degToNmea(p.latitude, true);
    const lonNmea = degToNmea(p.longitude, false);
    const speedKnots = (p.speed / 1.852).toFixed(1);
    const heading = p.heading.toFixed(2);

    // GPRMC / GNRMC (公式ツール互換)
    const rmcBody = `${talkerId}RMC,${timeStr},A,${latNmea.valStr},${latNmea.dirStr},${lonNmea.valStr},${lonNmea.dirStr},${speedKnots},${heading},${dateStr},,,A`;
    const rmc = `$${rmcBody}*${calculateNmeaChecksum(rmcBody)}`;
    lines.push(rmc);

    // GPGGA / GNGGA
    const alt = p.altitude.toFixed(1);
    const ggaBody = `${talkerId}GGA,${timeStr},${latNmea.valStr},${latNmea.dirStr},${lonNmea.valStr},${lonNmea.dirStr},1,12,0.9,${alt},M,,M,,`;
    const gga = `$${ggaBody}*${calculateNmeaChecksum(ggaBody)}`;
    lines.push(gga);
  }

  return lines.join('\r\n');
}

/**
 * 走行データを GPX 1.1 形式でエクスポート (RaceChronoや各種GPSアプリ互換)
 */
export function exportGpx(points: TelemetryPoint[], trackName = 'Circuit Driving Tracklog', baseDate = new Date()): string {
  const pointsXml = points
    .map(p => {
      const curTime = new Date(baseDate.getTime() + p.time * 1000).toISOString();
      const speedMps = (p.speed / 3.6).toFixed(2);
      return `      <trkpt lat="${p.latitude.toFixed(6)}" lon="${p.longitude.toFixed(6)}">
        <ele>${p.altitude.toFixed(1)}</ele>
        <time>${curTime}</time>
        <course>${p.heading.toFixed(2)}</course>
        <extensions>
          <speed>${speedMps}</speed>
        </extensions>
      </trkpt>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DigiSpice Universal Analyser" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${trackName}</name>
    <desc>Converted from DigiSpice GPS log file</desc>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${trackName}</name>
    <trkseg>
${pointsXml}
    </trkseg>
  </trk>
</gpx>`;
}
