/**
 * runs.json (走行の情報。docs/session_storage_design.md の runs.json)。2026-10-20。
 * サーキットのフォルダごとに 1 つ。走行のファイル名ごとに、付けた動画と、動画の同期 (同期プロジェクトの形) を持つ。
 * ファイルから作り直せない、利用者が付けた情報だけを入れる (周の計算の結果は laptimes.json)。
 * 書くたびに直前に読み直し、変えた走行の行だけを差し替える (ほかの端末が書いた行を消さない)
 */

import type { SyncProjectData } from './videoSyncManager';
import type { LapFileStore } from './lapIndex';
import type { RunStore } from './runStore';
import { isRunVideoName } from './lapIndex';

export const RUNS_FILE = 'runs.json';

export interface RunEntry {
  updatedAt: string;
  /** この走行の動画 (同じフォルダのファイル名だけ) */
  videos?: string[];
  /** 動画の同期 (同期プロジェクトの形。動画はファイル名で指す) */
  sync?: SyncProjectData;
}

export interface RunsFile {
  version: 1;
  runs: Record<string, RunEntry>;
}

const empty = (): RunsFile => ({ version: 1, runs: {} });

export function parseRunsFile(text: string | null): RunsFile {
  if (!text) return empty();
  try {
    const v = JSON.parse(text);
    if (!v || v.version !== 1 || typeof v.runs !== 'object' || !v.runs) return empty();
    const runs: Record<string, RunEntry> = {};
    for (const [name, e] of Object.entries(v.runs as Record<string, RunEntry>)) {
      if (!e || typeof e !== 'object' || typeof e.updatedAt !== 'string') continue;
      runs[name] = {
        updatedAt: e.updatedAt,
        videos: Array.isArray(e.videos) ? e.videos.filter(x => typeof x === 'string' && isRunVideoName(x)) : undefined,
        sync: e.sync && typeof e.sync === 'object' ? e.sync : undefined
      };
    }
    return { version: 1, runs };
  } catch {
    return empty();
  }
}

/** runs.json として読める文か (壊れたものに書き足して、ほかの行を消さないため) */
function isRunsFileText(text: string): boolean {
  try {
    const v = JSON.parse(text);
    return !!v && v.version === 1 && typeof v.runs === 'object' && !!v.runs;
  } catch {
    return false;
  }
}

export async function readRunsFile(store: LapFileStore, folder: string): Promise<RunsFile> {
  return parseRunsFile(await store.readText(`${folder}/${RUNS_FILE}`));
}

/** 1 つの走行の行を書き換える (直前に読み直して、ほかの行はそのまま) */
export async function updateRun(store: RunStore, folder: string, file: string, patch: Omit<RunEntry, 'updatedAt'>): Promise<RunEntry> {
  // 読めないとき (無いのではなく) は書かない (空とみなして書くと、ほかの走行の行を消すため)
  const text = await store.readTextStrict(`${folder}/${RUNS_FILE}`);
  if (text !== null && !isRunsFileText(text)) throw new Error('runs.json could not be read');
  const current = parseRunsFile(text);
  // 日付のフォルダへ移す前に、ファイルの名前だけで書いた行は、新しい名前 (日付/ファイル) の行へ移す
  const short = file.slice(file.lastIndexOf('/') + 1);
  const old = short !== file ? current.runs[short] : undefined;
  if (old) delete current.runs[short];
  const entry: RunEntry = { ...old, ...current.runs[file], ...patch, updatedAt: new Date().toISOString() };
  current.runs[file] = entry;
  await store.writeText(`${folder}/${RUNS_FILE}`, JSON.stringify(current, null, 1));
  return entry;
}
