/**
 * ラップタイムの一覧 (2026-10-20、PLAN-19)。
 *
 * 記録のフォルダ (保管場所/<サーキットのフォルダ>/) の走行から周を数え、同じフォルダの laptimes.json に控えておく。
 * 走行の基準のファイルは .nmea (2026-10-21 から。どの機器の記録も同じ形で、ほかのアプリでも読めるため)。.nmea のない走行 (前の記録・
 * デジスパイスから吸い出しただけのもの) は .bon4 で数える。同じ名前の .nmea と .bon4 は 1 つの走行
 * 一覧を開くたびにフォルダと控えを照らし合わせ、増えた・変わったファイルだけ計算し、消えたファイルの周は控えから消す。
 * コースの計測線・セクター線を直したとき (コースのハッシュが変わったとき) は、そのフォルダの周を全部計算し直す。
 * 周の非表示は控えにだけ書く (ファイルは消さない)。計算し直しても、同じファイルの同じ時刻の周に引き継ぐ。
 *
 * ファイルの読み書きは LapFileStore (iPhone のアプリ・デスクトップ版で別々) に任せる
 */

import type { ControlLine, Sector, TelemetryPoint } from '../types/telemetry';
import { keepRunParts, parseDigispiceRawBinary, SESSION_GAP_SEC } from './rawBinaryParser';
import { parseNmea } from './nmeaParser';
import { extractLaps } from './lapCalculator';

/** 記録のフォルダのファイル (path は保管場所からの道。例: sodegaura/20261024100000.bon4) */
export interface LapFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  /** false = iCloud にだけあって、この端末にまだない (読むと落としてくる)。分からなければ省く */
  local?: boolean;
}

/** 控えを作る途中で、何本読むごとに途中までの控えを書くか (数千本を読む途中でアプリが閉じても、やり直しを減らす) */
export const LAP_INDEX_CHECKPOINT = 20;

/** ファイルの読み書き (iPhone のアプリ・デスクトップ版で別々に用意する) */
export interface LapFileStore {
  list(): Promise<LapFileInfo[]>;
  read(path: string): Promise<Uint8Array>;
  /** ない・読めないときは null */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
}

/** 控えの 1 周 */
export interface LapRecord {
  /** 何周目か (1 から。走行が途中で長く止まって分かれたときは、分かれたまとまりごとに 1 から) */
  n: number;
  /** 分かれたまとまりの何番目か (1 から。分かれていない走行では無い)。解析で開くと _1・_2 … に分かれるのと同じ */
  part?: number;
  /** ラップタイム (秒) */
  time: number;
  /** 周の始まりの時刻 (UTC ミリ秒) */
  startMs: number;
  /** セクタータイム (秒。セクター線の順) */
  sectors: number[];
  topSpeed: number;
}

export interface LapFileRecord {
  size: number;
  mtimeMs: number;
  /** 走り始めの時刻 (UTC ミリ秒。ファイルの最初の点) */
  startMs: number | null;
  laps: LapRecord[];
  /**
   * この走行の動画 (同じフォルダにある動画のファイル名だけ。2026-10-20 に口だけ用意)。
   * 解析で開くときに一緒に読み込む。ファイルから作り直せないので、計算し直しても引き継ぐ
   */
  videos?: string[];
}

/** 非表示にした周 (ファイルと時刻で見分ける。計算し直して周の番号が変わっても引き継ぐため) */
export interface HiddenLap {
  file: string;
  part?: number;
  n: number;
  startMs: number;
}

/** 周を見分ける名前 (ファイル・まとまり・何周目か) */
export const lapKey = (file: string, part: number | undefined, n: number) => `${file}#${part ?? 1}#${n}`;

/** laptimes.json の中身 */
export interface LapIndex {
  version: 1;
  /** 計算に使ったコースのハッシュ (計測線とセクター線) */
  courseHash: string;
  courseName: string;
  files: Record<string, LapFileRecord>;
  hidden: HiddenLap[];
}

export const LAP_INDEX_FILE = 'laptimes.json';

/** 控え (laptimes.json) の書き換えを 1 つずつにする (周を隠す操作と、控えの作り直しが、互いの書き換えを古い中身で上書きしないように) */
let lapIndexWrites: Promise<void> = Promise.resolve();
export function queueLapIndexWrite(fn: () => Promise<void>): Promise<void> {
  const next = lapIndexWrites.then(fn, fn);
  lapIndexWrites = next.catch(() => {});
  return next;
}
/** 走行に付けられる動画の拡張子 */
const VIDEO_EXT = /\.(mp4|mov|m4v|lrv|insv|mkv|webm)$/i;

/** 走行に付けられる動画の名前か (同じフォルダのファイル名だけ。別のフォルダ・上のフォルダは指せない) */
export function isRunVideoName(name: string): boolean {
  return !!name && !/[\\/]/.test(name) && name !== '.' && name !== '..' && !name.startsWith('.') && VIDEO_EXT.test(name);
}
/** 非表示を引き継ぐときに、同じ周とみなす周の始まりの時刻の差 */
const SAME_LAP_MS = 5000;

/** 計算に使うコース */
export interface LapCourse {
  name: string;
  controlLine: ControlLine;
  sectors: Sector[];
}

/**
 * コースのハッシュ: 計測線とセクター線の位置から求める (コース図はラップタイムに効かないので入れない)。
 * 位置は 1/10,000,000 度に丸めるので、同じ線なら同じハッシュになる
 */
export function courseHash(course: Pick<LapCourse, 'controlLine' | 'sectors'>): string {
  const q = (v: number) => Math.round(v * 1e7);
  const line = (l: { latA: number; lonA: number; latB: number; lonB: number }) => [q(l.latA), q(l.lonA), q(l.latB), q(l.lonB)].join(',');
  const text = [line(course.controlLine), ...course.sectors.map(line)].join('|');
  // FNV-1a (32 ビット) を 2 つ、違う初めの値で求めてつなぐ (偶然の一致を減らす)
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return fnv(0x811c9dc5) + fnv(0x2f6b5a1d);
}

/** .bon4 から周を数える (計測線で区切れた周だけ。ログ全体や途中で終わった周は入れない) */
export function lapsFromBon4(name: string, bytes: Uint8Array, course: LapCourse): { startMs: number | null; laps: LapRecord[] } {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return lapsFromParts(parseDigispiceRawBinary(name, buffer).map(p => p.points as TelemetryPoint[]), course);
}

/**
 * .nmea から周を数える。.bon4 と同じく、記録の空き (SESSION_GAP_SEC 以上) で走行を分ける (分けた番号 part を .bon4 とそろえ、
 * 隠した周の印を引き継げるように)
 */
export function lapsFromNmea(name: string, bytes: Uint8Array, course: LapCourse): { startMs: number | null; laps: LapRecord[] } {
  const { points } = parseNmea(new TextDecoder().decode(bytes), name);
  const parts: TelemetryPoint[][] = [];
  for (const p of points) {
    const cur = parts[parts.length - 1];
    if (cur && p.time - cur[cur.length - 1].time < SESSION_GAP_SEC) cur.push(p);
    else parts.push([p]);
  }
  return lapsFromParts(keepRunParts(parts, p => p.time), course);
}

/** 走行のファイルから周を数える (.nmea か .bon4) */
export function lapsFromFile(name: string, bytes: Uint8Array, course: LapCourse): { startMs: number | null; laps: LapRecord[] } {
  return /\.nmea$/i.test(name) ? lapsFromNmea(name, bytes, course) : lapsFromBon4(name, bytes, course);
}

/** 走行の名前 (日付のフォルダ・拡張子を除く)。同じ名前の .nmea と .bon4 は同じ走行 */
export function runStem(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1).replace(/\.(nmea|bon4)$/i, '');
}

function lapsFromParts(pointParts: TelemetryPoint[][], course: LapCourse): { startMs: number | null; laps: LapRecord[] } {
  const parts = pointParts.map(points => ({ points }));
  const laps: LapRecord[] = [];
  let startMs: number | null = null;
  parts.forEach((part, pi) => {
    const points = part.points as TelemetryPoint[];
    const first = points[0]?.timestamp ? Date.parse(points[0].timestamp) : NaN;
    if (startMs === null && Number.isFinite(first)) startMs = first;
    const t0 = points[0]?.time ?? 0;
    let n = 0;
    for (const lap of extractLaps(points, course.controlLine, course.sectors).laps) {
      if (lap.isWholeSession || lap.isPartialLap) continue;
      n++;
      laps.push({
        n,
        ...(parts.length > 1 ? { part: pi + 1 } : {}),
        time: Number(lap.lapTime.toFixed(3)),
        // 時刻の無いログでも、周ごとに違う値になるよう、ファイルの頭からの時間にする (隠した周の引き継ぎに使う)
        startMs: Math.round((Number.isFinite(first) ? first : pi * 1e9) + (lap.startTime - t0) * 1000),
        sectors: lap.sectors.map(s => Number(s.time.toFixed(3))),
        topSpeed: Number(lap.topSpeed.toFixed(1))
      });
    }
  });
  return { startMs, laps };
}

/** 控えを読む (無い・壊れている・形が違うときは null) */
export function parseLapIndex(text: string | null): LapIndex | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as LapIndex;
    if (v?.version !== 1 || typeof v.files !== 'object' || !Array.isArray(v.hidden)) return null;
    return v;
  } catch {
    return null;
  }
}

/** 同じ走行 (名前が同じで、日付のフォルダ・形式が違う) の控え */
function sameRunRecord(files: Record<string, LapFileRecord>, name: string): LapFileRecord | undefined {
  const stem = runStem(name);
  const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  // 同じ日付のフォルダ (か、日付のフォルダへ移す前の、フォルダのないもの) の同じ名前だけ。ほかの日の同じ名前の走行と混ぜない
  const key = Object.keys(files).find(k => k !== name && runStem(k) === stem && (dir(k) === dir(name) || dir(k) === ''));
  return key ? files[key] : undefined;
}

/** 非表示の印を、計算し直した周へ引き継ぐ (同じファイルで、始まりの時刻がいちばん近い周。SAME_LAP_MS より離れていれば捨てる) */
function carryHidden(hidden: HiddenLap[], files: Record<string, LapFileRecord>): HiddenLap[] {
  const out: HiddenLap[] = [];
  for (const h0 of hidden) {
    // 日付のフォルダへ移したファイル (前はファイルの名前だけ) にも引き継ぐ
    // 日付のフォルダへ移した・.bon4 から .nmea に基準を替えた走行にも引き継ぐ (同じ走行の名前で探す)
    const moved = files[h0.file] ? h0.file : Object.keys(files).find(k => runStem(k) === runStem(h0.file));
    const h = moved && moved !== h0.file ? { ...h0, file: moved } : h0;
    const laps = files[h.file]?.laps ?? [];
    let best: LapRecord | null = null;
    for (const l of laps) if (!best || Math.abs(l.startMs - h.startMs) < Math.abs(best.startMs - h.startMs)) best = l;
    if (best && Math.abs(best.startMs - h.startMs) <= SAME_LAP_MS && !out.some(o => o.file === h.file && o.part === best!.part && o.n === best!.n)) {
      out.push({ file: h.file, ...(best.part ? { part: best.part } : {}), n: best.n, startMs: best.startMs });
    }
  }
  return out;
}

/**
 * 1 つのサーキットのフォルダの控えを、フォルダのファイルに合わせて作り直す (変わったところだけ計算する)。
 * files はそのフォルダの .bon4 (folder/xxx.bon4)。変わっていなければ、前の控えをそのまま返す (changed: false)
 */
export async function reconcileFolder(
  folder: string,
  files: LapFileInfo[],
  course: LapCourse,
  prev: LapIndex | null,
  read: (path: string) => Promise<Uint8Array>,
  compute: (name: string, bytes: Uint8Array, course: LapCourse) => { startMs: number | null; laps: LapRecord[] } = lapsFromFile,
  /** 途中までの控え (LAP_INDEX_CHECKPOINT 本読むごと)。書いておけば、途中で閉じても次はその続きから読む */
  onCheckpoint?: (partial: LapIndex) => Promise<void>
): Promise<{ index: LapIndex; changed: boolean; computed: number }> {
  const hash = courseHash(course);
  const sameCourse = prev?.courseHash === hash;
  const next: Record<string, LapFileRecord> = {};
  let changed = !prev || !sameCourse || prev.courseName !== course.name;
  let computed = 0;
  // 数えずに飛ばした走行 (iCloud にだけあって控えもないもの)。隠した周の印は、数えるまでそのまま残す
  const skipped: string[] = [];
  const names = new Set(files.map(f => f.path.slice(folder.length + 1)));
  for (const f of files) {
    const name = f.path.slice(folder.length + 1);
    // 日付のフォルダへ移したファイルは、前の名前 (ファイルの名前だけ) の控えを使う
    // 前の控えは、同じ道 → 日付のフォルダへ移す前の名前 → 同じ走行のもう一方の形式 (.bon4 で数えていた走行を .nmea で数え直すとき) の順に探す
    const prevRec = prev?.files[name] ?? prev?.files[name.slice(name.lastIndexOf('/') + 1)] ?? (prev ? sameRunRecord(prev.files, name) : undefined);
    const old = sameCourse ? prevRec : undefined;
    if (old && old.size === f.size && old.mtimeMs === f.mtimeMs) {
      next[name] = old;
      continue;
    }
    // iCloud にだけあるファイルは、周を数えるために落としてこない (数千本あると、携帯の回線で何 GB にもなる)。
    // 前の控えがあればそのまま使い、なければ「まだ数えていない」として控えに入れない (開いたときに落ちてきて、次に数える)
    if (f.local === false) {
      if (old) next[name] = old;
      else skipped.push(name);
      continue;
    }
    // 動画は計算では作れないので、前の控えから引き継ぐ (コースを直したときも)
    const videos = prevRec?.videos;
    const keep = videos?.length ? { videos } : {};
    try {
      const { startMs, laps } = compute(name, await read(f.path), course);
      next[name] = { size: f.size, mtimeMs: f.mtimeMs, startMs, laps, ...keep };
    } catch {
      // 読めなかったら、前の控えがあればそのまま残す (隠した周の印を消さない。大きさが違うままなので、次に開いたときに読み直す)。
      // 前の控えが無ければ、周なしで覚えておく (壊れたファイルを毎回読み直さないように。ファイルが変われば読み直す)
      next[name] = prevRec ?? { size: f.size, mtimeMs: f.mtimeMs, startMs: null, laps: [], ...keep };
    }
    computed++;
    changed = true;
    if (onCheckpoint && computed % LAP_INDEX_CHECKPOINT === 0) {
      // 途中まで: 読み終えた分と、前の控え (同じコースのもの) を合わせる。隠した周の印は前のまま (まだ読んでいない走行の印を消さない)
      // 前の控えは、今あるファイルの分だけ (消したファイルを途中の控えに戻さない)
      const partial: Record<string, LapFileRecord> = {};
      if (sameCourse && prev) for (const [k, v] of Object.entries(prev.files)) if (names.has(k)) partial[k] = v;
      await onCheckpoint({ version: 1, courseHash: hash, courseName: course.name, files: { ...partial, ...next }, hidden: prev?.hidden ?? [] }).catch(() => {});
    }
  }
  if (prev && Object.keys(prev.files).some(k => !(k in next))) changed = true;
  const hidden = carryHidden(prev?.hidden ?? [], next);
  // 数えずに飛ばした走行の印は、そのまま残す (日付のフォルダへ移した名前にして)
  for (const h of prev?.hidden ?? []) {
    const to = skipped.find(k => k === h.file || runStem(k) === runStem(h.file));
    if (to && !hidden.some(o => o.file === to && o.part === h.part && o.n === h.n)) hidden.push({ ...h, file: to });
  }
  if (prev && hidden.length !== prev.hidden.length) changed = true;
  return { index: { version: 1, courseHash: hash, courseName: course.name, files: next, hidden }, changed, computed };
}

/** 一覧に出す 1 周 */
export interface LapRow extends LapRecord {
  folder: string;
  file: string;
  /** 走り始めの時刻 */
  runStartMs: number | null;
  hidden: boolean;
}

/** 控えから、一覧の行を作る (新しい走行が先、走行の中は周の順) */
export function lapRows(folder: string, index: LapIndex): LapRow[] {
  const hidden = new Set(index.hidden.map(h => lapKey(h.file, h.part, h.n)));
  const rows: LapRow[] = [];
  for (const [file, rec] of Object.entries(index.files)) {
    for (const l of rec.laps) rows.push({ ...l, folder, file, runStartMs: rec.startMs, hidden: hidden.has(lapKey(file, l.part, l.n)) });
  }
  // 新しい走行が先。同じ時刻の走行はファイル名で分け、走行の中は周の順 (まとまり → 何周目か)
  return rows.sort((a, b) => (b.runStartMs ?? 0) - (a.runStartMs ?? 0) || a.file.localeCompare(b.file) || (a.part ?? 1) - (b.part ?? 1) || a.n - b.n);
}

/** 周の非表示を切り替えた控え */
export function setHidden(index: LapIndex, file: string, part: number | undefined, n: number, hide: boolean): LapIndex {
  const others = index.hidden.filter(h => !(h.file === file && (h.part ?? 1) === (part ?? 1) && h.n === n));
  const lap = index.files[file]?.laps.find(l => (l.part ?? 1) === (part ?? 1) && l.n === n);
  return { ...index, hidden: hide && lap ? [...others, { file, ...(lap.part ? { part: lap.part } : {}), n, startMs: lap.startMs }] : others };
}

/** 走行に動画を付けた控え (同じフォルダの動画のファイル名だけ。それ以外の名前は捨てる。空なら外す) */
export function setRunVideos(index: LapIndex, file: string, names: string[]): LapIndex {
  const rec = index.files[file];
  if (!rec) return index;
  const videos = [...new Set(names.filter(isRunVideoName))];
  const { videos: _old, ...rest } = rec;
  return { ...index, files: { ...index.files, [file]: videos.length ? { ...rest, videos } : rest } };
}

/** 同じフォルダにある動画 (走行に付けられるもの) のファイル名 */
export function videosInFolder(files: LapFileInfo[], folder: string): string[] {
  return files.filter(f => f.path.startsWith(`${folder}/`)).map(f => f.path.slice(folder.length + 1)).filter(isRunVideoName).sort();
}

/**
 * フォルダ分けした走行の基準のファイル。保管場所/<サーキットのフォルダ>/<日付 YYYYMMDD>/<走行>.nmea|.bon4 (2026-10-20 から) と、
 * 日付のフォルダのない 保管場所/<サーキットのフォルダ>/<走行>.nmea|.bon4 (それより前) の両方を数える。ほかの階層・形式は数えない。
 * 同じフォルダに同じ名前の .nmea と .bon4 があれば .nmea を基準にする (2026-10-21)
 */
/** 走行を置かないフォルダ (保管場所の直下) */
export const NON_RUN_FOLDERS: ReadonlySet<string> = new Set(['取り込み元', 'exports']);

export function groupRunsByFolder(files: LapFileInfo[]): Map<string, LapFileInfo[]> {
  const out = new Map<string, LapFileInfo[]>();
  const chosen = new Map<string, LapFileInfo>();
  for (const f of files) {
    const m = /^([^/]+)\/((?:\d{8}\/)?[^/]+)\.(nmea|bon4)$/i.exec(f.path);
    // 取り込んだ元のログ (取り込み元/)・共有のための書き出し (exports/) は走行ではない
    if (!m || NON_RUN_FOLDERS.has(m[1])) continue;
    const key = `${m[1]}/${m[2]}`;
    const cur = chosen.get(key);
    // .nmea を選ぶ。ただし .nmea が iCloud にだけあり .bon4 がこの端末にあるときは、落とさずに数えられる .bon4 を選ぶ
    const better = (a: LapFileInfo, b: LapFileInfo) => {
      const an = /\.nmea$/i.test(a.path), bn = /\.nmea$/i.test(b.path);
      if (an === bn) return false;
      if ((a.local ?? true) !== (b.local ?? true)) return a.local ?? true;
      return an;
    };
    if (!cur || better(f, cur)) chosen.set(key, f);
  }
  for (const f of chosen.values()) {
    const folder = f.path.slice(0, f.path.indexOf('/'));
    const list = out.get(folder);
    if (list) list.push(f); else out.set(folder, [f]);
  }
  return out;
}

/** 前の名前 (.bon4 だけを数えていたころ)。今は .nmea も数える */
export const groupBon4ByFolder = groupRunsByFolder;
