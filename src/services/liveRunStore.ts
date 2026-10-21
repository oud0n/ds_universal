/**
 * ラップタイマーで走った記録を、走っている間に保存する (2026-10-20)。
 *
 * 受け取った測位を 2 秒ごとにまとめて、ブラウザの中のデータベース (IndexedDB) に足していく。
 * 1 回ごとに保存が確定するので、アプリが落ちたり閉じたりしても、直前の 2 秒までは残る。
 * あとから一覧にして、解析で開く・NMEA / bon4 で保存する (runFiles.ts)。iPhone のアプリでは、同じ測位をファイルにも足していく (LapTimerScreen)
 */

import type { LiveFix } from './liveLapTimer';

const DB_NAME = 'laploupe-laptimer';
const DB_VERSION = 1;
const RUNS = 'runs';
const CHUNKS = 'chunks';
/** 1 つの測位を数字いくつで持つか (時刻 ms・緯度・経度・速度 km/h・高度 m) */
const FIELDS = 5;

export interface RunMeta {
  id: string;
  /** 走り始めた時刻 (UTC ミリ秒。最初の測位の時刻) */
  startedMs: number;
  /** 最後に足した測位の時刻 */
  updatedMs: number;
  courseName: string;
  source: 'digspice' | 'phone' | 'racebox' | 'drogger';
  fixCount: number;
  lapCount: number;
  bestLapSec: number | null;
  /** iPhone のアプリで書いているファイルの名前 (拡張子なし)。ないときは null */
  fileBase: string | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['runId', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 走行の記録を始める */
export async function startRun(meta: Omit<RunMeta, 'fixCount' | 'lapCount' | 'bestLapSec' | 'updatedMs'>): Promise<RunMeta> {
  const run: RunMeta = { ...meta, updatedMs: meta.startedMs, fixCount: 0, lapCount: 0, bestLapSec: null };
  const db = await openDb();
  const tx = db.transaction(RUNS, 'readwrite');
  tx.objectStore(RUNS).put(run);
  await done(tx);
  return run;
}

/** 測位をまとめて足す (seq は 0 から順に)。走行の一覧の数字も一緒に直す */
export async function appendFixes(run: RunMeta, seq: number, fixes: LiveFix[], patch: Partial<RunMeta> = {}): Promise<RunMeta> {
  if (fixes.length === 0 && Object.keys(patch).length === 0) return run;
  const data = new Float64Array(fixes.length * FIELDS);
  fixes.forEach((f, i) => {
    data.set([f.tMs, f.latitude, f.longitude, f.speedKmh, f.altitude ?? NaN], i * FIELDS);
  });
  const next: RunMeta = {
    ...run,
    ...patch,
    fixCount: run.fixCount + fixes.length,
    updatedMs: fixes.length ? fixes[fixes.length - 1].tMs : run.updatedMs
  };
  const db = await openDb();
  const tx = db.transaction([RUNS, CHUNKS], 'readwrite');
  if (fixes.length) tx.objectStore(CHUNKS).put({ runId: run.id, seq, data });
  tx.objectStore(RUNS).put(next);
  await done(tx);
  return next;
}

/** 走行の一覧 (新しい順) */
export async function listRuns(): Promise<RunMeta[]> {
  const db = await openDb();
  const runs = await request(db.transaction(RUNS).objectStore(RUNS).getAll() as IDBRequest<RunMeta[]>);
  return runs.sort((a, b) => b.startedMs - a.startedMs);
}

/** 走行の測位を全部読む */
export async function loadFixes(runId: string): Promise<LiveFix[]> {
  const db = await openDb();
  const range = IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
  const chunks = await request(db.transaction(CHUNKS).objectStore(CHUNKS).getAll(range) as IDBRequest<Array<{ seq: number; data: Float64Array }>>);
  chunks.sort((a, b) => a.seq - b.seq);
  const out: LiveFix[] = [];
  for (const c of chunks) {
    for (let i = 0; i + FIELDS <= c.data.length; i += FIELDS) {
      const alt = c.data[i + 4];
      out.push({ tMs: c.data[i], latitude: c.data[i + 1], longitude: c.data[i + 2], speedKmh: c.data[i + 3], altitude: Number.isNaN(alt) ? undefined : alt, valid: true });
    }
  }
  return out;
}

/** 走行を消す */
export async function deleteRun(runId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([RUNS, CHUNKS], 'readwrite');
  tx.objectStore(RUNS).delete(runId);
  tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]));
  await done(tx);
}
