import { TelemetryPoint, type GgaFields } from '../types/telemetry';
import { calculatePhysics, calculateGeoDistanceAndHeading } from './physics';
import { calculateNmeaChecksum } from './nmeaExporter';

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

/** hhmmss.sss を 0 時からの秒にする (読めなければ NaN) */
function parseTimeOfDay(timeStr: string): number {
  if (!/^\d{6}(\.\d+)?$/.test(timeStr)) return NaN;
  const h = parseInt(timeStr.substring(0, 2), 10);
  const m = parseInt(timeStr.substring(2, 4), 10);
  const sec = parseFloat(timeStr.substring(4));
  return h * 3600 + m * 60 + sec;
}

/** GGA から読む値。標高・衛星数は空欄なら null */
interface GgaFix {
  tod: number;
  latitude: number;
  longitude: number;
  altitude: number | null;
  satellites: number | null;
  /** 品質・HDOP など (どれも決まりの値か空欄なら null) */
  fields: GgaFields | null;
}

/** GGA の品質・HDOP・ジオイド高・DGPS の欄。品質が 1 でほかが空欄なら null (持たなくても同じに書き戻せる) */
function ggaFieldsOf(parts: string[]): GgaFields | null {
  const f: GgaFields = {
    quality: parts[6] ?? '',
    hdop: parts[8] ?? '',
    geoidSep: parts[11] ?? '',
    dgpsAge: parts[13] ?? '',
    dgpsStation: parts[14] ?? ''
  };
  // 文字の決まりに合わない値は書き戻さない (壊れた行で書き出しの文がおかしくならないように)
  for (const k of Object.keys(f) as (keyof GgaFields)[]) if (!/^[-+]?[0-9.]*$/.test(f[k])) f[k] = '';
  if ((f.quality === '1' || f.quality === '') && !f.hdop && !f.geoidSep && !f.dgpsAge && !f.dgpsStation) return null;
  return f;
}

/**
 * ファイル名の日付 (例: 20261012133132.nmea・log_2026-10-12.nmea)。
 * dayMs はその日の 0 時 (UTC として)、localMs は時刻まで書いてあればその時刻 (UTC として)、なければ null
 */
export function fileDateHint(name: string): { dayMs: number; localMs: number | null } | null {
  const m = /(?:^|\D)(20\d{2})[-_]?(\d{2})[-_]?(\d{2})(?:[-_T ]?(\d{2})[-_:]?(\d{2})(?:[-_:]?(\d{2}))?)?/.exec(name);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dayMs = Date.UTC(y, mo - 1, d);
  const check = new Date(dayMs);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  const hasTime = m[4] !== undefined && h < 24 && mi < 60 && s < 60;
  return { dayMs, localMs: hasTime ? dayMs + ((h * 60 + mi) * 60 + s) * 1000 : null };
}

/**
 * ログの最初の時刻 (UTC の 0 時からの秒) が、何日の UTC か。
 * ファイル名は端末の時刻で付くことが多いので、時刻まで書いてあれば、前後 1 日のうちファイル名の時刻にいちばん近い日にする
 * (時差が 12 時間より小さければ正しい日になる)
 */
function utcDayFromHint(hint: { dayMs: number; localMs: number | null }, tod: number): number {
  if (hint.localMs === null) return hint.dayMs;
  let best = hint.dayMs;
  for (const d of [-1, 0, 1]) {
    const day = hint.dayMs + d * 86400000;
    if (Math.abs(day + tod * 1000 - hint.localMs) < Math.abs(best + tod * 1000 - hint.localMs)) best = day;
  }
  return best;
}

const sameTime = (a: number, b: number) => Math.abs(a - b) < 0.0005;

const blankPoint = (): Omit<TelemetryPoint, 'index' | 'time' | 'latitude' | 'longitude' | 'altitude' | 'speed' | 'heading'> => ({
  distance: 0,
  accelG: 0,
  corneringG: 0,
  combinedG: 0,
  turningRadius: 9999,
  driftAngle: 0
});

/** GGA の標高・衛星数を点に付ける (GGA が無い・標高が空欄なら、標高は未記録として扱う) */
function applyGga(p: TelemetryPoint, gga: GgaFix | null) {
  if (gga?.altitude != null) {
    p.altitude = Number(gga.altitude.toFixed(2));
    delete p.altitudeMissing;
  } else {
    p.altitude = 0;
    p.altitudeMissing = true;
  }
  if (gga?.satellites != null) p.satellites = gga.satellites;
  else delete p.satellites;
  if (gga?.fields) p.ggaFields = gga.fields;
  else delete p.ggaFields;
}

/**
 * NMEA テキスト ($GPRMC / $GPGGA) をパース。
 * RMC を位置・速度・日付の元にし、同じ時刻の GGA から標高と衛星数を付ける。
 * RMC の無い GGA だけのログは、GGA の位置から速度と方位を求める
 */
export function parseNmea(nmeaText: string, fileName = ''): { points: TelemetryPoint[]; samplingRate: number; startDate?: Date } {
  // 日付の欄が無いログ (GGA だけなど) は、ファイル名の日付で日時を決める
  const hint = fileDateHint(fileName);
  let hintDayMs: number | null = null;
  const lines = nmeaText.split(/\r?\n/).map(l => l.trim()).filter(l => (l.startsWith('$GP') || l.startsWith('$GN')) && hasValidNmeaChecksum(l));
  let points: TelemetryPoint[] = [];

  let startTimeSec: number | null = null;
  // 日付をまたぐログで経過時間が負にならないよう、時刻が大きく戻ったら 1 日分を足す
  let dayOffset = 0;
  let prevTotal: number | null = null;
  // 日付付きの行から分かった記録開始日時
  let startDate: Date | undefined;
  // GGA と RMC を時刻で対応付けるための控え
  let lastGga: GgaFix | null = null;
  let lastRmcTod = NaN;
  // RMC の無いログのために、GGA の測位も取っておく
  const ggaFixes: GgaFix[] = [];

  for (const line of lines) {
    const starIdx = line.indexOf('*');
    const content = starIdx !== -1 ? line.substring(1, starIdx) : line.substring(1);
    const parts = content.split(',');

    const type = parts[0].substring(2); // RMC or GGA

    if (type === 'GGA' && parts.length >= 10) {
      // 測位品質 0 は測位できていない
      if (parts[6] === '0') continue;
      const tod = parseTimeOfDay(parts[1]);
      if (!Number.isFinite(tod)) continue;
      const alt = parts[9] === '' ? NaN : parseFloat(parts[9]);
      const sats = /^\d+$/.test(parts[7] ?? '') ? parseInt(parts[7], 10) : NaN;
      const gga: GgaFix = {
        tod,
        latitude: nmeaToDeg(parts[2], parts[3]),
        longitude: nmeaToDeg(parts[4], parts[5]),
        altitude: Number.isFinite(alt) ? alt : null,
        satellites: Number.isFinite(sats) ? sats : null,
        fields: ggaFieldsOf(parts)
      };
      lastGga = gga;
      if (Number.isFinite(gga.latitude) && Number.isFinite(gga.longitude)) ggaFixes.push(gga);
      // RMC → GGA の順で並ぶログでは、同じ時刻の直前の点に付ける
      if (points.length > 0 && sameTime(lastRmcTod, tod)) applyGga(points[points.length - 1], gga);
    } else if (type === 'RMC' && parts.length >= 10) {
      const status = parts[2];
      if (status !== 'A') continue; // Invalid fix

      const timeStr = parts[1]; // hhmmss.sss
      const speedKnots = parseFloat(parts[7]) || 0;
      const heading = parseFloat(parts[8]) || 0;

      const lat = nmeaToDeg(parts[3], parts[4]);
      const lon = nmeaToDeg(parts[5], parts[6]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const speedKmh = speedKnots * 1.852;

      let timeSec = 0;
      // この行の絶対時刻 (UTC 秒)。日付欄が無い行では null
      let absoluteSec: number | null = null;
      const tod = parseTimeOfDay(timeStr);
      if (Number.isFinite(tod)) {
        let total = tod;
        // 日付欄 (ddmmyy) があれば絶対時刻にする。なければ、時刻が大きく戻ったときに 1 日分を足す
        const dm = /^(\d{2})(\d{2})(\d{2})$/.exec(parts[9] || '');
        if (dm) {
          total += Date.UTC(2000 + Number(dm[3]), Number(dm[2]) - 1, Number(dm[1])) / 1000;
          absoluteSec = total;
        } else {
          // ファイル名の日付があれば、その日の 0 時 (UTC) を足して日時にする。前の行との比べも、同じ基準でする
          const daySec = hint ? (hintDayMs ??= utcDayFromHint(hint, tod)) / 1000 : 0;
          if (prevTotal !== null && daySec + total + dayOffset < prevTotal - 43200) dayOffset += 86400;
          total += daySec + dayOffset;
          if (hint) absoluteSec = total;
        }
        // 時刻が戻っている行は採用しない
        if (prevTotal !== null && total <= prevTotal) continue;
        prevTotal = total;
        if (startTimeSec === null) startTimeSec = total;
        timeSec = total - startTimeSec;
      } else {
        timeSec = points.length * 0.1;
      }
      lastRmcTod = tod;

      const point: TelemetryPoint = {
        index: points.length,
        time: Number(timeSec.toFixed(3)),
        latitude: Number(lat.toFixed(7)),
        longitude: Number(lon.toFixed(7)),
        altitude: 0,
        // 0.001 ノットの細かさを残す (書き出し・読み込みを繰り返しても速度が変わらないように)
        speed: Number(speedKmh.toFixed(4)),
        heading: Number(heading.toFixed(2)),
        ...blankPoint(),
        // 日付欄のある行は記録時刻を持たせる (再出力で現在時刻に置き換わらないようにする)
        ...(absoluteSec !== null ? { timestamp: new Date(absoluteSec * 1000).toISOString() } : {})
      };
      // GGA → RMC の順なら直前の GGA が同じ時刻。GGA の記録が RMC より粗いログでは、1 秒以内の直前の GGA の値を使う。
      // RMC → GGA の順では、後から来る同じ時刻の GGA で置き換わる
      // (0 時をまたぐときは 1 日分を足し引きして比べる)
      const ggaAge = lastGga ? ((tod - lastGga.tod + 86400 + 43200) % 86400) - 43200 : NaN;
      applyGga(point, lastGga && ggaAge > -0.0005 && ggaAge < 1.0005 ? lastGga : null);
      points.push(point);
      if (absoluteSec !== null && startDate === undefined) startDate = new Date(absoluteSec * 1000);
    }
  }

  // 使える RMC が 1 点以下なら、GGA の測位から点列を作る
  if (points.length < 2 && ggaFixes.length >= 2) {
    points = pointsFromGga(ggaFixes);
    // GGA には日付が無い。ファイル名に日付があれば、それで日時を付ける
    if (hint && points.length > 0) {
      const t0 = utcDayFromHint(hint, ggaFixes[0].tod) + ggaFixes[0].tod * 1000;
      for (const p of points) p.timestamp = new Date(t0 + p.time * 1000).toISOString();
      startDate = new Date(t0);
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
 * GGA だけのログの点列。GGA には日付・速度・方位が無いので、時刻は先頭からの経過秒だけを持ち、
 * 速度と方位は前後の点の位置から求める
 */
function pointsFromGga(fixes: GgaFix[]): TelemetryPoint[] {
  const rows: { t: number; f: GgaFix }[] = [];
  let dayOffset = 0;
  let prev: number | null = null;
  for (const f of fixes) {
    if (prev !== null && f.tod + dayOffset < prev - 43200) dayOffset += 86400;
    const t = f.tod + dayOffset;
    if (prev !== null && t <= prev) continue;
    prev = t;
    rows.push({ t, f });
  }
  if (rows.length < 2) return [];
  const t0 = rows[0].t;
  return rows.map((r, i) => {
    const a = rows[Math.max(0, i - 1)];
    const b = rows[Math.min(rows.length - 1, i + 1)];
    const { distanceMeters, headingDeg } = calculateGeoDistanceAndHeading(a.f.latitude, a.f.longitude, b.f.latitude, b.f.longitude);
    const dt = b.t - a.t;
    const p: TelemetryPoint = {
      index: i,
      time: Number((r.t - t0).toFixed(3)),
      latitude: Number(r.f.latitude.toFixed(7)),
      longitude: Number(r.f.longitude.toFixed(7)),
      altitude: 0,
      speed: Number((dt > 0 ? (distanceMeters / dt) * 3.6 : 0).toFixed(2)),
      heading: Number(headingDeg.toFixed(2)),
      ...blankPoint()
    };
    applyGga(p, r.f);
    return p;
  });
}
