/**
 * ユーザーが設置した公式または独自コースデータ (.pth / .cln / .sci) の管理サービス
 *
 * - コース図 (.pth)・コントロールライン (.cln)・セクター (.sci) は、ファイル名ではなく場所で組み合わせる。
 *   公式データはファイル名の付け方が種類ごとに違う (Circuit/cd_<名前>_DS4.pth、ControlLine/cl_<名前>.cln、Sector/<名前>.sci。
 *   日光は cd_nikko_DS4 と cl_nikko2) ため、名前は場所の候補が複数あるときの決め手にだけ使う
 * - 保存先は IndexedDB (公式データ一式は localStorage の上限 約 5 MB に収まらない)。以前の localStorage の保存分は初回に移し替える
 */
import { ControlLine, Sector, TelemetryPoint } from '../types/telemetry';
import { parsePth, parseCln, parseSci } from './pthParser';
export { parseSci };
import { countGateCrossings } from './lapCalculator';
import { tr } from '../utils/i18n';

export interface UserCircuitItem {
  id: string;            // 組み合わせの元になった .cln のパス (フォルダ込み) を小文字にしたもの。コース編集で保存したものは `edited:<コース名>`
  name: string;          // 表示名 (内蔵のコースの近くならその名前、なければファイル名から接頭辞などを除いたもの)
  controlLine: ControlLine;
  sectors: Sector[];
  polylines?: Array<Array<[number, number]>>;
  sources: { cln: string; pth?: string; sci?: string };
  /** 英語名と、ラップタイマーの記録を入れるフォルダの名前 (コース編集で付けたもの。2026-10-20) */
  nameEn?: string;
  folder?: string;
  /** ゴールの線 (スタートとゴールが別のコース。コース編集で付けたもの) */
  finishLine?: ControlLine;
  /** コース編集で保存した時刻 (端末の間で合わせるとき、新しいほうを使う。2026-10-24 から) */
  updatedAt?: string;
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

/**
 * ログのほとんど (95%) が、コース図から 50 m 以内を走っているか (間引いて調べる)。
 * ピット・パドックで止まっている間やピットロードは外れるので、40 km/h 以上で走っている点だけで調べる
 */
export function runsOnPolylines(points: TelemetryPoint[], polylines: Array<Array<[number, number]>>): boolean {
  if (polylines.length === 0) return false;
  const moving = points.filter(p => p.speed >= 40);
  if (moving.length === 0) return true;
  const step = Math.max(1, Math.floor(moving.length / 200));
  let total = 0;
  let near = 0;
  for (let i = 0; i < moving.length; i += step) {
    total++;
    if (distToPolylinesM(moving[i].latitude, moving[i].longitude, polylines) <= 50) near++;
  }
  return near / total >= 0.95;
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

/**
 * セクターを .sci (公式と同じ形: 1 行 1 本「緯度A,経度A,緯度B,経度B,1」、小数 6 桁、改行は CRLF) にする。
 * 公式の .sci はフィニッシュ (計測線) を含まないので、計測線と同じ線は書かない
 */
export function exportSci(sectors: Sector[], controlLine?: ControlLine): string {
  const same = (s: Sector) => !!controlLine &&
    Math.abs(s.latA - controlLine.latA) < 1e-7 && Math.abs(s.lonA - controlLine.lonA) < 1e-7 &&
    Math.abs(s.latB - controlLine.latB) < 1e-7 && Math.abs(s.lonB - controlLine.lonB) < 1e-7;
  return sectors
    .filter(s => !same(s))
    .map(s => [s.latA, s.lonA, s.latB, s.lonB].map(v => v.toFixed(6)).join(',') + ',1\r\n')
    .join('');
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
        if (polylines.length === 0) throw new Error(tr('コース図の座標が見つかりません', 'No track map coordinates were found'));
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
  const presetHasLine: boolean[] = []; // 表示名に使った内蔵のコースが計測線を持つか (名阪のように持たないと、施設の中心しか分からない)

  // コース図の組み合わせ: コントロールラインの近く (300 m 以内) を通るもの。コース図 1 つにつきコースを 1 つとし、
  // 名前が同じもの → 前方一致するもの → 近いもの、の順に優先する (近くの別のコースのコース図を先に取らないように)
  const nameScoreOf = (a: string, b: string) => (a === b ? 0 : a.startsWith(b) || b.startsWith(a) ? 1 : 2);
  const pthPairs = clns.flatMap((c, ci) => {
    const mid = lineMid(c.cl);
    return pths.flatMap((p, pi) => {
      const d = distToPolylinesM(mid.lat, mid.lon, p.polylines);
      return d <= PAIR_MAX_M ? [{ ci, pi, nameScore: nameScoreOf(p.key, c.key), d }] : [];
    });
  }).sort((a, b) => a.nameScore - b.nameScore || a.d - b.d);
  const pthOf = new Map<number, number>();
  for (const pr of pthPairs) {
    if (usedPth.has(pr.pi) || pthOf.has(pr.ci)) continue;
    pthOf.set(pr.ci, pr.pi);
    usedPth.add(pr.pi);
  }
  // 自分のコース図がないコース (鈴鹿の西コースなど) は、近くのコースのコース図を表示用に借りる。
  // 借りたコース図は他のコースの形なので、セクターの組み合わせの判定には使わない
  const sharedPthOf = new Map<number, number>();
  clns.forEach((_, ci) => {
    if (pthOf.has(ci)) return;
    const pr = pthPairs.find(x => x.ci === ci);
    if (pr) sharedPthOf.set(ci, pr.pi);
  });

  let ci = -1;
  for (const c of clns) {
    ci++;
    const mid = lineMid(c.cl);
    const ownPthIdx = pthOf.get(ci) ?? -1;
    const pthIdx = ownPthIdx >= 0 ? ownPthIdx : sharedPthOf.get(ci) ?? -1;
    const polylines = pthIdx >= 0 ? pths[pthIdx].polylines : undefined;
    // セクターの判定に使うコース図 (自分のもの)
    const ownPolylines = ownPthIdx >= 0 ? pths[ownPthIdx].polylines : undefined;

    // セクターの候補: すべてのセクター線の中点がコース図の上 (コース図がなければコントロールラインの 3 km 以内) にあるもの。
    // 実際の組み合わせは、すべてのコースの候補がそろってから決める (下)
    const sciCands: Array<{ idx: number; nameScore: number; d: number }> = [];
    scis.forEach((sc, i) => {
      const ok = sc.gates.every(g => {
        const m = lineMid(g);
        return ownPolylines ? distToPolylinesM(m.lat, m.lon, ownPolylines) <= SECTOR_ON_TRACK_M : distM(m.lat, m.lon, mid.lat, mid.lon) <= 3000;
      });
      if (!ok) return;
      const nameScore = nameScoreOf(sc.key, c.key);
      const d = Math.min(...sc.gates.map(g => { const m = lineMid(g); return distM(m.lat, m.lon, mid.lat, mid.lon); }));
      sciCands.push({ idx: i, nameScore, d });
    });
    candidates.push(sciCands);

    // 表示名: 内蔵のコースの近くならその名前
    let name = c.key;
    let nearest = PRESET_NAME_MAX_M;
    let hasLine = true;
    for (const p of presets) {
      const pm = p.controlLine ? lineMid(p.controlLine) : { lat: p.centerLat, lon: p.centerLon };
      const d = distM(pm.lat, pm.lon, mid.lat, mid.lon);
      if (d < nearest) {
        nearest = d;
        name = p.name;
        hasLine = !!p.controlLine;
      }
    }

    presetDist.push(name === c.key ? Infinity : nearest);
    presetHasLine.push(name === c.key || hasLine);
    circuits.push({
      id: c.path.toLowerCase(),
      name,
      controlLine: { ...c.cl, name },
      sectors: [],
      ...(polylines ? { polylines } : {}),
      sources: { cln: c.path, ...(ownPthIdx >= 0 ? { pth: pths[ownPthIdx].path } : {}) }
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
    // 内蔵のコースが計測線を持つなら、その計測線に一番近いものはそのまま。名阪のように中心しか分からないときは、どれにも名前を添える
    const keep = presetHasLine[idxs[0]] ? idxs.reduce((a, b) => (presetDist[b] < presetDist[a] ? b : a)) : -1;
    for (const i of idxs) {
      if (i === keep) continue;
      const c = circuits[i];
      // 添える名前はファイル名から作る。同じになる (別のフォルダの同じ名前のファイル) ときはフォルダ名を添える
      const key = normalizeCourseName(c.sources.cln);
      const parts = c.sources.cln.split(/[\\/]/);
      const suffix = key !== c.name ? key : parts.length > 1 ? parts[parts.length - 2] : key;
      c.name = `${c.name} / ${suffix}`;
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
  // コース編集で保存したコース (ファイルからではないので、組み合わせ直さない)
  edited?: UserCircuitItem[];
}

// ---------------------------------------------------------------------------
// 管理クラス
// ---------------------------------------------------------------------------

class UserCircuitStorage {
  private files: CourseFile[] = [];
  /** 保管場所の digspice/ にあるコースデータ (開くたびに読む。保存しない)。storageCourses.ts */
  private storageFiles: CourseFile[] = [];
  private circuits: UserCircuitItem[] = [];
  private loose: LoosePolyline[] = [];
  private edited: UserCircuitItem[] = [];
  // 保存済みのデータを読めなかったか。読めなかったときは、保存済みのデータを空で上書きしないよう保存しない
  private loadFailed = false;
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
      this.loadFailed = true;
    }
    if (data) {
      this.files = data.files || [];
      this.circuits = data.circuits || [];
      this.loose = data.loose || [];
      this.edited = data.edited || [];
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
    // 同じファイルの判定: パスが同じ (大文字小文字は問わない)、一方のパスがもう一方のパスの末尾と一致する
    // (digspice/ControlLine/cl_x.cln と ControlLine/cl_x.cln)、またはファイル名と中身が同じ。同じなら新しい方で置き換える
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const sameFile = (a: CourseFile, b: CourseFile) => {
      const pa = norm(a.path);
      const pb = norm(b.path);
      if (pa === pb || pa.endsWith('/' + pb) || pb.endsWith('/' + pa)) return true;
      return pa.split('/').pop() === pb.split('/').pop() && a.text === b.text;
    };
    const newPaths = new Set(files.map(f => norm(f.path)));
    const all = [...this.files.filter(f => !files.some(n => sameFile(f, n))), ...files];
    // 組み合わせには、保管場所の digspice/ のコースデータも入れる (同じファイルは読み込んだほうを使う)
    const r = pairCourseFiles([...all, ...this.storageFiles.filter(f => !all.some(n => sameFile(f, n)))], CIRCUIT_PRESETS);
    // 読み込めなかったファイルは残さない (次の読み込みのたびに失敗として出さないように)
    const failedPaths = new Set(r.failed.map(f => f.path));
    this.files = all.filter(f => !failedPaths.has(f.path));
    this.circuits = r.circuits;
    this.loose = r.loose;

    const { saved, saveError } = await this.persist();

    // 件数は登録済みのもの全体 (今回の分と、それまでの分を合わせて組み合わせた結果)。読み込めなかったファイルは今回の分だけ
    return {
      circuits: r.circuits.length,
      withPolylines: r.circuits.filter(c => c.polylines).length,
      withSectors: r.circuits.filter(c => c.sectors.length > 0).length,
      loosePolylines: r.loose.length,
      unusedSectors: r.unusedSectors,
      failed: r.failed.filter(f => newPaths.has(norm(f.path))),
      saved,
      saveError
    };
  }

  /**
   * 保管場所の digspice/ にあるコースデータ (デジスパイスと同じ形のフォルダ) を使う。保存はしない (開くたびに読む)。
   * 内蔵のコースと同じコースのものは、コース図だけが使われる (circuitDatabase.ts の isShadowedByPreset)
   */
  public async setStorageCourseFiles(files: CourseFile[]): Promise<void> {
    await this.ready.catch(() => undefined);
    const { CIRCUIT_PRESETS } = await import('./circuitDatabase');
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const sameFile = (a: CourseFile, b: CourseFile) => {
      const pa = norm(a.path);
      const pb = norm(b.path);
      if (pa === pb || pa.endsWith('/' + pb) || pb.endsWith('/' + pa)) return true;
      return pa.split('/').pop() === pb.split('/').pop() && a.text === b.text;
    };
    this.storageFiles = files;
    const r = pairCourseFiles([...this.files, ...files.filter(f => !this.files.some(n => sameFile(f, n)))], CIRCUIT_PRESETS);
    this.circuits = r.circuits;
    this.loose = r.loose;
  }

  /** 今の内容を保存する */
  private async persist(): Promise<{ saved: boolean; saveError?: string }> {
    if (this.loadFailed) {
      return { saved: false, saveError: '保存済みのコースを読み込めなかったため、消さないよう保存していません (アプリを開き直してください)' };
    }
    try {
      await dbPut(DB_KEY, { files: this.files, circuits: this.circuits, loose: this.loose, edited: this.edited } satisfies StoredData);
      return { saved: true };
    } catch (e) {
      console.warn('[UserCircuit] 保存に失敗:', e);
      return { saved: false, saveError: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * コース編集で直した計測線・セクターを保存する (同じ名前のものは置き換える)。
   * 次から、この計測線を通るログには、読み込んだコースデータや内蔵のコースより優先して使う
   */
  public async saveEditedCircuit(
    name: string,
    controlLine: ControlLine,
    sectors: Sector[],
    polylines?: Array<Array<[number, number]>>,
    extra: { nameEn?: string; folder?: string; finishLine?: ControlLine } = {}
  ): Promise<{ saved: boolean; saveError?: string }> {
    await this.ready.catch(() => undefined);
    // コース図が今はないとき (取得中など) は、同じ名前で前に保存したコース図を (同じ場所なら) 引き継ぐ
    const prev = this.edited.find(c => c.name === name);
    const prevPolylines = prev?.polylines && distM(lineMid(prev.controlLine).lat, lineMid(prev.controlLine).lon, lineMid(controlLine).lat, lineMid(controlLine).lon) < 1000
      ? prev.polylines
      : undefined;
    const keptPolylines = polylines ?? prevPolylines;
    const item: UserCircuitItem = {
      id: `edited:${name}`,
      name,
      controlLine: { ...controlLine, name },
      sectors,
      ...(keptPolylines ? { polylines: keptPolylines } : {}),
      sources: { cln: 'edited' },
      // 英語名・フォルダ名は、渡されなければ前に保存したものを引き継ぐ
      ...(extra.nameEn && extra.folder ? { nameEn: extra.nameEn, folder: extra.folder } : prev?.nameEn && prev.folder ? { nameEn: prev.nameEn, folder: prev.folder } : {}),
      ...(extra.finishLine ? { finishLine: { ...extra.finishLine, name: 'Finish Line' } } : {}),
      updatedAt: new Date().toISOString()
    };
    // 新しく保存したものを最後に置く (同じ場所に複数あるときは、後に保存したものを使う)
    this.edited = [...this.edited.filter(c => c.name !== name), item];
    const r = await this.persist();
    // 保管場所の course/ にも書く (ほかの端末でも使えるように。courseFolderSync.ts)
    this.onEditedChanged?.({ saved: item });
    return r;
  }

  /** コース編集で保存・削除したとき (保管場所の course/ に書く。storageCourses.ts が入れる) */
  public onEditedChanged?: (e: { saved?: UserCircuitItem; deletedName?: string }) => void;

  /** 保管場所の course/ と合わせた、コース編集で保存したコースを使う */
  public async setSyncedEdited(edited: UserCircuitItem[]): Promise<void> {
    await this.ready.catch(() => undefined);
    this.edited = edited;
    await this.persist();
  }

  /** コース編集で保存したコース */
  public getEditedCircuits(): UserCircuitItem[] {
    return this.edited;
  }

  /** 自分のコース全部 (コース編集で保存したもの → 読み込んだコースデータの順) */
  public getAllCircuits(): UserCircuitItem[] {
    return [...this.edited, ...this.circuits];
  }

  /** 同じ名前で保存したコースが、別の場所 (計測線が 1 km 以上離れている) にあるか */
  public isEditedNameUsedElsewhere(name: string, controlLine: ControlLine): boolean {
    const prev = this.edited.find(c => c.name === name);
    if (!prev) return false;
    const a = lineMid(prev.controlLine);
    const b = lineMid(controlLine);
    return distM(a.lat, a.lon, b.lat, b.lon) >= 1000;
  }

  /** コース編集で保存したコースを消す */
  public async deleteEditedCircuit(name: string): Promise<{ saved: boolean; saveError?: string }> {
    await this.ready.catch(() => undefined);
    this.edited = this.edited.filter(c => c.name !== name);
    const r = await this.persist();
    this.onEditedChanged?.({ deletedName: name });
    return r;
  }

  /**
   * ログの近く (先頭位置から maxDistMeters 以内) のユーザーコース。
   * 候補が複数あるとき (筑波 2000 / 1000 など) は、走行データで計測線を通過して最も多く周回を区切れるものを選び、
   * 同数なら先頭位置に近いものを選ぶ
   */
  public findNearCircuit(
    lat: number,
    lon: number,
    maxDistMeters = 15000,
    points?: TelemetryPoint[],
    /** 候補から外すコース (内蔵のコースと同じコースの、読み込んだコースデータなど) */
    exclude?: (c: UserCircuitItem) => boolean
  ): { circuit: UserCircuitItem; crossings: number } | null {
    const near = [...this.edited, ...this.circuits]
      .filter(c => !exclude?.(c))
      .map(c => ({ c, d: distM(lat, lon, lineMid(c.controlLine).lat, lineMid(c.controlLine).lon) }))
      .filter(x => x.d < maxDistMeters)
      .sort((a, b) => a.d - b.d);
    const isEdited = (c: UserCircuitItem) => c.id.startsWith('edited:');
    if (near.length === 0) return null;
    // 走行データがなければ、通過したかは分からないので近いものを返す (crossings は -1)
    if (!points) return { circuit: near[0].c, crossings: -1 };
    // 周回の数ではなく計測線を通過した回数で比べる (通過が 1 回で、通過より前の方が長いログは周回が「ログ全体」になり、0 周と区別できないため)
    const counted = near.map(({ c }) => ({ c, count: countGateCrossings(points, c.controlLine) }));
    // コース編集で保存したコースの計測線を通過していれば、読み込んだコースデータより優先する (利用者が直した設定のため。
    // 計測線を動かすと通過の回数が変わるので、回数では比べない)。保存したコースどうしは回数で比べ、同じなら後に保存したものを使う
    const editedOrder = (c: UserCircuitItem) => this.edited.indexOf(c);
    // 保存したコースにコース図があれば、ログがその上を走っていることも確かめる
    // (鈴鹿のフルコースと東コースのように、計測線とストレートを共有する別のコースを取り違えないように)
    const offTrack = new Set(counted.filter(x => isEdited(x.c) && x.count > 0 && x.c.polylines && !runsOnPolylines(points, x.c.polylines!)).map(x => x.c));
    const crossedEdited = counted
      .filter(x => isEdited(x.c) && x.count > 0 && !offTrack.has(x.c))
      .sort((a, b) => b.count - a.count || editedOrder(b.c) - editedOrder(a.c));
    if (crossedEdited.length > 0) return { circuit: crossedEdited[0].c, crossings: crossedEdited[0].count };
    const candidates = near.filter(x => !offTrack.has(x.c));
    if (candidates.length === 0) return null;
    let best = candidates[0].c;
    let bestCount = 0;
    for (const { c, count } of counted) {
      // コース図から外れた保存したコースは使わない (別のコース)
      if (offTrack.has(c)) continue;
      if (count > bestCount) {
        bestCount = count;
        best = c;
      }
    }
    return { circuit: best, crossings: bestCount };
  }

  /** ユーザーコースの id からコース図 */
  public getCircuitPolylines(id: string): Array<Array<[number, number]>> | undefined {
    return [...this.edited, ...this.circuits].find(c => c.id === id)?.polylines;
  }

  /** 内蔵のコースに使うコース図: コントロールライン (なければ中心) の近くを通る、読み込み済みのコース図 */
  public findPolylinesNear(lat: number, lon: number, maxMeters = PAIR_MAX_M, preferName?: string): Array<Array<[number, number]>> | undefined {
    // 同じ内蔵のコース名を付けたユーザーコース (施設の主なコース) のコース図があれば、それを使う。
    // 近さだけで選ぶと、メインストレートを共有する部分コース (鈴鹿の東コースなど) のコース図を選ぶことがある
    if (preferName) {
      const own = [...this.edited, ...this.circuits].find(c => c.name === preferName && c.polylines && distToPolylinesM(lat, lon, c.polylines) <= maxMeters);
      if (own) return own.polylines;
    }
    let best: Array<Array<[number, number]>> | undefined;
    let bestD = maxMeters;
    for (const p of [...this.edited, ...this.circuits].filter(c => c.polylines).map(c => c.polylines!).concat(this.loose.map(l => l.polylines))) {
      const d = distToPolylinesM(lat, lon, p);
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  public getCircuitCount(): number {
    return this.circuits.length + this.edited.length;
  }

  /** コースフォルダー一括設置で読み込んだコースデータのファイルの数 (.cln・.pth・.sci) */
  public getImportedFileCount(): number {
    return this.files.length;
  }

  /** コースフォルダー一括設置で読み込んだコースの数 (保管場所の digspice/・course/ のもの、コース編集で保存したものは数えない) */
  public getImportedCourseCount(): number {
    const imported = new Set(this.files.filter(f => /\.cln$/i.test(f.path)).map(f => f.path.toLowerCase()));
    return this.circuits.filter(c => imported.has(c.sources.cln.toLowerCase())).length;
  }

  /**
   * コースフォルダー一括設置で読み込んだコースデータを外す (内蔵のコースに戻す)。
   * コース編集で保存したコースは残す。保管場所の digspice/ のコースデータは、そのまま使う
   */
  public async clearImported(): Promise<{ saved: boolean; saveError?: string }> {
    await this.ready.catch(() => undefined);
    const { CIRCUIT_PRESETS } = await import('./circuitDatabase');
    this.files = [];
    const r = pairCourseFiles(this.storageFiles, CIRCUIT_PRESETS);
    this.circuits = r.circuits;
    this.loose = r.loose;
    return this.persist();
  }

  public async clear(): Promise<void> {
    this.files = [];
    this.circuits = [];
    this.loose = [];
    this.edited = [];
    await this.persist();
  }
}

export const userCircuitStorage = new UserCircuitStorage();
