/**
 * runs.json (走行の情報)。サーキットのフォルダごとに 1 つ。2026-10-20、2 版は 2026-10-24 (docs/run_storage_v2.md)。
 *
 * 走行ごとに 1 行 (行の名前は「日付のフォルダ/拡張子なしの名前」。.nmea と .bon4 は 1 つの行)。
 * ファイルから作り直せない、利用者が付けた情報だけを入れる (付けた動画・動画の同期・ログの時計の補正・名前・メモ)。
 * 周の計算の結果と隠した周は laptimes.json (lapIndex.ts)。
 *
 * - 1 版 (1.0.2 まで) も読み、2 版の形に読み替える。書くのは走行の中身が変わったときだけで、そのときファイル全体を 2 版にする
 * - 知らない項目 (上の段・走行の行・動画・ピンの中) は、そのまま残す (この先の版で足した項目を消さない)
 * - 書くたびに直前に読み直し、変えた走行の行だけを差し替える (ほかの端末が書いた行を消さない)
 * - iCloud がぶつかったときに作る写し (runs 2.json など) も読み、行ごとに新しいほうを使う。書くときに本体へ入れる
 */

import type { ClockSource } from './mediaClock';
import type { LapFileStore } from './lapIndex';
import type { RunStore } from './runStore';
import { isRunVideoName, runStem } from './lapIndex';

export const RUNS_FILE = 'runs.json';

/** 動画の時刻。logPart が数ならその走行のログ (何番目か) の先頭から offsetSec 秒、null なら utcMs (世界の時刻) */
export interface RunClock {
  source: ClockSource;
  logPart: number | null;
  offsetSec: number;
  utcMs: number | null;
  [key: string]: unknown;
}

/** 同期ピン。時刻はその走行のログ (logPart 番目) の時刻 */
export interface RunPin {
  name: string;
  logPart: number;
  logTimeSec: number;
  videoTimeSec: number;
  utcMs?: number | null;
  createdAt?: string;
  [key: string]: unknown;
}

export interface RunVideo {
  /** 同じフォルダの動画のファイル名 */
  name: string;
  size?: number;
  durationSec?: number;
  recordedAt?: string | null;
  timezone?: { video?: string; gps?: string };
  /** 動画を出すログ (その走行の何番目のログか) */
  part?: number | null;
  /** 動画を出すログを手で選んだ */
  chosen?: boolean;
  clock?: RunClock;
  pins?: RunPin[];
  [key: string]: unknown;
}

export interface RunRow {
  /** 変わらない印 (初めて書くときに付ける。解析用のセッション・参考ラップが走行を指すのに使う) */
  id?: string;
  updatedAt: string;
  name?: string;
  note?: string;
  /** 分かれた走行の何番目ごとの情報 (ログの時計の補正) */
  parts?: Record<string, { clockOffsetSec?: number; [key: string]: unknown }>;
  videos?: RunVideo[];
  /** 2 版に読み替えられなかった 1 版の行 (捨てずに残す) */
  legacy?: unknown;
  [key: string]: unknown;
}

export interface RunsFile {
  version: 2;
  runs: Record<string, RunRow>;
  [key: string]: unknown;
}

const empty = (): RunsFile => ({ version: 2, runs: {} });

/** 走行の行の名前 (日付のフォルダ/拡張子なしの名前。日付のフォルダの無い走行は名前だけ) */
export function runKey(file: string): string {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  return dir + runStem(file);
}

export function newRunId(): string {
  return `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const SOURCES: ClockSource[] = ['gps', 'manual', 'creation'];
/** 書いた時刻 (読めない時刻は、いちばん古いものとみなす) */
const stamp = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) ? t : -Infinity; };
const newer = (a: RunRow | undefined, b: RunRow) => !a || stamp(b.updatedAt) > stamp(a.updatedAt);

/** 2 版の行を確かめる (おかしな値は落とす。知らない項目は残す) */
function cleanRow(e: Record<string, unknown>): RunRow | null {
  // 書いた時刻の無い行も捨てない (いちばん古いものとして残す。この先の版や手で直した行を消さないため)
  const row: RunRow = { ...e, updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date(0).toISOString() };
  if (e.id !== undefined && typeof e.id !== 'string') delete row.id;
  if (e.name !== undefined && typeof e.name !== 'string') delete row.name;
  if (e.note !== undefined && typeof e.note !== 'string') delete row.note;
  if (e.parts !== undefined) {
    if (isObj(e.parts)) {
      const parts: NonNullable<RunRow['parts']> = {};
      for (const [k, p] of Object.entries(e.parts)) if (/^\d+$/.test(k) && isObj(p)) parts[k] = p as NonNullable<RunRow['parts']>[string];
      row.parts = parts;
    } else delete row.parts;
  }
  if (e.videos !== undefined) {
    row.videos = Array.isArray(e.videos) ? e.videos.map(cleanVideo).filter((v): v is RunVideo => !!v) : [];
  }
  return row;
}

function cleanVideo(v: unknown): RunVideo | null {
  if (!isObj(v) || typeof v.name !== 'string' || !isRunVideoName(v.name)) return null;
  const out: RunVideo = { ...v, name: v.name };
  const c = v.clock;
  if (c !== undefined) {
    const okClock = isObj(c) && SOURCES.includes(c.source as ClockSource) && (c.logPart === null || (num(c.logPart) ?? 0) >= 1)
      && num(c.offsetSec) !== undefined && (c.utcMs === null || num(c.utcMs) !== undefined);
    if (!okClock) delete out.clock;
  }
  if (v.pins !== undefined) {
    out.pins = Array.isArray(v.pins)
      ? (v.pins.filter(p => isObj(p) && typeof p.name === 'string' && (num(p.logPart) ?? 0) >= 1 && num(p.logTimeSec) !== undefined && num(p.videoTimeSec) !== undefined) as RunPin[])
      : [];
  }
  return out;
}

/** 1 版の行 (同期プロジェクトの形) を 2 版の行にする。読み替えられなければ legacy に入れて残す */
export function rowFromV1(file: string, e: Record<string, unknown>): RunRow {
  const updatedAt = typeof e.updatedAt === 'string' ? e.updatedAt : new Date(0).toISOString();
  try {
    const stem = runStem(file);
    const sync = isObj(e.sync) ? e.sync : null;
    const sessions = sync && Array.isArray(sync.sessions) ? sync.sessions.filter(isObj) : [];
    // 保存したときのログの ID → その走行の何番目のログか (名前の終わりの _2 など。分かれていなければ 1)
    const partOf = (id: unknown): number | undefined => {
      if (typeof id !== 'string') return undefined;
      const s = sessions.find(x => x.id === id);
      if (!s) return undefined;
      const name = typeof s.sessionName === 'string' ? s.sessionName : '';
      const m = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)$`).exec(name);
      return m ? Number(m[1]) : 1;
    };
    const parts: NonNullable<RunRow['parts']> = {};
    for (const s of sessions) {
      const n = partOf(s.id);
      const off = num(s.clockOffsetSec);
      if (n !== undefined && off !== undefined) parts[String(n)] = { clockOffsetSec: off };
    }
    const syncVideos = sync && Array.isArray(sync.videos) ? sync.videos.filter(isObj) : [];
    const pins = sync && Array.isArray(sync.pins) ? sync.pins.filter(isObj) : [];
    const listed = Array.isArray(e.videos) ? e.videos.filter((x): x is string => typeof x === 'string' && isRunVideoName(x)) : [];
    const names = listed.length ? listed : syncVideos.map(v => v.fileName).filter((x): x is string => typeof x === 'string' && isRunVideoName(x));
    const videos: RunVideo[] = [...new Set(names)].map(name => {
      const v = syncVideos.find(x => x.fileName === name);
      if (!v) return { name };
      const out: RunVideo = { name };
      if (num(v.fileSize) !== undefined) out.size = num(v.fileSize);
      if (num(v.durationSec) !== undefined) out.durationSec = num(v.durationSec);
      const rec = typeof v.rawRecordedAt === 'string' ? v.rawRecordedAt : typeof v.recordedAtJst === 'string' ? v.recordedAtJst : null;
      if (rec) out.recordedAt = rec;
      if (typeof v.videoTimezone === 'string' || typeof v.gpsTimezone === 'string') {
        out.timezone = { ...(typeof v.videoTimezone === 'string' ? { video: v.videoTimezone } : {}), ...(typeof v.gpsTimezone === 'string' ? { gps: v.gpsTimezone } : {}) };
      }
      const shown = partOf(v.matchedSessionId);
      out.part = shown ?? null;
      if (v.sessionChosenManually === true) out.chosen = true;
      const c = isObj(v.clock) ? v.clock : null;
      if (c && SOURCES.includes(c.source as ClockSource) && num(c.offsetSec) !== undefined) {
        const utcMs = num(c.utcMs) ?? null;
        const logPart = c.logId ? partOf(c.logId) : undefined;
        // ほかのログに付いた時刻 (この走行のログでない) は、控えの世界の時刻で持つ。それも無ければ時刻は持たない (動画は捨てない)
        if (logPart !== undefined) out.clock = { source: c.source as ClockSource, logPart, offsetSec: num(c.offsetSec)!, utcMs };
        else if (utcMs !== null) out.clock = { source: c.source as ClockSource, logPart: null, offsetSec: 0, utcMs };
      }
      const myPins = pins.filter(p => p.trackFileName === name && typeof p.name === 'string' && num(p.sessionTimeSec) !== undefined && num(p.videoTimeSec) !== undefined);
      if (myPins.length) {
        out.pins = myPins.map(p => ({
          name: p.name as string,
          logPart: partOf(p.sessionId) ?? shown ?? 1,
          logTimeSec: num(p.sessionTimeSec)!,
          videoTimeSec: num(p.videoTimeSec)!,
          ...(typeof p.createdAt === 'string' ? { createdAt: p.createdAt } : {})
        }));
      }
      return out;
    });
    // 1 版の行のほかの項目は残す。同期が読めない形だったときは、元の行を legacy に残す (捨てない)
    const { updatedAt: _u, videos: _v, sync: _s, ...rest } = e;
    const unreadable = e.sync !== undefined && !sync;
    return { ...rest, updatedAt, ...(Object.keys(parts).length ? { parts } : {}), videos, ...(unreadable ? { legacy: e } : {}) };
  } catch {
    return { updatedAt, legacy: e };
  }
}

/** runs.json を読む (1 版は 2 版の形に読み替える)。読めない・壊れているときは空 */
export function parseRunsFile(text: string | null): RunsFile {
  if (!text) return empty();
  try {
    const v = JSON.parse(text);
    if (!isObj(v) || !isObj(v.runs)) return empty();
    if (v.version === 2) {
      const runs: Record<string, RunRow> = {};
      for (const [key, e] of Object.entries(v.runs)) {
        const row = isObj(e) ? cleanRow(e) : null;
        if (row) runs[key] = row;
      }
      return { ...v, version: 2, runs };
    }
    if (v.version === 1) {
      const runs: Record<string, RunRow> = {};
      for (const [file, e] of Object.entries(v.runs)) {
        if (!isObj(e)) continue;
        const key = runKey(file);
        const row = rowFromV1(file, e);
        // 同じ走行の 2 行 (.nmea と .bon4) は、新しいほうを使う (外した動画が、古い行から戻らないように)
        if (newer(runs[key], row)) runs[key] = row;
      }
      const { version: _v, runs: _r, ...rest } = v;
      return { ...rest, version: 2, runs };
    }
    return empty();
  } catch {
    return empty();
  }
}

/** runs.json として読める文か (1 版・2 版。読めない形に書き足して、ほかの行を消さないため) */
function isRunsFileText(text: string): boolean {
  try {
    const v = JSON.parse(text);
    return isObj(v) && (v.version === 1 || v.version === 2) && isObj(v.runs);
  } catch {
    return false;
  }
}

/** 2 つの runs.json を合わせる (行ごとに新しいほう。ぶつかったときの写しを本体に入れる) */
export function mergeRunsFiles(base: RunsFile, other: RunsFile): RunsFile {
  const runs = { ...base.runs };
  for (const [key, row] of Object.entries(other.runs)) if (newer(runs[key], row)) runs[key] = row;
  return { ...other, ...base, version: 2, runs };
}

/** iCloud がぶつかったときに作った写し (runs 2.json など) の道。フォルダごと (一覧を作るときに見つける) */
const conflictCopies = new Map<string, string[]>();

/** ぶつかったときの写しか (runs 2.json・runs (2).json など) */
export function isRunsConflictCopy(name: string): boolean {
  return /^runs[ _-]+\(?\d+\)?\.json$/i.test(name);
}

/** 一覧を作るときに見つけた、ぶつかったときの写しを覚える */
export function noteRunsConflictCopies(folder: string, paths: string[]): void {
  if (paths.length) conflictCopies.set(folder, paths);
  else conflictCopies.delete(folder);
}

export async function readRunsFile(store: LapFileStore, folder: string): Promise<RunsFile> {
  let file = parseRunsFile(await store.readText(`${folder}/${RUNS_FILE}`));
  for (const p of conflictCopies.get(folder) ?? []) file = mergeRunsFiles(file, parseRunsFile(await store.readText(p).catch(() => null)));
  return file;
}

/** 1 つの走行の行を探す (行の名前で。日付のフォルダへ移す前の、名前だけの行も) */
export function findRunRow(file: RunsFile, runFile: string): RunRow | null {
  return file.runs[runKey(runFile)] ?? file.runs[runStem(runFile)] ?? null;
}

/** runs.json ごとの書き換えの順番 (2 つの走行の書き換えが同じ中身を読んで、互いの行を消さないように) */
const runsWrites = new Map<string, Promise<unknown>>();

/**
 * 1 つの走行の行を書き換える (直前に読み直して、ほかの行はそのまま)。同じ runs.json の書き換えは 1 つずつ。
 * change は今の行 (無ければ undefined) を受け取って新しい中身を返す。id・updatedAt はここで付ける
 */
export function updateRun(store: RunStore, folder: string, file: string, change: (row: RunRow | undefined) => Partial<RunRow>): Promise<RunRow> {
  const key = `${folder}/${RUNS_FILE}`;
  const run = () => updateRunNow(store, folder, file, change);
  const next = (runsWrites.get(key) ?? Promise.resolve()).then(run, run);
  const tail = next.catch(() => undefined);
  runsWrites.set(key, tail);
  void tail.then(() => { if (runsWrites.get(key) === tail) runsWrites.delete(key); });
  return next;
}

async function updateRunNow(store: RunStore, folder: string, file: string, change: (row: RunRow | undefined) => Partial<RunRow>): Promise<RunRow> {
  // 読めないとき (無いのではなく) は書かない (空とみなして書くと、ほかの走行の行を消すため)
  const text = await store.readTextStrict(`${folder}/${RUNS_FILE}`);
  if (text !== null && !isRunsFileText(text)) throw new Error('runs.json could not be read');
  let current = parseRunsFile(text);
  for (const p of conflictCopies.get(folder) ?? []) current = mergeRunsFiles(current, parseRunsFile(await store.readText(p).catch(() => null)));
  const key = runKey(file);
  // 日付のフォルダへ移す前に、名前だけで書いた行は、新しい名前 (日付/名前) の行へ移す
  const short = runStem(file);
  const old = short !== key ? current.runs[short] : undefined;
  if (old) delete current.runs[short];
  const prev = current.runs[key] ?? old;
  const changed = change(prev);
  const row: RunRow = { ...changed, id: (typeof changed.id === 'string' ? changed.id : undefined) ?? prev?.id ?? newRunId(), updatedAt: new Date().toISOString() };
  current.runs[key] = row;
  await store.writeText(`${folder}/${RUNS_FILE}`, JSON.stringify(current, null, 1));
  return row;
}
