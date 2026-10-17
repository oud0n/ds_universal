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
  let minStr = minutes.toFixed(6).padStart(9, '0');
  let degOut = degStr;
  // 丸めで分が 60 になった場合は度へ繰り上げる
  if (parseFloat(minStr) >= 60) {
    minStr = (0).toFixed(6).padStart(9, '0');
    degOut = (degrees + 1).toString().padStart(degDigits, '0');
  }
  const dirStr = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');

  return { valStr: `${degOut}${minStr}`, dirStr };
}

/**
 * NMEA 形式 (ddmm.mmmm) を 10進度に変換
 */
function nmeaToDeg(raw: string, dir: string): number {
  // 読めない座標は NaN を返し、呼び出し側でその行を捨てる
  if (!raw || !/^[NSEW]$/.test(dir)) return NaN;
  const isLat = dir === 'N' || dir === 'S';
  const degDigits = isLat ? 2 : 3;
  const deg = parseFloat(raw.substring(0, degDigits));
  const min = parseFloat(raw.substring(degDigits));
  if (!Number.isFinite(deg) || !Number.isFinite(min) || min >= 60) return NaN;
  const dec = deg + min / 60;
  if (dec > (isLat ? 90 : 180)) return NaN;
  return dir === 'S' || dir === 'W' ? -dec : dec;
}

/** `$...*HH` のチェックサムが付いている行は検証する (付いていない行はそのまま通す) */
function hasValidNmeaChecksum(line: string): boolean {
  const m = /^\$([^*]*)\*([0-9A-Fa-f]{2})\s*$/.exec(line);
  if (!m) return !line.includes('*');
  return calculateNmeaChecksum(m[1]) === m[2].toUpperCase();
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * NMEA テキスト ($GPRMC / $GPGGA) をパース
 */
export function parseNmea(nmeaText: string): { points: TelemetryPoint[]; samplingRate: number; startDate?: Date } {
  const lines = nmeaText.split(/\r?\n/).filter(l => (l.startsWith('$GP') || l.startsWith('$GN')) && hasValidNmeaChecksum(l));
  const points: TelemetryPoint[] = [];

  let startTimeSec: number | null = null;
  let currentAlt = 0;
  // 日付をまたぐログで経過時間が負にならないよう、時刻が大きく戻ったら 1 日分を足す
  let dayOffset = 0;
  let prevTotal: number | null = null;
  // 日付付きの行から分かった記録開始日時
  let startDate: Date | undefined;
  // GGA (標高) と RMC を時刻で対応付けるための控え
  let ggaTime = '';
  let lastRmcTime = '';

  for (const line of lines) {
    const starIdx = line.indexOf('*');
    const content = starIdx !== -1 ? line.substring(1, starIdx) : line.substring(1);
    const parts = content.split(',');

    const type = parts[0].substring(2); // RMC or GGA

    if (type === 'GGA' && parts.length >= 10) {
      const alt = parseFloat(parts[9]);
      if (Number.isFinite(alt)) {
        currentAlt = alt;
        ggaTime = parts[1];
        // RMC → GGA の順で並ぶログでは、同じ時刻の直前の点にこの標高を付ける
        if (points.length > 0 && lastRmcTime === ggaTime) points[points.length - 1].altitude = Number(alt.toFixed(2));
      }
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
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const speedKmh = speedKnots * 1.852;
      lastRmcTime = timeStr;

      let timeSec = 0;
      // この行の絶対時刻 (UTC 秒)。日付欄が無い行では null
      let absoluteSec: number | null = null;
      if (timeStr.length >= 6) {
        const h = parseInt(timeStr.substring(0, 2), 10);
        const m = parseInt(timeStr.substring(2, 4), 10);
        const s = parseFloat(timeStr.substring(4));
        let total = h * 3600 + m * 60 + s;
        if (!Number.isFinite(total)) continue;
        // 日付欄 (ddmmyy) があれば絶対時刻にする。なければ、時刻が大きく戻ったときに 1 日分を足す
        const dm = /^(\d{2})(\d{2})(\d{2})$/.exec(parts[9] || '');
        if (dm) {
          total += Date.UTC(2000 + Number(dm[3]), Number(dm[2]) - 1, Number(dm[1])) / 1000;
          absoluteSec = total;
        } else {
          if (prevTotal !== null && total + dayOffset < prevTotal - 43200) dayOffset += 86400;
          total += dayOffset;
        }
        // 時刻が戻っている行は採用しない
        if (prevTotal !== null && total <= prevTotal) continue;
        prevTotal = total;
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
        driftAngle: 0,
        // 日付欄のある行は記録時刻を持たせる (再出力で現在時刻に置き換わらないようにする)
        ...(absoluteSec !== null ? { timestamp: new Date(absoluteSec * 1000).toISOString() } : {})
      });
      if (absoluteSec !== null && startDate === undefined) startDate = new Date(absoluteSec * 1000);
    }
  }

  const enriched = calculatePhysics(points);
  // 記録レートは時刻の刻みから求める
  let samplingRate = 10;
  if (points.length > 2) {
    const duration = points[points.length - 1].time - points[0].time;
    if (duration > 0) samplingRate = Math.max(1, Math.round((points.length - 1) / duration));
  }
  return { points: enriched, samplingRate, startDate };
}

/**
 * 走行データを NMEA 0183 ($GPRMC + $GPGGA) 形式でエクスポート (公式ツール & RaceChrono完全互換)
 */
export function exportNmea(points: TelemetryPoint[], baseDate = new Date(), talkerId: 'GP' | 'GN' = 'GP'): string {
  const lines: string[] = [];

  for (const p of points) {
    // ログの記録時刻があればそれを使う (なければ基準日時からの経過時間)
    const curTime = p.timestamp ? new Date(p.timestamp) : new Date(baseDate.getTime() + p.time * 1000);
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
      const curTime = (p.timestamp ? new Date(p.timestamp) : new Date(baseDate.getTime() + p.time * 1000)).toISOString();
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

  trackName = escapeXml(trackName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DS Universal" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
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
