/**
 * CSV の形式の定義 (PLAN-36。docs/csv_format_design.md)。
 * どこの機器・アプリの CSV でも、列が何の値か・単位・時刻の形・タイムゾーンを人が決めて保存し、読むときに使う。
 * - log: それだけで走行になる CSV (緯度・経度がある)。見出しの列で見分ける
 * - sensor: 走行の横に置く値だけの CSV (<走行>.<xxx>.csv)。xxx (機器のファイル名用の名前) で見分け、時刻で走行の点に合わせる
 */
import type { TelemetryPoint } from '../types/telemetry';
import { splitCsvLine } from './externalFormats';
import { calculatePhysics } from './physics';
import { CUSTOM_KEY_RE, customKeyOf, type BuiltinChannelId, type ChannelId } from './overlayLayout';

/** 列を何にするか。位置・速度などは走行の点の決まった欄、ほかは値 (決まった値か自分で名前を付けた値) */
export type ColumnTarget = 'lat' | 'lon' | 'alt' | 'speed' | 'heading' | 'satellites' | 'throttle' | 'brake' | 'steering' | 'rpm' | 'gear' | `custom:${string}`;

export interface ColumnSpec {
  /** 使わない列 */
  ignore?: boolean;
  target?: ColumnTarget;
  /** 速度の単位 (km/h に直す) */
  speedUnit?: 'km/h' | 'm/s' | 'mph' | 'kn';
  /** 値 = 読んだ値 × scale + offset (単位を換えるとき) */
  scale?: number;
  offset?: number;
  /** 自分で名前を付けた値の表示 (名前・単位・目盛り) */
  label?: string;
  unit?: string;
  min?: number;
  max?: number;
}

export type TimeAs = 'seconds' | 'ms' | 'utcMs' | 'clock';

export interface CsvFormat {
  version: 1;
  /** 印 (自分の形式は user:<ファイルの名前>) */
  id: string;
  name: string;
  kind: 'log' | 'sensor';
  /** sensor: <走行>.<xxx>.csv の xxx */
  sensorKey?: string;
  /** log: 見出しの列 (見分けるのに使う) */
  header: string[];
  /** 見出しの行 (0 から) */
  headerRow: number;
  delimiter: ',' | ';' | '\t';
  /** 時刻の列と形。無ければ行の順に 0.1 秒ずつ (log) / 走行の始まりから行の順 (sensor では使わない) */
  time: { column: string; as: TimeAs } | null;
  /** 時刻の列が UTC でないときのタイムゾーン (例: Asia/Tokyo)。clock の文字にタイムゾーンが書いてあれば、そちらを使う */
  timezone?: string;
  /** sensor の時刻が走行の始まりからの秒 (UTC でない) ときの、手で直すずれ (秒) */
  offsetSec?: number;
  columns: Record<string, ColumnSpec>;
}

export const POSITION_TARGETS: ColumnTarget[] = ['lat', 'lon', 'alt', 'speed', 'heading', 'satellites'];
const VALUE_FIELDS: BuiltinChannelId[] = ['throttle', 'brake', 'steering', 'rpm', 'gear'];
const SPEED_FACTOR = { 'km/h': 1, 'm/s': 3.6, mph: 1.609344, kn: 1.852 } as const;

const isTarget = (v: unknown): v is ColumnTarget =>
  typeof v === 'string' && ((POSITION_TARGETS as string[]).includes(v) || (VALUE_FIELDS as string[]).includes(v) || (v.startsWith('custom:') && CUSTOM_KEY_RE.test(v.slice(7))));
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 形式のファイルを読む (おかしな値は落とす。読めなければ null) */
export function parseCsvFormat(text: string | null, fallbackId: string): CsvFormat | null {
  if (!text) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || (o.kind !== 'log' && o.kind !== 'sensor')) return null;
  const columns: Record<string, ColumnSpec> = {};
  if (o.columns && typeof o.columns === 'object') {
    for (const [name, raw] of Object.entries(o.columns as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (r.ignore === true) { columns[name] = { ignore: true }; continue; }
      if (!isTarget(r.target)) continue;
      columns[name] = {
        target: r.target,
        ...(r.speedUnit === 'm/s' || r.speedUnit === 'mph' || r.speedUnit === 'kn' || r.speedUnit === 'km/h' ? { speedUnit: r.speedUnit } : {}),
        ...(fin(r.scale) && r.scale !== 0 ? { scale: r.scale } : {}),
        ...(fin(r.offset) ? { offset: r.offset } : {}),
        ...(typeof r.label === 'string' && r.label.trim() ? { label: r.label.trim().slice(0, 30) } : {}),
        ...(typeof r.unit === 'string' ? { unit: r.unit.slice(0, 12) } : {}),
        ...(fin(r.min) ? { min: r.min } : {}),
        ...(fin(r.max) ? { max: r.max } : {})
      };
    }
  }
  const t = o.time as Record<string, unknown> | null | undefined;
  const time = t && typeof t.column === 'string' && ['seconds', 'ms', 'utcMs', 'clock'].includes(t.as as string) ? { column: t.column, as: t.as as TimeAs } : null;
  return {
    version: 1,
    id: typeof o.id === 'string' && o.id ? o.id : fallbackId,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : fallbackId,
    kind: o.kind,
    ...(o.kind === 'sensor' && typeof o.sensorKey === 'string' && /^[a-z0-9][a-z0-9_]{0,39}$/.test(o.sensorKey) ? { sensorKey: o.sensorKey } : {}),
    header: Array.isArray(o.header) ? o.header.filter((x): x is string => typeof x === 'string').slice(0, 200) : [],
    headerRow: Number.isInteger(o.headerRow) && (o.headerRow as number) >= 0 && (o.headerRow as number) < 100 ? (o.headerRow as number) : 0,
    delimiter: o.delimiter === ';' || o.delimiter === '\t' ? o.delimiter : ',',
    time,
    ...(typeof o.timezone === 'string' && validTimezone(o.timezone) ? { timezone: o.timezone } : {}),
    ...(fin(o.offsetSec) ? { offsetSec: o.offsetSec } : {}),
    columns
  };
}

export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** 区切りで行を分ける (引用符に対応。, は今の分け方を使う) */
export function splitRow(line: string, delimiter: CsvFormat['delimiter']): string[] {
  if (delimiter === ',') return splitCsvLine(line);
  return line.split(delimiter).map(c => c.trim().replace(/^"(.*)"$/, '$1'));
}

/** 先頭の行から区切りを当てる (多いほう) */
export function guessDelimiter(text: string): CsvFormat['delimiter'] {
  const head = text.split(/\r?\n/).slice(0, 20).join('\n');
  const count = (c: string) => head.split(c).length;
  const best = ([',', ';', '\t'] as const).map(d => [d, count(d)] as const).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 1 ? best[0] : ',';
}

/** <走行>.<xxx>.csv の xxx (無ければ null) */
export function sensorKeyOf(fileName: string): string | null {
  const m = /\.([a-z0-9][a-z0-9_]{0,39})\.csv$/i.exec(fileName.slice(fileName.lastIndexOf('/') + 1));
  return m ? m[1].toLowerCase() : null;
}

/**
 * ファイルに合う形式。<走行>.<xxx>.csv は xxx が同じ sensor の形式。ほかは見出しの列が全部ある log の形式 (列が多く合うほう)
 */
export function matchCsvFormat(fileName: string, text: string, formats: CsvFormat[]): CsvFormat | null {
  const key = sensorKeyOf(fileName);
  if (key) {
    const s = formats.find(f => f.kind === 'sensor' && f.sensorKey === key);
    if (s) return s;
  }
  const lines = text.split(/\r?\n/, 120);
  let best: CsvFormat | null = null, bestScore = 0;
  for (const f of formats) {
    if (f.kind !== 'log' || !f.header.length) continue;
    const cells = splitRow(lines[f.headerRow] ?? '', f.delimiter).map(c => c.trim());
    if (f.header.every(h => cells.includes(h)) && f.header.length > bestScore) { best = f; bestScore = f.header.length; }
  }
  return best;
}

/** タイムゾーンの壁の時計の時刻 → UTC (ミリ秒) */
export function zonedToUtcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  // 夏時間の変わり目でも合うよう、2 回直す
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

/** 日時の文字を UTC のミリ秒に (タイムゾーンが書いてあればそれ、無ければ tz、tz も無ければ端末の時刻) */
export function parseClock(text: string, tz?: string): number | null {
  const v = text.trim();
  if (!v) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) { const t = Date.parse(v.replace(' ', 'T')); return Number.isFinite(t) ? t : null; }
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?$/.exec(v);
  if (m) {
    const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
    const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), ms] as const;
    if (tz) return zonedToUtcMs(...parts, tz);
    return new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], parts[6]).getTime();
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const num = (cell: string | undefined): number => {
  if (cell === undefined) return NaN;
  const v = cell.trim().replace(/^"(.*)"$/, '$1');
  return v === '' ? NaN : Number(v.replace(',', '.').match(/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i)?.[0] ?? NaN);
};

export interface FormatRows {
  /** 行ごとの時刻 (utc: true なら UTC のミリ秒、false なら秒) と、値 (列の行き先 → 値) */
  rows: Array<{ t: number; v: Partial<Record<ColumnTarget, number>> }>;
  utc: boolean;
}

/** 形式で CSV の行を読む (時刻の読めない行は捨てる) */
export function readRows(text: string, f: CsvFormat): FormatRows {
  const lines = text.split(/\r?\n/);
  const header = splitRow(lines[f.headerRow] ?? '', f.delimiter).map(c => c.trim());
  const cols = Object.entries(f.columns).flatMap(([name, spec]) => {
    const i = header.indexOf(name);
    return i >= 0 && !spec.ignore && spec.target ? [{ i, spec, target: spec.target }] : [];
  });
  const ti = f.time ? header.indexOf(f.time.column) : -1;
  const utc = !!f.time && (f.time.as === 'utcMs' || f.time.as === 'clock');
  const rows: FormatRows['rows'] = [];
  for (let li = f.headerRow + 1, n = 0; li < lines.length; li++) {
    if (!lines[li].trim()) continue;
    const cells = splitRow(lines[li], f.delimiter);
    let t: number;
    if (!f.time || ti < 0) t = n * 0.1;
    else if (f.time.as === 'clock') t = parseClock(cells[ti] ?? '', f.timezone) ?? NaN;
    else {
      const x = num(cells[ti]);
      t = f.time.as === 'ms' ? x / 1000 : x;
    }
    if (!Number.isFinite(t)) continue;
    n++;
    const v: Partial<Record<ColumnTarget, number>> = {};
    for (const c of cols) {
      let x = num(cells[c.i]);
      if (!Number.isFinite(x)) continue;
      if (c.target === 'speed') x *= SPEED_FACTOR[c.spec.speedUnit ?? 'km/h'];
      x = x * (c.spec.scale ?? 1) + (c.spec.offset ?? 0);
      v[c.target] = x;
    }
    rows.push({ t, v });
  }
  return { rows, utc };
}

/** 点に値を入れる (決まった値は点の欄、自分で名前を付けた値は custom) */
function setValue(p: TelemetryPoint, target: ColumnTarget, x: number): void {
  const key = customKeyOf(target as ChannelId);
  if (key !== null) p.custom = { ...(p.custom ?? {}), [key]: x };
  else if ((VALUE_FIELDS as string[]).includes(target)) (p as unknown as Record<string, number>)[target] = x;
}

/** log の形式で CSV を走行の点にする (位置の読めない行は捨てる) */
export function parseLogWithFormat(text: string, f: CsvFormat): { points: TelemetryPoint[]; samplingRate: number; startDate?: Date } {
  const { rows, utc } = readRows(text, f);
  const points: TelemetryPoint[] = [];
  for (const { t, v } of rows) {
    const lat = v.lat, lon = v.lon;
    if (!fin(lat) || !fin(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    const time = utc ? t / 1000 : t;
    if (points.length && time <= points[points.length - 1].time) continue;
    const p: TelemetryPoint = {
      index: points.length, time, latitude: lat, longitude: lon,
      altitude: fin(v.alt) ? v.alt : 0, ...(fin(v.alt) ? {} : { altitudeMissing: true }),
      speed: fin(v.speed) ? v.speed : 0, heading: fin(v.heading) ? ((v.heading % 360) + 360) % 360 : 0, distance: 0,
      accelG: 0, corneringG: 0, combinedG: 0, turningRadius: 9999, driftAngle: 0,
      ...(utc ? { timestamp: new Date(t).toISOString() } : {}),
      ...(fin(v.satellites) ? { satellites: Math.round(v.satellites) } : {})
    };
    for (const [target, x] of Object.entries(v) as [ColumnTarget, number][]) if (!(POSITION_TARGETS as string[]).includes(target)) setValue(p, target, x);
    points.push(p);
  }
  const t0 = points[0]?.time ?? 0;
  for (const p of points) p.time = Number((p.time - t0).toFixed(3));
  const enriched = calculatePhysics(points);
  const span = points.length > 1 ? points[points.length - 1].time - points[0].time : 0;
  const samplingRate = span > 0 ? Math.round((points.length - 1) / span) || 10 : 10;
  return { points: enriched, samplingRate, ...(utc && points.length ? { startDate: new Date(t0 * 1000) } : {}) };
}

/**
 * sensor の値を走行の点に合わせて入れる。startUtcMs は走行の先頭の UTC (無ければ、UTC の値は合わせられない)。
 * 2 つの行のあいだは直線でつなぐ (行の間が 2 秒より空いているところは入れない)。新しい点の列を返す (合わなければ元のまま)
 */
export function mergeSensorRows(points: TelemetryPoint[], startUtcMs: number | null, data: FormatRows, offsetSec = 0): TelemetryPoint[] {
  const rows = data.rows;
  if (!rows.length || (data.utc && startUtcMs === null)) return points;
  // 走行の点の時刻 (秒) で並べる
  const ts = rows.map(r => (data.utc ? (r.t - startUtcMs!) / 1000 : r.t + offsetSec));
  const order = ts.map((_, i) => i).sort((a, b) => ts[a] - ts[b]);
  const T = order.map(i => ts[i]), V = order.map(i => rows[i].v);
  const targets = [...new Set(rows.flatMap(r => Object.keys(r.v)))] as ColumnTarget[];
  if (!targets.length || T[T.length - 1] < (points[0]?.time ?? 0) || T[0] > (points[points.length - 1]?.time ?? 0)) return points;
  let j = 0, hit = false;
  const out = points.map(p => {
    while (j + 1 < T.length && T[j + 1] <= p.time) j++;
    const a = j, b = Math.min(j + 1, T.length - 1);
    if (p.time < T[a] - 1 || p.time > T[b] + 1) return p;
    const span = T[b] - T[a];
    if (span > 2) return p;
    const k = span > 0 ? Math.min(1, Math.max(0, (p.time - T[a]) / span)) : 0;
    const q: TelemetryPoint = { ...p };
    for (const target of targets) {
      const xa = V[a][target], xb = V[b][target];
      const x = fin(xa) && fin(xb) ? xa + (xb - xa) * k : fin(xa) ? xa : xb;
      if (fin(x)) { setValue(q, target, target === 'gear' ? Math.round(x) : x); hit = true; }
    }
    return q;
  });
  return hit ? out : points;
}

/** 形式にある自分で名前を付けた値の表示 */
export function customSpecsOf(formats: CsvFormat[]): Array<{ key: string; label: string; unit?: string; min?: number; max?: number }> {
  const out: Array<{ key: string; label: string; unit?: string; min?: number; max?: number }> = [];
  for (const f of formats) for (const spec of Object.values(f.columns)) {
    const key = spec.target ? customKeyOf(spec.target as ChannelId) : null;
    if (key) out.push({ key, label: spec.label ?? key, ...(spec.unit ? { unit: spec.unit } : {}), ...(fin(spec.min) ? { min: spec.min } : {}), ...(fin(spec.max) ? { max: spec.max } : {}) });
  }
  return out;
}
