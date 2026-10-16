/**
 * ユーザーが設置した公式または独自コースデータ (.pth / .cln / .sci) の管理サービス
 *
 * - コース図 (.pth)・コントロールライン (.cln)・セクター (.sci) は、ファイル名ではなく場所で組み合わせる。
 *   公式データはファイル名の付け方が種類ごとに違う (Circuit/cd_<名前>_DS4.pth、ControlLine/cl_<名前>.cln、Sector/<名前>.sci。
 *   日光は cd_nikko_DS4 と cl_nikko2) ため、名前は場所の候補が複数あるときの決め手にだけ使う
 * - 保存先は IndexedDB (公式データ一式は localStorage の上限 約 5 MB に収まらない)。以前の localStorage の保存分は初回に移し替える
 */
import { ControlLine, Sector, TelemetryPoint } from '../types/telemetry';
import { parsePth, parseCln } from './pthParser';
import { countGateCrossings } from './lapCalculator';

export interface UserCircuitItem {
  id: string;            // 組み合わせの元になった .cln のパス (フォルダ込み) を小文字にしたもの
  name: string;          // 表示名 (内蔵のコースの近くならその名前、なければファイル名から接頭辞などを除いたもの)
  controlLine: ControlLine;
  sectors: Sector[];
  polylines?: Array<Array<[number, number]>>;
  sources: { cln: string; pth?: string; sci?: string };
}

// コントロールラインと組み合わせられなかったコース図。内蔵のコースのコース図として使う
interface LoosePolyline {
  path: string;
  polylines: Array<Array<[number, number]>>;
}

export interface CourseFile {
  path: string; // フォルダ込みのパス (webkitRelativePath)。なければファイル名
  text: string;
}

export interface ImportResult {
  circuits: number;            // 登録したコース (コントロールラインの数)
  withPolylines: number;       // うちコース図と組み合わせたもの
  withSectors: number;         // うちセクターと組み合わせたもの
  loosePolylines: number;      // コントロールラインと組み合わせられなかったコース図
  unusedSectors: string[];     // どのコースとも組み合わせられなかったセクター
  failed: Array<{ path: string; reason: string }>;
  saved: boolean;              // 保存できたか (できなければ再起動で消える)
  saveError?: string;
}

// 組み合わせる範囲: コース図・セクター線がコントロールラインからこの距離以内を通ること (m)
const PAIR_MAX_M = 300;
// セクター線の中点がコース図の上にあるとみなす距離 (m)。セクター線はコースを横切るので中点はほぼコース上にある。
// 広くすると、隣り合うコース (筑波 2000 と 1000 など) のセクターを取り違える
const SECTOR_ON_TRACK_M = 50;
// 内蔵のコース名を表示名に使う範囲 (コントロールラインの中点どうしの距離、m)
const PRESET_NAME_MAX_M = 3000;

const DB_NAME = 'ds_universal';
const DB_STORE = 'kv';
const DB_KEY = 'userCircuits_v3';
const LEGACY_LOCALSTORAGE_KEY = 'ds_user_circuits';

// ---------------------------------------------------------------------------
// 距離・名前の補助
// ---------------------------------------------------------------------------

const lineMid = (l: { latA: number; lonA: number; latB: number; lonB: number }) => ({
  lat: (l.latA + l.latB) / 2,
  lon: (l.lonA + l.lonB) / 2
});

function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lat1 - lat2) * 111320, (lon1 - lon2) * 111320 * cosLat);
}

/** 点からコース図 (折れ線の集まり、[経度, 緯度]) までの最短距離 (m) */
function distToPolylinesM(lat: number, lon: number, polylines: Array<Array<[number, number]>>): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const toXY = (plon: number, plat: number) => [(plon - lon) * 111320 * cosLat, (plat - lat) * 111320];
  let best = Infinity;
  for (const poly of polylines) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = toXY(poly[i][0], poly[i][1]);
      if (i + 1 >= poly.length) {
        best = Math.min(best, Math.hypot(ax, ay));
        continue;
      }
      const [bx, by] = toXY(poly[i + 1][0], poly[i + 1][1]);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
    }
  }
  return best;
}

/** ファイル名から比較用の名前を作る (cd_ / cl_ の接頭辞、_DS4 などの接尾辞、拡張子を除く) */
export function normalizeCourseName(path: string): string {
  const file = path.split(/[\\/]/).pop() || path;
  return file
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/^(cd|cl)_/, '')
    .replace(/_ds\d*$/, '');
}

/** .sci (1 行 1 本: 緯度A,経度A,緯度B,経度B,…) を読む */
export function parseSci(text: string, idPrefix: string): Sector[] {
  const sectors: Sector[] = [];
  for (const line of text.split(/\r?\n/)) {
    const v = line.split(',').map(x => parseFloat(x.trim()));
    if (v.length < 4 || !v.slice(0, 4).every(Number.isFinite)) continue;
    const [latA, lonA, latB, lonB] = v;
    if (Math.abs(latA) > 90 || Math.abs(latB) > 90 || Math.abs(lonA) > 180 || Math.abs(lonB) > 180) continue;
    sectors.push({ id: `${idPrefix}_s${sectors.length + 1}`, name: `S${sectors.length + 1}`, latA, lonA, latB, lonB });
  }
  if (sectors.length === 0) throw new Error('セクター線が見つかりません');
  return sectors;
}

// ---------------------------------------------------------------------------
// 組み合わせ (純粋な処理。Node でも試せるようにファイルの読み込み・保存とは分ける)
// ---------------------------------------------------------------------------

export function pairCourseFiles(
  files: CourseFile[],
  presets: Array<{ name: string; controlLine?: ControlLine; centerLat: number; centerLon: number }> = []
): { circuits: UserCircuitItem[]; loose: LoosePolyline[]; unusedSectors: string[]; failed: ImportResult['failed'] } {
  const failed: ImportResult['failed'] = [];
  const clns: Array<{ path: string; key: string; cl: ControlLine }> = [];
  const pths: Array<{ path: string; key: string; polylines: Array<Array<[number, number]>> }> = [];
  const scis: Array<{ path: string; key: string; gates: Sector[] }> = [];

  for (const f of files) {
    const ext = f.path.split('.').pop()?.toLowerCase();
    const key = normalizeCourseName(f.path);
    try {
      if (ext === 'cln') clns.push({ path: f.path, key, cl: parseCln(f.text, key) });
      else if (ext === 'pth') {
        const polylines = parsePth(f.text);
        if (polylines.length === 0) throw new Error('コース図の座標が見つかりません');
        pths.push({ path: f.path, key, polylines });
      } else if (ext === 'sci') scis.push({ path: f.path, key, gates: parseSci(f.text, key) });
    } catch (e) {
      failed.push({ path: f.path, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const usedPth = new Set<number>();
  const usedSci = new Set<number>();
  const circuits: UserCircuitItem[] = [];
  const candidates: Array<Array<{ idx: number; nameScore: number; d: number }>> = [];
  const presetDist: number[] = []; // 表示名に使った内蔵のコースまでの距離 (同じ名前が並んだときの区別に使う)

  for (const c of clns) {
    const mid = lineMid(c.cl);

    // コース図: コントロールラインの近くを通るもの。名前が同じものを優先し、その次は近いもの
    let pthIdx = -1;
    let pthScore = Infinity;
    pths.forEach((p, i) => {
      const d = distToPolylinesM(mid.lat, mid.lon, p.polylines);
      if (d > PAIR_MAX_M) return;
      const score = (p.key === c.key ? 0 : PAIR_MAX_M) + d;
      if (score < pthScore) {
        pthScore = score;
        pthIdx = i;
      }
    });
    const polylines = pthIdx >= 0 ? pths[pthIdx].polylines : undefined;
    if (pthIdx >= 0) usedPth.add(pthIdx);

    // セクターの候補: すべてのセクター線の中点がコース図の上 (コース図がなければコントロールラインの 3 km 以内) にあるもの。
    // 実際の組み合わせは、すべてのコースの候補がそろってから決める (下)
    const sciCands: Array<{ idx: number; nameScore: number; d: number }> = [];
    scis.forEach((sc, i) => {
      const ok = sc.gates.every(g => {
        const m = lineMid(g);
        return polylines ? distToPolylinesM(m.lat, m.lon, polylines) <= SECTOR_ON_TRACK_M : distM(m.lat, m.lon, mid.lat, mid.lon) <= 3000;
      });
      if (!ok) return;
      const nameScore = sc.key === c.key ? 0 : c.key.startsWith(sc.key) || sc.key.startsWith(c.key) ? 1 : 2;
      const d = Math.min(...sc.gates.map(g => { const m = lineMid(g); return distM(m.lat, m.lon, mid.lat, mid.lon); }));
      sciCands.push({ idx: i, nameScore, d });
    });
    candidates.push(sciCands);

    // 表示名: 内蔵のコースの近くならその名前
    let name = c.key;
    let nearest = PRESET_NAME_MAX_M;
    for (const p of presets) {
      const pm = p.controlLine ? lineMid(p.controlLine) : { lat: p.centerLat, lon: p.centerLon };
      const d = distM(pm.lat, pm.lon, mid.lat, mid.lon);
      if (d < nearest) {
        nearest = d;
        name = p.name;
      }
    }

    presetDist.push(name === c.key ? Infinity : nearest);
    circuits.push({
      id: c.path.toLowerCase(),
      name,
      controlLine: { ...c.cl, name },
      sectors: [],
      ...(polylines ? { polylines } : {}),
      sources: { cln: c.path, ...(pthIdx >= 0 ? { pth: pths[pthIdx].path } : {}) }
    });
  }

  // セクターの組み合わせ。同じ場所に複数のコースがある (鈴鹿と西コース、もてぎと東コースなど) と、全体のコースのセクター線は
  // 部分コースのコース図の上にも乗る。セクター 1 つにつきコースを 1 つだけ選び、名前が同じもの → 前方一致するもの →
  // 場所が合うもののうち近いもの、の順に優先する。1 つのコースに組み合わせるセクターも 1 つまで
  const sciOf = new Map<number, number>(); // circuit index -> sci index
  const pairs = scis.flatMap((_, si) => circuits.flatMap((__, ci) => {
    const cand = candidates[ci].find(x => x.idx === si);
    return cand ? [{ si, ci, nameScore: cand.nameScore, d: cand.d }] : [];
  })).sort((a, b) => a.nameScore - b.nameScore || a.d - b.d);
  for (const p of pairs) {
    if (usedSci.has(p.si) || sciOf.has(p.ci)) continue;
    sciOf.set(p.ci, p.si);
    usedSci.add(p.si);
  }
  // 同じ施設の別コース (富士の本コース・カート・ショートなど) が同じ内蔵のコース名になったときは、
  // 内蔵のコースの計測線に一番近いもの以外に、ファイル名から作った名前を添えて区別する
  const byName = new Map<string, number[]>();
  circuits.forEach((c, i) => byName.set(c.name, [...(byName.get(c.name) ?? []), i]));
  for (const idxs of byName.values()) {
    if (idxs.length < 2) continue;
    const keep = idxs.reduce((a, b) => (presetDist[b] < presetDist[a] ? b : a));
    for (const i of idxs) {
      if (i === keep) continue;
      const c = circuits[i];
      c.name = `${c.name} / ${normalizeCourseName(c.sources.cln)}`;
      c.controlLine = { ...c.controlLine, name: c.name };
    }
  }

  for (const [ci, si] of sciOf) {
    const c = circuits[ci];
    const cl = c.controlLine;
    // 公式の .sci はフィニッシュ (コントロールライン) を含まないので、最後の区間として足す
    c.sectors = [
      ...scis[si].gates,
      { latA: cl.latA, lonA: cl.lonA, latB: cl.latB, lonB: cl.lonB, id: `${scis[si].key}_finish`, name: `S${scis[si].gates.length + 1}` }
    ];
    c.sources.sci = scis[si].path;
  }

  return {
    circuits,
    loose: pths.filter((_, i) => !usedPth.has(i)).map(p => ({ path: p.path, polylines: p.polylines })),
    unusedSectors: scis.filter((_, i) => !usedSci.has(i)).map(s => s.path),
    failed
  };
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB が使えません'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 接続は操作ごとに開いて閉じる (開いたままにすると、データベースの削除・作り直しを妨げる)
async function dbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function dbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

interface StoredData {
  // 読み込んだ元のファイル。読み込むたびに、それまでの分と合わせて組み合わせ直す
  // (フォルダを分けて読み込んでも、前に読み込んだコース図・セクターと組み合わさるように)
  files: CourseFile[];
  // 組み合わせた結果 (起動のたびに組み合わせ直さないよう、一緒に保存する)
  circuits: UserCircuitItem[];
  loose: LoosePolyline[];
}

// ---------------------------------------------------------------------------
// 管理クラス
// ---------------------------------------------------------------------------

class UserCircuitStorage {
  private files: CourseFile[] = [];
  private circuits: UserCircuitItem[] = [];
  private loose: LoosePolyline[] = [];
  /** 保存済みのデータの読み込みが終わると解決する。コースの判定の前に待つ */
  public readonly ready: Promise<void>;

  constructor() {
    this.ready = this.load().catch(e => console.warn('[UserCircuit] 復元エラー:', e));
  }

  private async load(): Promise<void> {
    let data: StoredData | undefined;
    try {
      data = await dbGet<StoredData>(DB_KEY);
    } catch (e) {
      console.warn('[UserCircuit] IndexedDB を開けません:', e);
    }
    if (data) {
      this.files = data.files || [];
      this.circuits = data.circuits || [];
      this.loose = data.loose || [];
    }
    // 以前 (localStorage) の保存分を移し替える。元の .pth / .cln / .sci の文字列を持っているので、組み合わせ直す
    try {
      const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem(LEGACY_LOCALSTORAGE_KEY) : null;
      if (legacy) {
        const list: Array<[string, { pthText?: string; clnText?: string; sciText?: string }]> = JSON.parse(legacy);
        const files: CourseFile[] = [];
        for (const [id, item] of list) {
          if (item.clnText) files.push({ path: `${id}.cln`, text: item.clnText });
          if (item.pthText) files.push({ path: `${id}.pth`, text: item.pthText });
          if (item.sciText) files.push({ path: `${id}.sci`, text: item.sciText });
        }
        // ready (この読み込み自身) を待つ importCourseFiles ではなく、内部の処理を直接呼ぶ (自分自身を待って止まらないように)
        const r = files.length > 0 ? await this.addCourseFiles(files) : undefined;
        // 新しい保存先に保存できたときだけ、以前の保存分を消す (保存できなければ次回もう一度移し替える)
        if (!r || r.saved) localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
      }
    } catch (e) {
      console.warn('[UserCircuit] 以前の保存データの移し替えに失敗:', e);
    }
    if (this.circuits.length > 0) console.log(`[UserCircuit] 保存済みのユーザーコース ${this.circuits.length} 件を復元`);
  }

  /** ユーザーが選択したファイル群 (フォルダ丸ごとのインポート) を読み込む */
  public async importFiles(files: FileList | File[]): Promise<ImportResult> {
    const list: CourseFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!/\.(pth|cln|sci)$/i.test(f.name)) continue;
      // フォルダ込みのパスで区別する (別のフォルダの同じ名前のファイルを混ぜない)
      const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      list.push({ path, text: await f.text() });
    }
    return this.importCourseFiles(list);
  }

  public async importCourseFiles(files: CourseFile[]): Promise<ImportResult> {
    // 保存済みのデータの読み込みが終わってから追加する (後から読み込みが終わって、追加分を上書きしないように)
    await this.ready.catch(() => undefined);
    return this.addCourseFiles(files);
  }

  private async addCourseFiles(files: CourseFile[]): Promise<ImportResult> {
    // 内蔵のコース名を表示名に使う (循環参照を避けて、ここで読み込む)
    const { CIRCUIT_PRESETS } = await import('./circuitDatabase');
    // それまでに読み込んだファイルと合わせて組み合わせ直す。同じパスのファイルは新しいもので置き換える
    // 選んだフォルダによってパスの先頭が変わる (digspice/ControlLine/… と ControlLine/…) ので、ファイル名と中身が同じものも同じファイルとみなす
    const newPaths = new Set(files.map(f => f.path));
    const sameFile = (a: CourseFile, b: CourseFile) => (a.path.split(/[\\/]/).pop() || '').toLowerCase() === (b.path.split(/[\\/]/).pop() || '').toLowerCase() && a.text === b.text;
    const all = [...this.files.filter(f => !newPaths.has(f.path) && !files.some(n => sameFile(f, n))), ...files];
    const r = pairCourseFiles(all, CIRCUIT_PRESETS);
    // 読み込めなかったファイルは残さない (次の読み込みのたびに失敗として出さないように)
    const failedPaths = new Set(r.failed.map(f => f.path));
    this.files = all.filter(f => !failedPaths.has(f.path));
    this.circuits = r.circuits;
    this.loose = r.loose;

    let saved = true;
    let saveError: string | undefined;
    try {
      await dbPut(DB_KEY, { files: this.files, circuits: this.circuits, loose: this.loose } satisfies StoredData);
    } catch (e) {
      saved = false;
      saveError = e instanceof Error ? e.message : String(e);
      console.warn('[UserCircuit] 保存に失敗:', e);
    }

    // 件数は登録済みのもの全体 (今回の分と、それまでの分を合わせて組み合わせた結果)。読み込めなかったファイルは今回の分だけ
    return {
      circuits: r.circuits.length,
      withPolylines: r.circuits.filter(c => c.polylines).length,
      withSectors: r.circuits.filter(c => c.sectors.length > 0).length,
      loosePolylines: r.loose.length,
      unusedSectors: r.unusedSectors,
      failed: r.failed.filter(f => newPaths.has(f.path)),
      saved,
      saveError
    };
  }

  /**
   * ログの近く (先頭位置から maxDistMeters 以内) のユーザーコース。
   * 候補が複数あるとき (筑波 2000 / 1000 など) は、走行データで計測線を通過して最も多く周回を区切れるものを選び、
   * 同数なら先頭位置に近いものを選ぶ
   */
  public findNearCircuit(lat: number, lon: number, maxDistMeters = 15000, points?: TelemetryPoint[]): UserCircuitItem | null {
    const near = this.circuits
      .map(c => ({ c, d: distM(lat, lon, lineMid(c.controlLine).lat, lineMid(c.controlLine).lon) }))
      .filter(x => x.d < maxDistMeters)
      .sort((a, b) => a.d - b.d);
    if (near.length === 0) return null;
    if (!points || near.length === 1) return near[0].c;
    // 周回の数ではなく計測線を通過した回数で比べる (通過が 1 回で、通過より前の方が長いログは周回が「ログ全体」になり、0 周と区別できないため)
    let best = near[0].c;
    let bestCount = 0;
    for (const { c } of near) {
      const count = countGateCrossings(points, c.controlLine);
      if (count > bestCount) {
        bestCount = count;
        best = c;
      }
    }
    return best;
  }

  /** ユーザーコースの id からコース図 */
  public getCircuitPolylines(id: string): Array<Array<[number, number]>> | undefined {
    return this.circuits.find(c => c.id === id)?.polylines;
  }

  /** 内蔵のコースに使うコース図: コントロールライン (なければ中心) の近くを通る、読み込み済みのコース図 */
  public findPolylinesNear(lat: number, lon: number, maxMeters = PAIR_MAX_M): Array<Array<[number, number]>> | undefined {
    let best: Array<Array<[number, number]>> | undefined;
    let bestD = maxMeters;
    for (const p of [...this.circuits.filter(c => c.polylines).map(c => c.polylines!), ...this.loose.map(l => l.polylines)]) {
      const d = distToPolylinesM(lat, lon, p);
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  public getCircuitCount(): number {
    return this.circuits.length;
  }

  public async clear(): Promise<void> {
    this.files = [];
    this.circuits = [];
    this.loose = [];
    try {
      await dbPut(DB_KEY, { files: [], circuits: [], loose: [] } satisfies StoredData);
    } catch (e) {
      console.warn('[UserCircuit] 削除に失敗:', e);
    }
  }
}

export const userCircuitStorage = new UserCircuitStorage();
