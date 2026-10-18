import { Session, TelemetryPoint } from '../types/telemetry';
import { createNmeaSentence, formatNmeaCoord } from './nmeaExporter';

/**
 * 変換ページ用: 読み込んだ走行ログを、範囲と時刻を調整して他形式のテキストへ書き出す
 */

// 書き出す範囲: 全体 / ラップ 1 周 / セッション先頭からの経過秒で指定
export type ConvertRange =
  | { kind: 'all' }
  | { kind: 'lap'; lapNumber: number }
  | { kind: 'time'; startSec: number; endSec: number };

export interface ConvertedPoint {
  time: Date;        // 出力に使う時刻 (時差の調整後)
  elapsed: number;   // 範囲の先頭からの経過秒
  latitude: number;
  longitude: number;
  altitude: number | null; // 記録されていなければ null (書き出しでは空欄・省略)
  speed: number;     // km/h
  heading: number;
  satellites: number | null;
  distance: number;  // 範囲の先頭からの距離 (km)
  source: TelemetryPoint; // 元の点 (DTB のように解析値ごと書き出す形式で使う)
}

const recordedMs = (p: TelemetryPoint | undefined): number =>
  p && p.timestamp != null ? new Date(p.timestamp).getTime() : NaN;

/**
 * ログが記録時刻 (日付と時刻) を持っているか。持たないログは仮の日時で書き出すことになる
 */
export function hasRecordedClock(session: Session): boolean {
  return Number.isFinite(recordedMs(session.points[0]));
}

/**
 * セッションから範囲を切り出し、出力用の時刻を付ける。
 * 記録時刻を持たないログ (一部の CSV など) は、セッションの日付の 0 時をログの先頭として時刻を作る
 */
export function selectConvertPoints(session: Session, range: ConvertRange, offsetHours = 0): ConvertedPoint[] {
  let source: TelemetryPoint[] = session.points;
  // source の time に足すとセッション先頭基準の秒になる値
  let timeBase = 0;
  if (range.kind === 'lap') {
    // ラップの点列は計測線上の補間点を両端に持ち、time がラップ開始からの秒になっている
    const lap = session.laps.find(l => l.lapNumber === range.lapNumber);
    source = lap ? lap.points : [];
    timeBase = lap ? lap.startTime : 0;
  } else if (range.kind === 'time') {
    source = session.points.filter(p => p.time >= range.startSec && p.time <= range.endSec);
  }
  source = source.filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  if (source.length === 0) return [];

  const fallbackBase = Date.parse(`${session.date}T00:00:00Z`);
  const baseMs = Number.isFinite(fallbackBase) ? fallbackBase : Date.UTC(2000, 0, 1);
  const sessionT0 = session.points[0]?.time ?? 0;
  const offsetMs = offsetHours * 3600 * 1000;
  const t0 = source[0].time;
  const d0 = source[0].distance;

  return source.map(p => {
    const recorded = recordedMs(p);
    const ms = (Number.isFinite(recorded) ? recorded : baseMs + (timeBase + p.time - sessionT0) * 1000) + offsetMs;
    return {
      time: new Date(ms),
      elapsed: p.time - t0,
      latitude: p.latitude,
      longitude: p.longitude,
      altitude: !p.altitudeMissing && Number.isFinite(p.altitude) ? p.altitude : null,
      speed: Number.isFinite(p.speed) ? p.speed : 0,
      heading: Number.isFinite(p.heading) ? p.heading : 0,
      satellites: Number.isInteger(p.satellites) ? (p.satellites as number) : null,
      distance: p.distance - d0,
      source: p
    };
  });
}

/**
 * DTB 用: 経過時間と距離を範囲の先頭から数え直し、調整後の時刻を記録時刻として持たせた点列
 */
export function toTelemetryPoints(points: ConvertedPoint[]): TelemetryPoint[] {
  return points.map((c, i) => ({
    ...c.source,
    index: i,
    time: Number(c.elapsed.toFixed(4)),
    distance: Number(c.distance.toFixed(4)),
    oleDate: undefined,
    timestamp: c.time.toISOString()
  }));
}

const pad = (n: number, width = 2) => n.toString().padStart(width, '0');

/**
 * NMEA 0183 (GGA + RMC)。includeGga を false にすると RMC のみ
 */
export function convertToNmea(points: ConvertedPoint[], talkerId: 'GP' | 'GN' = 'GP', includeGga = true): string {
  const lines: string[] = [];
  for (const p of points) {
    const t = p.time;
    const timeStr = `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}.${pad(t.getUTCMilliseconds(), 3)}`;
    const dateStr = `${pad(t.getUTCDate())}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCFullYear() % 100)}`;
    const lat = formatNmeaCoord(p.latitude, true);
    const lon = formatNmeaCoord(p.longitude, false);
    if (includeGga) {
      // 記録されていない項目 (衛星数・HDOP・標高・ジオイド高) は固定値で埋めず、空欄にする
      const sat = p.satellites != null ? pad(Math.min(99, Math.max(0, p.satellites))) : '';
      const alt = p.altitude != null ? p.altitude.toFixed(1) : '';
      lines.push(createNmeaSentence(`${talkerId}GGA,${timeStr},${lat.nmea},${lat.dir},${lon.nmea},${lon.dir},1,${sat},,${alt},M,,M,,`).trimEnd());
    }
    lines.push(createNmeaSentence(`${talkerId}RMC,${timeStr},A,${lat.nmea},${lat.dir},${lon.nmea},${lon.dir},${(p.speed / 1.852).toFixed(1)},${p.heading.toFixed(2)},${dateStr},,,A`).trimEnd());
  }
  return lines.length > 0 ? lines.join('\r\n') + '\r\n' : '';
}

const escapeXml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * GPX 1.1。速度 (m/s) と方位は Garmin の TrackPointExtension v2 として付ける
 */
export function convertToGpx(points: ConvertedPoint[], trackName: string): string {
  const name = escapeXml(trackName);
  const body = points
    .map(p => {
      const sat = p.satellites != null ? `\n        <sat>${p.satellites}</sat>` : '';
      const ele = p.altitude != null ? `\n        <ele>${p.altitude.toFixed(1)}</ele>` : '';
      return `      <trkpt lat="${p.latitude.toFixed(7)}" lon="${p.longitude.toFixed(7)}">${ele}
        <time>${p.time.toISOString()}</time>${sat}
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:speed>${(p.speed / 3.6).toFixed(2)}</gpxtpx:speed>
            <gpxtpx:course>${p.heading.toFixed(2)}</gpxtpx:course>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DS Universal" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2">
  <metadata>
    <name>${name}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${body}
    </trkseg>
  </trk>
</gpx>
`;
}

// KML の線の色 (車速の低い方から: 青 → 水色 → 緑 → 黄 → 橙 → 赤)。KML の色は aabbggrr
const KML_SPEED_COLORS = ['ffff4d2e', 'ffffc22e', 'ff3ecf4c', 'ff2ee6f2', 'ff1f8cff', 'ff3030e8'];

/**
 * Google Earth 用の KML。車速を 6 段に分け、同じ段の続く区間ごとに色を付けた線にする。
 * 線は地面に沿わせる (標高は使わない)。始まりと終わりに印を置く
 */
export function convertToKml(points: ConvertedPoint[], title: string): string {
  const name = escapeXml(title);
  // 点の多いログで引数の上限を超えないよう、Math.min(...) は使わない
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.speed)) continue;
    if (p.speed < min) min = p.speed;
    if (p.speed > max) max = p.speed;
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  const bin = (v: number) => (max > min ? Math.min(KML_SPEED_COLORS.length - 1, Math.floor(((v - min) / (max - min)) * KML_SPEED_COLORS.length)) : 0);
  const coord = (p: ConvertedPoint) => `${p.longitude.toFixed(7)},${p.latitude.toFixed(7)},0`;

  const styles = KML_SPEED_COLORS.map((c, i) =>
    `    <Style id="s${i}"><LineStyle><color>${c}</color><width>4</width></LineStyle></Style>`).join('\n');
  // 区間の切れ目の点は前後の区間の両方に入れて、線をつなげる
  const segments: string[] = [];
  for (let i = 0; i < points.length - 1; ) {
    const b = bin(points[i].speed);
    let j = i + 1;
    while (j < points.length - 1 && bin(points[j].speed) === b) j++;
    const lo = min + ((max - min) * b) / KML_SPEED_COLORS.length;
    const hi = min + ((max - min) * (b + 1)) / KML_SPEED_COLORS.length;
    segments.push(`      <Placemark>
        <name>${lo.toFixed(0)}〜${hi.toFixed(0)} km/h</name>
        <styleUrl>#s${b}</styleUrl>
        <LineString><tessellate>1</tessellate><coordinates>${points.slice(i, j + 1).map(coord).join(' ')}</coordinates></LineString>
      </Placemark>`);
    i = j;
  }
  const mark = (label: string, p: ConvertedPoint) => `    <Placemark>
      <name>${label}</name>
      <TimeStamp><when>${p.time.toISOString()}</when></TimeStamp>
      <Point><coordinates>${coord(p)}</coordinates></Point>
    </Placemark>`;
  const first = points[0];
  const last = points[points.length - 1];
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${name}</name>
    <description>DS Universal で書き出し。線の色は車速 (${min.toFixed(0)}〜${max.toFixed(0)} km/h、青が遅く赤が速い)</description>
${styles}
    <Folder>
      <name>走行ライン (車速)</name>
${segments.join('\n')}
    </Folder>
${first ? mark('START', first) : ''}
${last ? mark('END', last) : ''}
  </Document>
</kml>
`;
}

/**
 * 汎用 CSV (1 行 1 点)
 */
export function convertToCsv(points: ConvertedPoint[]): string {
  const rows = ['time_utc,elapsed_s,latitude,longitude,altitude_m,speed_kmh,heading_deg,satellites,distance_km'];
  for (const p of points) {
    rows.push([
      p.time.toISOString(),
      p.elapsed.toFixed(3),
      p.latitude.toFixed(7),
      p.longitude.toFixed(7),
      p.altitude != null ? p.altitude.toFixed(1) : '',
      p.speed.toFixed(2),
      p.heading.toFixed(2),
      p.satellites ?? '',
      p.distance.toFixed(4)
    ].join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

/**
 * 等間隔に間引く (先頭と末尾は必ず残す)
 */
export function decimate<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount || maxCount < 2) return items;
  const out: T[] = [];
  const step = (items.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i++) out.push(items[Math.round(i * step)]);
  return out;
}

/**
 * 地図付きの単体 HTML (Leaflet + OpenStreetMap)。軌跡は 1 本の線として描き、点数の多いログでも軽くする
 */
export function convertToHtmlMap(points: ConvertedPoint[], title: string): string {
  const line = decimate(points, 20000).map(p => [Number(p.latitude.toFixed(6)), Number(p.longitude.toFixed(6))]);
  const maxSpeed = points.reduce((m, p) => Math.max(m, p.speed), 0);
  const first = points[0];
  const last = points[points.length - 1];
  const info = first && last
    ? `${first.time.toISOString()} 〜 ${last.time.toISOString()} / ${points.length} 点 / 最高 ${maxSpeed.toFixed(1)} km/h`
    : '';
  // </script> などが紛れ込まないよう、埋め込む JSON の < をエスケープする
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#map{height:100%;margin:0}#info{position:absolute;z-index:1000;top:8px;left:50px;background:#fff;padding:4px 8px;border-radius:4px;font:12px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3)}</style>
</head>
<body>
<div id="info">${escapeXml(title)}<br>${escapeXml(info)}</div>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var line = ${json(line)};
var map = L.map('map', { preferCanvas: true });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
if (line.length > 0) {
  var track = L.polyline(line, { color: '#e11d48', weight: 3 }).addTo(map);
  L.circleMarker(line[0], { radius: 6, color: '#16a34a' }).bindTooltip('START').addTo(map);
  L.circleMarker(line[line.length - 1], { radius: 6, color: '#2563eb' }).bindTooltip('END').addTo(map);
  map.fitBounds(track.getBounds());
} else {
  map.setView([35.68, 139.76], 5);
}
</script>
</body>
</html>
`;
}
