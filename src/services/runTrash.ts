/**
 * アプリのゴミ箱 (2026-10-28)。iPhone・iPad のアプリで走行を消すと、置き場の .trash/<id>/ へ元の道のまま移す。
 * 「ファイル」の最近削除した項目へ移すと、アプリが消したものは「復旧」を選べず戻せなかったため。
 * 走行の記録 (runs.json の行: 名前・メモ・同期など) は trash.json に添えておき、戻すときに書き戻す。
 * 30 日たったものは、走行の一覧を開いたときに本当に消す。デスクトップ版は OS のゴミ箱から戻せるので使わない
 */

import type { RunDeletePlan } from './runDelete';
import type { RunItem } from './runOpener';
import { findRunRow, readRunsFile, removeRunRow, updateRun, type RunRow } from './runsFile';
import type { RunStore } from './runStore';

/** 戻せる日数 */
export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** trash.json の中身 */
export interface TrashManifest {
  v: 1;
  /** 消した時刻 (ms) */
  trashedAt: number;
  /** サーキットのフォルダ・走行のファイル (RunItem と同じ) */
  folder: string;
  file: string;
  courseName: string | null;
  startMs: number | null;
  lapCount: number;
  best: number | null;
  /** runs.json の行 (無ければ null) */
  row: RunRow | null;
}

/** ゴミ箱の中の 1 つの走行 */
export interface TrashedRun {
  id: string;
  /** trash.json が読めなかったときは null (ファイルだけ出す) */
  manifest: TrashManifest | null;
  files: Array<{ path: string; size: number }>;
  size: number;
  trashedAt: number;
  /** この時刻を過ぎたら本当に消す */
  expiresAt: number;
}

/** ゴミ箱の印 (時刻と乱数。道に使える文字だけ) */
export function newTrashId(now = Date.now()): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseManifest(text: string | undefined): TrashManifest | null {
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Partial<TrashManifest>;
    if (m.v !== 1 || typeof m.folder !== 'string' || typeof m.file !== 'string' || typeof m.trashedAt !== 'number') return null;
    return {
      v: 1, trashedAt: m.trashedAt, folder: m.folder, file: m.file,
      courseName: typeof m.courseName === 'string' ? m.courseName : null,
      startMs: typeof m.startMs === 'number' ? m.startMs : null,
      lapCount: typeof m.lapCount === 'number' ? m.lapCount : 0,
      best: typeof m.best === 'number' ? m.best : null,
      row: m.row && typeof m.row === 'object' ? m.row : null
    };
  } catch {
    return null;
  }
}

/** ネイティブの一覧を、新しい順の TrashedRun にする (trash.json が無いものはフォルダの時刻で数える) */
export function toTrashedRuns(items: Array<{ id: string; manifest?: string; files: Array<{ path: string; size: number }>; mtimeMs: number }>): TrashedRun[] {
  return items
    .map(i => {
      const manifest = parseManifest(i.manifest);
      const trashedAt = manifest?.trashedAt ?? i.mtimeMs;
      return { id: i.id, manifest, files: i.files, size: i.files.reduce((n, f) => n + f.size, 0), trashedAt, expiresAt: trashedAt + TRASH_DAYS * DAY_MS };
    })
    .sort((a, b) => b.trashedAt - a.trashedAt);
}

/** あと何日で消えるか (消したばかりは 30、残り 1 日を切ったら 1) */
export const daysLeft = (r: TrashedRun, now = Date.now()) => Math.max(1, Math.ceil((r.expiresAt - now) / DAY_MS));

/** 走行をゴミ箱へ移す (ログを移せたら runs.json の行を消す。消すときと同じ)。移せなかったファイルを返す */
export async function trashRun(store: RunStore, item: RunItem, plan: RunDeletePlan, now = Date.now()): Promise<{ failed: Array<{ path: string; error: string }> }> {
  if (!store.trash) throw new Error('no trash here');
  // 行は今の runs.json から読む (開いてから直した名前なども入るように)。読めなければ一覧のもの
  const row = await readRunsFile(store, item.folder).then(f => findRunRow(f, item.file), () => null) ?? item.entry;
  const manifest: TrashManifest = {
    v: 1, trashedAt: now, folder: item.folder, file: item.file,
    courseName: item.courseName, startMs: item.startMs, lapCount: item.lapCount, best: item.best, row: row ?? null
  };
  const r = await store.trash.move(plan.remove.map(f => f.path), newTrashId(now), JSON.stringify(manifest));
  const logs = plan.remove.filter(f => f.kind === 'log');
  const logGone = logs.length > 0 && logs.every(f => r.moved.includes(f.path));
  if (logGone) await removeRunRow(store, item.folder, item.file);
  return { failed: r.failed };
}

/** ゴミ箱の中の走行 (新しい順) */
export async function listTrash(store: RunStore): Promise<TrashedRun[]> {
  if (!store.trash) return [];
  return toTrashedRuns(await store.trash.list());
}

/** 戻す (ファイルを戻してから、ログが戻ったら runs.json の行を書き戻す)。戻せなかったファイルを返す */
export async function restoreTrashedRun(store: RunStore, run: TrashedRun): Promise<{ failed: Array<{ path: string; error: string }> }> {
  if (!store.trash) throw new Error('no trash here');
  const r = await store.trash.restore(run.id);
  const m = run.manifest;
  const logPath = m ? `${m.folder}/${m.file}` : null;
  if (m?.row && logPath && r.restored.includes(logPath)) {
    const { updatedAt: _u, ...row } = m.row;
    await updateRun(store, m.folder, m.file, () => row);
  }
  return { failed: r.failed };
}

/** 本当に消す */
export async function purgeTrash(store: RunStore, ids: string[]): Promise<{ failed: Array<{ path: string; error: string }> }> {
  if (!store.trash || !ids.length) return { failed: [] };
  return store.trash.purge(ids);
}

/** 30 日を過ぎたものを本当に消す (走行の一覧を開いたとき)。残ったものを返す */
export async function purgeExpired(store: RunStore, runs: TrashedRun[], now = Date.now()): Promise<TrashedRun[]> {
  const old = runs.filter(r => r.expiresAt <= now).map(r => r.id);
  if (!old.length) return runs;
  const { failed } = await purgeTrash(store, old);
  const kept = new Set(failed.map(f => f.path));
  return runs.filter(r => !old.includes(r.id) || kept.has(r.id));
}
