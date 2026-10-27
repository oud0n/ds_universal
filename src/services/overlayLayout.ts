/**
 * 動画に重ねるメーターの並び (PLAN-08。設計は docs/meter_layout_design.md)。
 *
 * 部品の位置と大きさは、映像の四角に対する割合 (0〜1) で持つ。解像度・枠の大きさ・書き出しの大きさが変わっても同じ見え方になる。
 * 同梱のテンプレート (標準・データ多め・グラフ・最小) と、保管場所の overlays/<名前>.overlay.json に置く自分の並び。
 */
import type { Session, TelemetryPoint } from '../types/telemetry';

/** 部品の種類 */
export type OverlayPartType = 'speed' | 'gmeter' | 'lapPanel' | 'lapClock' | 'map' | 'zoomMap' | 'bar' | 'steering' | 'graph' | 'value' | 'delta' | 'image';

/** 値 (チャンネル)。部品の棒・グラフ・数字で選ぶ */
export type BuiltinChannelId = 'speed' | 'accelG' | 'corneringG' | 'combinedG' | 'throttle' | 'brake' | 'steering' | 'rpm' | 'gear' | 'altitude';
/** 決まった値と、自分で名前を付けた値 (CSV の形式の定義・計算式。custom:<名前>。PLAN-36) */
export type ChannelId = BuiltinChannelId | `custom:${string}`;

export interface ChannelDef {
  id: ChannelId;
  label: [string, string];
  /** 短い札 (棒の下など) */
  short: string;
  unit: string;
  min: number;
  max: number;
  decimals: number;
  get: (p: TelemetryPoint) => number | undefined;
}

export const CHANNELS: Record<BuiltinChannelId, ChannelDef> = {
  speed: { id: 'speed', label: ['速度', 'Speed'], short: 'SPD', unit: 'km/h', min: 0, max: 200, decimals: 0, get: p => p.speed },
  accelG: { id: 'accelG', label: ['加減速 G', 'Long. G'], short: 'LONG', unit: 'G', min: -1.5, max: 1.5, decimals: 2, get: p => p.accelG },
  corneringG: { id: 'corneringG', label: ['横 G', 'Lat. G'], short: 'LAT', unit: 'G', min: -1.5, max: 1.5, decimals: 2, get: p => p.corneringG },
  combinedG: { id: 'combinedG', label: ['合成 G', 'Combined G'], short: 'G', unit: 'G', min: 0, max: 1.5, decimals: 2, get: p => p.combinedG },
  throttle: { id: 'throttle', label: ['アクセル', 'Throttle'], short: 'THR', unit: '%', min: 0, max: 100, decimals: 0, get: p => p.throttle },
  brake: { id: 'brake', label: ['ブレーキ', 'Brake'], short: 'BRK', unit: '%', min: 0, max: 100, decimals: 0, get: p => p.brake },
  steering: { id: 'steering', label: ['ステアリング角', 'Steering'], short: 'STR', unit: '°', min: -450, max: 450, decimals: 0, get: p => p.steering },
  rpm: { id: 'rpm', label: ['回転数', 'RPM'], short: 'RPM', unit: 'rpm', min: 0, max: 9000, decimals: 0, get: p => p.rpm },
  gear: { id: 'gear', label: ['ギア', 'Gear'], short: 'GEAR', unit: '', min: 0, max: 6, decimals: 0, get: p => p.gear },
  altitude: { id: 'altitude', label: ['標高', 'Altitude'], short: 'ALT', unit: 'm', min: 0, max: 1000, decimals: 0, get: p => (p.altitudeMissing ? undefined : p.altitude) }
};

/** 自分で名前を付けた値の名前の形 (英小文字・数字・_。40 文字まで) */
export const CUSTOM_KEY_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;
export const customId = (key: string): ChannelId => `custom:${key}`;
export const customKeyOf = (id: ChannelId): string | null => (id.startsWith('custom:') ? id.slice(7) : null);

/** 自分で名前を付けた値の表示 (CSV の形式の定義・計算式から入れる) */
export interface CustomChannelSpec { key: string; label: string; unit?: string; min?: number; max?: number; decimals?: number; /** 計算式の値 (点から求める。無ければ点の custom) */ get?: (p: TelemetryPoint) => number | undefined }
const customDefs = new Map<string, ChannelDef>();
let customVersion = 0;
function customDef(spec: CustomChannelSpec): ChannelDef {
  const min = Number.isFinite(spec.min) ? spec.min! : 0;
  const max = Number.isFinite(spec.max) && spec.max! > min ? spec.max! : min + 100;
  return {
    id: customId(spec.key), label: [spec.label || spec.key, spec.label || spec.key], short: (spec.label || spec.key).slice(0, 5).toUpperCase(),
    unit: spec.unit ?? '', min, max, decimals: Number.isInteger(spec.decimals) ? spec.decimals! : 1,
    get: spec.get ?? (p => p.custom?.[spec.key])
  };
}
/** 自分で名前を付けた値の表示を入れ替える (形式の定義を読んだとき) */
export function setCustomChannels(specs: CustomChannelSpec[]): void {
  customDefs.clear();
  for (const s of specs) if (CUSTOM_KEY_RE.test(s.key) && !customDefs.has(s.key)) customDefs.set(s.key, customDef(s));
  customVersion++;
}
/** 値の表示 (決まった値・自分で名前を付けた値。知らない名前の値も、名前のまま出す) */
export function channelDef(id: ChannelId): ChannelDef {
  const key = customKeyOf(id);
  if (key === null) return CHANNELS[id as BuiltinChannelId] ?? CHANNELS.speed;
  return customDefs.get(key) ?? customDef({ key, label: key });
}
/** 選べる値の一覧 (決まった値と、表示を知っている自分で名前を付けた値) */
export function allChannels(): ChannelDef[] {
  return [...Object.values(CHANNELS), ...customDefs.values()];
}

/** そのログにある値 (どれかの点に値があるもの)。ログごとに 1 回だけ調べる */
const availableCache = new WeakMap<Session, { v: number; set: Set<ChannelId> }>();
export function availableChannels(session: Session | undefined | null): Set<ChannelId> {
  if (!session) return new Set(['speed']);
  const hit = availableCache.get(session);
  if (hit && hit.v === customVersion) return hit.set;
  const out = new Set<ChannelId>();
  const pts = session.points;
  // 全部の点は見ない (間引いて 2000 点ほど)
  const stride = Math.max(1, Math.floor(pts.length / 2000));
  for (const ch of Object.values(CHANNELS)) {
    for (let i = 0; i < pts.length; i += stride) {
      const v = ch.get(pts[i]);
      if (typeof v === 'number' && Number.isFinite(v) && (ch.id !== 'altitude' || v !== 0)) { out.add(ch.id); break; }
    }
  }
  // 計算式の値 (入れる値があるか、点で求めてみる)
  for (const ch of customDefs.values()) {
    if (out.has(ch.id)) continue;
    for (let i = 0; i < pts.length; i += stride) {
      const v = ch.get(pts[i]);
      if (typeof v === 'number' && Number.isFinite(v)) { out.add(ch.id); break; }
    }
  }
  // 自分で名前を付けた値 (点に入っている名前)
  for (let i = 0; i < pts.length; i += stride) {
    const c = pts[i].custom;
    if (c) for (const k of Object.keys(c)) if (Number.isFinite(c[k])) out.add(customId(k));
  }
  availableCache.set(session, { v: customVersion, set: out });
  return out;
}

interface PartBase {
  /** 並びの中の印 (出す・出さないを覚えるため) */
  id: string;
  type: OverlayPartType;
  /** 左上の位置と大きさ (映像の幅・高さに対する割合) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 不透明度 (0〜1。無ければ 1) */
  opacity?: number;
}

export type OverlayPart =
  | (PartBase & { type: 'speed' })
  | (PartBase & { type: 'gmeter' })
  | (PartBase & { type: 'lapPanel' })
  | (PartBase & { type: 'lapClock' })
  | (PartBase & { type: 'map'; compare?: boolean })
  /** 車のまわりを拡大した地図 (航空写真・コースの形・走った線・比べる周の線)。spanM: 横幅に入る距離 (m)。headingUp: 進む向きを上にする (無ければコース図と同じ北が上) */
  | (PartBase & { type: 'zoomMap'; spanM?: number; headingUp?: boolean; compare?: boolean; photo?: boolean })
  | (PartBase & { type: 'bar'; channel: ChannelId; min?: number; max?: number; color?: string; label?: string; horizontal?: boolean })
  | (PartBase & { type: 'steering'; maxDeg?: number })
  | (PartBase & { type: 'graph'; channels: ChannelId[]; window?: 'lap' | number; compare?: boolean })
  | (PartBase & { type: 'value'; channel: ChannelId; label?: string })
  | (PartBase & { type: 'delta'; maxSec?: number })
  /** 画像 (企業ロゴなど)。src は画像の中身 (data: の URL。並びのファイルに入れて、端末の間でそのまま使えるように) */
  | (PartBase & { type: 'image'; src: string });

/** 画像の部品の中身として受け付けるもの (PNG・JPEG・WebP・GIF の data: の URL。大きすぎるものは入れない) */
export const MAX_IMAGE_SRC = 1_500_000;
export const isImageSrc = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_IMAGE_SRC && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);

export interface OverlayLayout {
  version: 1;
  /** テンプレートの印 (同梱は builtin:standard など、自分の並びは名前) */
  id: string;
  name: [string, string];
  builtin?: boolean;
  parts: OverlayPart[];
  /** 小さな枠 (スマートフォンの枠・走行比較の枠) の部品。無ければ SMALL_PARTS (走行比較は COMPARE_LAYOUT) */
  small?: OverlayPart[];
}

/** この幅 (画面の px) より狭い枠は、小さな枠の並びにする */
export const SMALL_TILE_PX = 560;

/** 小さな枠の既定の部品: 大きく読めるもの (速度・ラップタイム・G) と、左上の小さなコース図 */
export const SMALL_PARTS: OverlayPart[] = [
  { id: 'map', type: 'map', x: 0.03, y: 0.04, w: 0.22, h: 0.38 },
  { id: 'speed', type: 'speed', x: 0.03, y: 0.72, w: 0.32, h: 0.24 },
  { id: 'clock', type: 'lapClock', x: 0.6, y: 0.04, w: 0.37, h: 0.14 },
  { id: 'g', type: 'gmeter', x: 0.75, y: 0.66, w: 0.22, h: 0.3 }
];

/** 部品の種類の名前 (画面に出す) */
export const PART_LABELS: Record<OverlayPartType, [string, string]> = {
  speed: ['速度', 'Speed'],
  gmeter: ['G', 'G'],
  lapPanel: ['ラップの欄', 'Lap panel'],
  lapClock: ['ラップタイム', 'Lap time'],
  map: ['コース図', 'Course map'],
  zoomMap: ['拡大した地図', 'Close-up map'],
  bar: ['値の棒', 'Bar'],
  steering: ['ハンドル', 'Steering wheel'],
  graph: ['グラフの帯', 'Graph strip'],
  value: ['数字の欄', 'Number'],
  delta: ['タイム差の棒', 'Delta bar'],
  image: ['画像 (ロゴなど)', 'Image (logo etc.)']
};

/** 部品の名前 (棒・数字は値の名前も) */
export function partLabel(p: OverlayPart, ja: boolean): string {
  const base = PART_LABELS[p.type][ja ? 0 : 1];
  if (p.type === 'bar' || p.type === 'value') return `${base}: ${channelDef(p.channel).label[ja ? 0 : 1]}`;
  if (p.type === 'graph') return `${base}: ${p.channels.map(c => channelDef(c).label[ja ? 0 : 1]).join('・')}`;
  return base;
}

/** 部品が使う値 (無いログでは、その部品を出さない) */
export function partChannels(p: OverlayPart): ChannelId[] {
  if (p.type === 'bar' || p.type === 'value') return [p.channel];
  if (p.type === 'graph') return p.channels;
  if (p.type === 'steering') return ['steering'];
  return [];
}

// 同梱のテンプレート。車載動画は上半分に前の景色、下に車内が映ることが多いので、景色の真ん中と手元は隠さず、
// 部品は下の帯と上の隅に寄せる (設計の 5)
const STANDARD: OverlayPart[] = [
  { id: 'map', type: 'map', x: 0.02, y: 0.035, w: 0.2, h: 0.32, compare: true },
  // コース図の下に、車のまわりを拡大した地図 (道幅の中のどこを走っているか)
  { id: 'zoom', type: 'zoomMap', x: 0.02, y: 0.375, w: 0.2, h: 0.3, spanM: 140, headingUp: false, compare: true, photo: true },
  { id: 'lap', type: 'lapPanel', x: 0.735, y: 0.035, w: 0.245, h: 0.4 },
  { id: 'speed', type: 'speed', x: 0.02, y: 0.83, w: 0.165, h: 0.13 },
  { id: 'g', type: 'gmeter', x: 0.85, y: 0.775, w: 0.13, h: 0.18 }
];

export const BUILTIN_LAYOUTS: OverlayLayout[] = [
  { version: 1, id: 'builtin:standard', name: ['標準', 'Standard'], builtin: true, parts: STANDARD, small: SMALL_PARTS },
  {
    version: 1, id: 'builtin:data', name: ['データ多め', 'More data'], builtin: true,
    parts: [
      ...STANDARD,
      { id: 'throttle', type: 'bar', channel: 'throttle', color: '#22c55e', label: 'THR', x: 0.2, y: 0.79, w: 0.028, h: 0.17 },
      { id: 'brake', type: 'bar', channel: 'brake', color: '#ef4444', label: 'BRK', x: 0.235, y: 0.79, w: 0.028, h: 0.17 },
      { id: 'steer', type: 'steering', x: 0.275, y: 0.79, w: 0.1, h: 0.17 },
      { id: 'rpm', type: 'value', channel: 'rpm', label: 'RPM', x: 0.385, y: 0.85, w: 0.09, h: 0.07 },
      { id: 'gear', type: 'value', channel: 'gear', label: 'GEAR', x: 0.48, y: 0.85, w: 0.06, h: 0.07 }
    ],
    // 小さな枠: コース図・速度・アクセル・ブレーキ・ラップタイム (選んだ並びの違いが狭い枠でも分かるように)
    small: [
      { id: 'map', type: 'map', x: 0.03, y: 0.04, w: 0.22, h: 0.38 },
      { id: 'speed', type: 'speed', x: 0.03, y: 0.72, w: 0.32, h: 0.24 },
      { id: 'throttle', type: 'bar', channel: 'throttle', color: '#22c55e', label: 'THR', x: 0.37, y: 0.66, w: 0.06, h: 0.3 },
      { id: 'brake', type: 'bar', channel: 'brake', color: '#ef4444', label: 'BRK', x: 0.45, y: 0.66, w: 0.06, h: 0.3 },
      { id: 'clock', type: 'lapClock', x: 0.6, y: 0.04, w: 0.37, h: 0.14 }
    ]
  },
  {
    version: 1, id: 'builtin:graph', name: ['グラフ', 'Graph'], builtin: true,
    parts: [
      { id: 'map', type: 'map', x: 0.02, y: 0.035, w: 0.2, h: 0.32, compare: true },
      { id: 'zoom', type: 'zoomMap', x: 0.02, y: 0.375, w: 0.2, h: 0.3, spanM: 140, headingUp: false, compare: true, photo: true },
      { id: 'lap', type: 'lapPanel', x: 0.735, y: 0.035, w: 0.245, h: 0.4 },
      { id: 'speed', type: 'speed', x: 0.02, y: 0.83, w: 0.165, h: 0.13 },
      { id: 'graph', type: 'graph', channels: ['speed'], window: 'lap', compare: true, x: 0.2, y: 0.8, w: 0.63, h: 0.17 },
      { id: 'g', type: 'gmeter', x: 0.85, y: 0.775, w: 0.13, h: 0.18 }
    ],
    small: [
      { id: 'map', type: 'map', x: 0.03, y: 0.04, w: 0.22, h: 0.38 },
      { id: 'speed', type: 'speed', x: 0.03, y: 0.5, w: 0.3, h: 0.22 },
      { id: 'clock', type: 'lapClock', x: 0.6, y: 0.04, w: 0.37, h: 0.14 },
      { id: 'graph', type: 'graph', channels: ['speed'], window: 'lap', compare: true, x: 0.03, y: 0.76, w: 0.94, h: 0.21 }
    ]
  },
  {
    version: 1, id: 'builtin:minimal', name: ['最小', 'Minimal'], builtin: true,
    parts: [
      { id: 'speed', type: 'speed', x: 0.02, y: 0.83, w: 0.165, h: 0.13 },
      { id: 'delta', type: 'delta', maxSec: 1, x: 0.38, y: 0.9, w: 0.24, h: 0.06 }
    ],
    small: [
      { id: 'speed', type: 'speed', x: 0.03, y: 0.72, w: 0.32, h: 0.24 },
      { id: 'delta', type: 'delta', maxSec: 1, x: 0.4, y: 0.84, w: 0.4, h: 0.12 }
    ]
  }
];

/** 走行比較の小さな枠の並び (速度・G・小さなラップタイムだけ。前からの形) */
export const COMPARE_LAYOUT: OverlayLayout = {
  version: 1, id: 'builtin:compare', name: ['走行比較', 'Compare'], builtin: true,
  parts: [
    { id: 'speed', type: 'speed', x: 0.02, y: 0.83, w: 0.165, h: 0.13 },
    { id: 'clock', type: 'lapClock', x: 0.82, y: 0.035, w: 0.16, h: 0.08 },
    { id: 'g', type: 'gmeter', x: 0.85, y: 0.775, w: 0.13, h: 0.18 }
  ]
};

/** 出さないことにした部品の印 (並びごと。ほかの並びの同じ印の部品は出したまま) */
export const hiddenKey = (layoutId: string, partId: string) => `${layoutId}#${partId}`;

/** テンプレートを選ぶ値の「自動」: アクセルのあるログはデータ多め、無ければ標準 */
export const AUTO_LAYOUT = 'auto';

export function resolveLayout(id: string, session: Session | undefined | null, custom: OverlayLayout[] = []): OverlayLayout {
  if (id !== AUTO_LAYOUT) {
    const hit = BUILTIN_LAYOUTS.find(l => l.id === id) ?? custom.find(l => l.id === id);
    if (hit) return hit;
  }
  const ch = availableChannels(session);
  return BUILTIN_LAYOUTS.find(l => l.id === (ch.has('throttle') || ch.has('brake') ? 'builtin:data' : 'builtin:standard'))!;
}

/** 並びの中で、出す部品 (出さないことにした部品と、値の無い部品を除く) */
export function visibleParts(layout: OverlayLayout, session: Session | undefined | null, hidden: ReadonlySet<string>): OverlayPart[] {
  const ch = availableChannels(session);
  return layout.parts.filter(p => !hidden.has(hiddenKey(layout.id, p.id)) && partChannels(p).every(c => ch.has(c)));
}

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const TYPES = new Set<OverlayPartType>(['speed', 'gmeter', 'lapPanel', 'lapClock', 'map', 'zoomMap', 'bar', 'steering', 'graph', 'value', 'delta', 'image']);
// 'toString' などの Object の名前を値として通さない
const isChannel = (v: unknown): v is ChannelId => typeof v === 'string'
  && (Object.prototype.hasOwnProperty.call(CHANNELS, v) || (v.startsWith('custom:') && CUSTOM_KEY_RE.test(v.slice(7))));

/** 並びのファイル (overlays/<名前>.overlay.json) を読む。おかしな部品は落とす。部品が 1 つも無ければ null */
export function parseOverlayLayout(text: string | null, fallbackId: string): OverlayLayout | null {
  if (!text) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.parts)) return null;
  const parts = parseParts(o.parts);
  if (!parts.length) return null;
  // 小さな枠の部品 (空の列は「何も出さない」として残す)
  const small = Array.isArray(o.small) ? parseParts(o.small) : null;
  const nm = Array.isArray(o.name) && typeof o.name[0] === 'string' ? [o.name[0], typeof o.name[1] === 'string' ? o.name[1] : o.name[0]] as [string, string]
    : typeof o.name === 'string' ? [o.name, o.name] as [string, string] : [fallbackId, fallbackId] as [string, string];
  return {
    version: 1, id: typeof o.id === 'string' && o.id && !o.id.startsWith('builtin:') ? o.id : fallbackId, name: nm, parts,
    ...(small ? { small } : {})
  };
}

/** 部品の列を読む (おかしな部品は落とす) */
function parseParts(list: unknown[]): OverlayPart[] {
  const parts: OverlayPart[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const type = r.type as OverlayPartType;
    const x = num(r.x, -0.5, 1.5), y = num(r.y, -0.5, 1.5), w = num(r.w, 0.005, 2), h = num(r.h, 0.005, 2);
    if (!TYPES.has(type) || x === null || y === null || w === null || h === null) continue;
    let id = typeof r.id === 'string' && r.id ? r.id : `${type}${parts.length}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    const base = { id, x, y, w, h, ...(num(r.opacity, 0, 1) !== null ? { opacity: r.opacity as number } : {}) };
    if (type === 'bar' || type === 'value') {
      if (!isChannel(r.channel)) continue;
      const label = typeof r.label === 'string' ? r.label.slice(0, 12) : undefined;
      if (type === 'bar') {
        parts.push({
          ...base, type, channel: r.channel,
          ...(typeof r.min === 'number' && Number.isFinite(r.min) ? { min: r.min } : {}),
          ...(typeof r.max === 'number' && Number.isFinite(r.max) ? { max: r.max } : {}),
          ...(typeof r.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(r.color) ? { color: r.color } : {}),
          ...(label ? { label } : {}),
          ...(r.horizontal === true ? { horizontal: true } : {})
        });
      } else parts.push({ ...base, type, channel: r.channel, ...(label ? { label } : {}) });
    } else if (type === 'graph') {
      const channels = Array.isArray(r.channels) ? r.channels.filter(isChannel).slice(0, 3) : [];
      if (!channels.length) continue;
      const window = r.window === 'lap' || r.window === undefined ? 'lap' : num(r.window, 2, 120) ?? 'lap';
      parts.push({ ...base, type, channels, window, ...(r.compare === true ? { compare: true } : {}) });
    } else if (type === 'steering') {
      parts.push({ ...base, type, ...(num(r.maxDeg, 30, 1080) !== null ? { maxDeg: r.maxDeg as number } : {}) });
    } else if (type === 'delta') {
      parts.push({ ...base, type, ...(num(r.maxSec, 0.1, 10) !== null ? { maxSec: r.maxSec as number } : {}) });
    } else if (type === 'map') {
      parts.push({ ...base, type, ...(r.compare === true ? { compare: true } : {}) });
    } else if (type === 'image') {
      if (!isImageSrc(r.src)) continue;
      parts.push({ ...base, type, src: r.src });
    } else if (type === 'zoomMap') {
      parts.push({
        ...base, type,
        ...(num(r.spanM, 20, 2000) !== null ? { spanM: r.spanM as number } : {}),
        // 既定はコース図と同じ北が上 (利用者の希望。進む向きを上にするのは選べる)
        ...(r.headingUp === true ? { headingUp: true } : { headingUp: false }),
        ...(r.compare === true ? { compare: true } : {}),
        ...(r.photo === false ? { photo: false } : { photo: true })
      });
    } else {
      parts.push({ ...base, type } as OverlayPart);
    }
  }
  return parts;
}
