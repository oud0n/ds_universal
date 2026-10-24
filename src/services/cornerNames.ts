/**
 * コーナーの名前 (PLAN-27、設計は docs/corner_names_design.md)。
 * コースのフォルダの corners.json に、コーナーごとの入口・頂点・出口の位置と名前を持つ。
 * 解析では、それぞれの周でその位置にいちばん近い点を探して、今のコーナー (Corner) の形にする。
 */

import type { Corner, LapGeometry } from './drivingAnalysis';

export const CORNERS_FILE = 'corners.json';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface NamedCorner {
  name: string;
  direction: 'L' | 'R';
  entry: LatLon;
  apex: LatLon;
  exit: LatLon;
}

export interface CornerFile {
  version: 1;
  /** コースのフォルダの名前 (確かめのため) */
  course: string;
  corners: NamedCorner[];
  /** 自動で作ったまま (ユーザーがまだ直していない) */
  auto: boolean;
  updatedAt: string;
}

/** 周の点がコーナーの位置からこれより遠ければ、そのコーナーは「対応区間なし」(m) */
export const PLACE_MAX_DISTANCE_M = 30;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isLatLon = (v: unknown): v is LatLon =>
  !!v && typeof v === 'object' && isNum((v as LatLon).lat) && isNum((v as LatLon).lon) && Math.abs((v as LatLon).lat) <= 90 && Math.abs((v as LatLon).lon) <= 180;

/** corners.json を読む。形が違えば null (壊れたファイルで解析を止めない) */
export function parseCornerFile(text: string | null): CornerFile | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw as Partial<CornerFile>;
  if (!r || r.version !== 1 || !Array.isArray(r.corners)) return null;
  const corners: NamedCorner[] = [];
  for (const c of r.corners as unknown[]) {
    const x = c as Partial<NamedCorner>;
    if (!x || typeof x.name !== 'string' || (x.direction !== 'L' && x.direction !== 'R') || !isLatLon(x.entry) || !isLatLon(x.apex) || !isLatLon(x.exit)) return null;
    corners.push({ name: x.name.slice(0, 40), direction: x.direction, entry: x.entry, apex: x.apex, exit: x.exit });
  }
  return {
    version: 1,
    course: typeof r.course === 'string' ? r.course : '',
    corners,
    auto: r.auto !== false,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : ''
  };
}

export function serializeCornerFile(file: CornerFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

const at = (geo: LapGeometry, i: number): LatLon => {
  const p = geo.lap.points[i];
  return { lat: p.latitude, lon: p.longitude };
};

/** 見つけたコーナーから、C1… の名前で作る (今あるコースの自動作成) */
export function cornersFromDetection(geo: LapGeometry, found: Corner[]): NamedCorner[] {
  return found.map((c, k) => ({
    name: `C${k + 1}`,
    direction: c.direction,
    entry: at(geo, c.startIndex),
    apex: at(geo, c.apexIndex),
    exit: at(geo, c.endIndex)
  }));
}

export function newCornerFile(course: string, corners: NamedCorner[], auto: boolean): CornerFile {
  return { version: 1, course, corners, auto, updatedAt: new Date().toISOString() };
}

/** 周の点の中で、位置 p にいちばん近い点 (from 以降。上限より遠ければ -1) */
function nearestIndex(geo: LapGeometry, p: LatLon, from: number, to = geo.s.length - 1): number {
  const pts = geo.lap.points;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((p.lat * Math.PI) / 180);
  let best = -1;
  let bestD2 = PLACE_MAX_DISTANCE_M * PLACE_MAX_DISTANCE_M;
  for (let k = Math.max(0, from); k <= to; k++) {
    const dx = (pts[k].longitude - p.lon) * mPerDegLon;
    const dy = (pts[k].latitude - p.lat) * mPerDegLat;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = k; }
  }
  return best;
}

/** 名前付きのコーナーを周の上に置いたもの。置けなかったコーナーは null */
export interface PlacedCorner extends Corner {
  name: string;
}

/**
 * 名前付きのコーナーを、周 geo の上に置く。走る順に、前のコーナーの出口より後ろで探す
 * (コースが交差・並走していても、前後を取り違えないように)
 */
export function placeCorners(geo: LapGeometry, named: NamedCorner[]): Array<PlacedCorner | null> {
  const out: Array<PlacedCorner | null> = [];
  let from = 0;
  for (const [k, c] of named.entries()) {
    const start = nearestIndex(geo, c.entry, from);
    const apex = start < 0 ? -1 : nearestIndex(geo, c.apex, start);
    const end = apex < 0 ? -1 : nearestIndex(geo, c.exit, apex);
    if (start < 0 || apex < 0 || end <= start) {
      out.push(null);
      continue;
    }
    let heading = 0;
    let maxCurv = 0;
    for (let i = start; i <= end; i++) {
      if (i > start) heading += ((geo.curvature[i] + geo.curvature[i - 1]) / 2) * (geo.s[i] - geo.s[i - 1]);
      maxCurv = Math.max(maxCurv, Math.abs(geo.curvature[i]));
    }
    out.push({
      number: k + 1,
      name: c.name,
      direction: c.direction,
      startIndex: start,
      apexIndex: apex,
      endIndex: end,
      startDistanceM: geo.s[start],
      apexDistanceM: geo.s[apex],
      endDistanceM: geo.s[end],
      headingChangeDeg: (Math.abs(heading) * 180) / Math.PI,
      minRadiusM: maxCurv > 0 ? 1 / maxCurv : Infinity
    });
    from = end;
  }
  return out;
}

/** 並んだ 2 つ (k と k+1) を 1 つにする。頂点は、名前の付いた前のもの (公式の「1-2 コーナー」なら名前を付け直す) */
export function mergeCorners(list: NamedCorner[], k: number, name?: string): NamedCorner[] {
  if (k < 0 || k + 1 >= list.length) return list;
  const a = list[k], b = list[k + 1];
  const merged: NamedCorner = { name: name ?? `${a.name}-${b.name}`, direction: a.direction, entry: a.entry, apex: a.apex, exit: b.exit };
  return [...list.slice(0, k), merged, ...list.slice(k + 2)];
}

/**
 * 1 つを 2 つに分ける。周 geo の上で、そのコーナーの中の曲がりのいちばんゆるい所を境にする。
 * 分けられない (置けない・短すぎる) ときは元のまま
 */
export function splitCorner(list: NamedCorner[], k: number, geo: LapGeometry): NamedCorner[] {
  const placed = placeCorners(geo, list)[k];
  if (!placed || placed.endIndex - placed.startIndex < 4) return list;
  const { startIndex: s0, endIndex: s1 } = placed;
  let cut = -1;
  let least = Infinity;
  for (let i = s0 + 2; i <= s1 - 2; i++) {
    const c = Math.abs(geo.curvature[i]);
    if (c < least) { least = c; cut = i; }
  }
  if (cut < 0) return list;
  const apexOf = (a: number, b: number) => {
    let best = a;
    for (let i = a; i <= b; i++) if (Math.abs(geo.curvature[i]) > Math.abs(geo.curvature[best])) best = i;
    return best;
  };
  const c = list[k];
  // 向きは、それぞれの頂点の曲がりの向き (S 字を分けたとき、後ろが逆向きになる)。cornerAt と同じ決め方
  const dirAt = (i: number): 'L' | 'R' => (geo.curvature[i] >= 0 ? 'R' : 'L');
  const a1 = apexOf(s0, cut), a2 = apexOf(cut + 1, s1);
  const first: NamedCorner = { name: `${c.name}a`, direction: dirAt(a1), entry: c.entry, apex: at(geo, a1), exit: at(geo, cut) };
  const second: NamedCorner = { name: `${c.name}b`, direction: dirAt(a2), entry: at(geo, cut + 1), apex: at(geo, a2), exit: c.exit };
  return [...list.slice(0, k), first, second, ...list.slice(k + 1)];
}

/** 作り直したコーナーに、近い位置 (頂点が 30 m 以内) の前の名前を引き継ぐ */
export function carryNames(next: NamedCorner[], prev: NamedCorner[]): NamedCorner[] {
  const used = new Set<number>();
  return next.map(c => {
    let best = -1;
    let bestD = PLACE_MAX_DISTANCE_M;
    for (const [k, p] of prev.entries()) {
      if (used.has(k)) continue;
      const d = Math.hypot((c.apex.lat - p.apex.lat) * 111320, (c.apex.lon - p.apex.lon) * 111320 * Math.cos((c.apex.lat * Math.PI) / 180));
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) return c;
    used.add(best);
    return { ...c, name: prev[best].name };
  });
}

/**
 * 周 geo の点 index のあたりに、新しいコーナーを作る (見つからなかったゆるい曲がりを足す)。
 * 入口・出口は前後 spanM、向きはその点の曲がり具合から
 */
export function cornerAt(geo: LapGeometry, index: number, name: string, spanM = 40): NamedCorner {
  const n = geo.s.length;
  let a = index, b = index;
  while (a > 0 && geo.s[index] - geo.s[a] < spanM) a--;
  while (b < n - 1 && geo.s[b] - geo.s[index] < spanM) b++;
  return { name, direction: geo.curvature[index] >= 0 ? 'R' : 'L', entry: at(geo, a), apex: at(geo, index), exit: at(geo, b) };
}

/** コーナーを、走る順の位置に入れる (周 geo の上の頂点の位置で並べる) */
export function insertCorner(list: NamedCorner[], corner: NamedCorner, geo: LapGeometry): NamedCorner[] {
  const placed = placeCorners(geo, list);
  const own = placeCorners(geo, [corner])[0];
  if (!own) return [...list, corner];
  let k = list.length;
  for (const [i, p] of placed.entries()) {
    if (p && p.apexDistanceM > own.apexDistanceM) { k = i; break; }
  }
  return [...list.slice(0, k), corner, ...list.slice(k)];
}

/**
 * 周 geo の点 a〜b (地図でなぞった範囲) を 1 つのコーナーにする。頂点は範囲の中でいちばん曲がりのきつい所、
 * 向きは範囲全体の曲がりの向き。短すぎる (spanMinM より短い) ときは null
 */
export function cornerFromSpan(geo: LapGeometry, a: number, b: number, name: string, spanMinM = 10): NamedCorner | null {
  const n = geo.s.length;
  const i0 = Math.max(0, Math.min(a, b)), i1 = Math.min(n - 1, Math.max(a, b));
  const len = geo.s[i1] - geo.s[i0];
  // 周の半分より長い範囲は作らない (周の始めと終わりをまたいでなぞると、ほぼ 1 周が 1 つのコーナーになるため)
  if (i1 <= i0 || len < spanMinM || len > geo.s[n - 1] / 2) return null;
  let apex = i0, heading = 0;
  for (let i = i0; i <= i1; i++) {
    if (Math.abs(geo.curvature[i]) > Math.abs(geo.curvature[apex])) apex = i;
    if (i > i0) heading += ((geo.curvature[i] + geo.curvature[i - 1]) / 2) * (geo.s[i] - geo.s[i - 1]);
  }
  return { name, direction: heading >= 0 ? 'R' : 'L', entry: at(geo, i0), apex: at(geo, apex), exit: at(geo, i1) };
}

/**
 * 周 geo の点 index を押してコーナーを足すときの範囲。前後 spanM で、前後のコーナーの頂点にはかからない。
 * 押した所がもうコーナーの中なら null (そのコーナーを選ぶ)
 */
export function tapSpan(list: NamedCorner[], geo: LapGeometry, index: number, spanM = 40): { a: number; b: number } | null {
  const placed = placeCorners(geo, list).filter((p): p is PlacedCorner => !!p);
  if (placed.some(p => p.startIndex <= index && index <= p.endIndex)) return null;
  const n = geo.s.length;
  let a = index, b = index;
  while (a > 0 && geo.s[index] - geo.s[a - 1] <= spanM) a--;
  while (b < n - 1 && geo.s[b + 1] - geo.s[index] <= spanM) b++;
  for (const p of placed) {
    if (p.apexIndex < index) a = Math.max(a, p.apexIndex + 1);
    if (p.apexIndex > index) b = Math.min(b, p.apexIndex - 1);
  }
  return { a, b };
}

/**
 * なぞった範囲 a〜b を 1 つのコーナーにして、一覧に入れる。頂点がその範囲に入る前のコーナーは置き換える
 * (複合コーナーを 1 つにまとめる・まとめられたものを分けて作り直すため)。
 * 名前は、置き換えたのが 1 つならその名前、複数なら「最初-最後」、無ければ C<数>。作れなければ null
 */
export function applySpanCorner(list: NamedCorner[], geo: LapGeometry, a: number, b: number): { list: NamedCorner[]; index: number } | null {
  const i0 = Math.min(a, b), i1 = Math.max(a, b);
  const placed = placeCorners(geo, list);
  const inside = placed.map((p, k) => (p && p.apexIndex >= i0 && p.apexIndex <= i1 ? k : -1)).filter(k => k >= 0);
  const name = inside.length === 1 ? list[inside[0]].name
    : inside.length > 1 ? `${list[inside[0]].name}-${list[inside[inside.length - 1]].name}`
    : freeCornerName(list);
  const corner = cornerFromSpan(geo, i0, i1, name);
  if (!corner) return null;
  // 前後のコーナーが範囲にかかっていれば、範囲の外まで縮める (走る順に置くとき、前後が重ならないように)
  const n = geo.s.length;
  const rest = list.flatMap((c, k) => {
    if (inside.includes(k)) return [];
    const p = placed[k];
    if (!p) return [c];
    // 縮めると入口が頂点に届く (長さが無くなる) ものは外す (周の上に置けなくなるため)
    if (p.apexIndex > i1 && p.startIndex <= i1) return i1 + 1 >= p.apexIndex ? [] : [{ ...c, entry: at(geo, Math.min(n - 1, i1 + 1)) }];
    if (p.apexIndex < i0 && p.endIndex >= i0) return i0 - 1 <= p.apexIndex ? [] : [{ ...c, exit: at(geo, Math.max(0, i0 - 1)) }];
    return [c];
  });
  const next = insertCorner(rest, corner, geo);
  return { list: next, index: next.indexOf(corner) };
}

/** まだ使っていない、いちばん小さい C<数> の名前 (消した・まとめたあとに足しても、同じ名前にならないように) */
export function freeCornerName(list: NamedCorner[]): string {
  const used = new Set(list.map(c => c.name));
  let k = 1;
  while (used.has(`C${k}`)) k++;
  return `C${k}`;
}
