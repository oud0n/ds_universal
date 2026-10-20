/**
 * 過去の走行の一覧と、走行を開く (ログ・同じフォルダの動画・動画の同期をそろえて開く)。2026-10-20。
 * docs/session_storage_design.md の「作る順番」の 1〜3。
 *
 * - 一覧: 保管場所のサーキットのフォルダの .bon4 (laptimes.json の控えで周を数えたもの) を、新しい順に並べる
 * - 開く: ログを読み込み、runs.json に書いた動画 (なければ、同じフォルダの動画のうち撮影の時刻が近いもの) を範囲を読みながら開き、
 *   runs.json の同期 (同期プロジェクトの形) を戻す
 * - 覚える: 開いた走行の動画と同期は、変わるたびに runs.json に書く (少し待ってまとめて書く)
 */

import type { Session } from '../types/telemetry';
import { loadLapHistory } from './lapHistory';
import { isRunVideoName, lapKey } from './lapIndex';
import { readRunsFile, updateRun, type RunEntry } from './runsFile';
import type { RunFileInfo, RunStore } from './runStore';
import { parseVideoMetadata } from './videoMetadataParser';
import { remoteFileLike, type RemoteVideo } from './remoteVideo';
import { videoSyncManager, type SyncProjectData } from './videoSyncManager';
import { videoViewStore } from './videoViewStore';
import { createSyncPin } from './videoSyncPinManager';

/** 一覧の 1 行 (1 つの走行) */
export interface RunItem {
  folder: string;
  /** 走行のファイル名 (folder の中) */
  file: string;
  courseName: string | null;
  startMs: number | null;
  /** 周の数 (隠した周を除く) */
  lapCount: number;
  /** いちばん速い周 (秒。隠した周を除く) */
  best: number | null;
  /** runs.json に書いた動画 */
  videos: string[];
  /** 同期を覚えているか */
  synced: boolean;
  /** 同じフォルダの動画 */
  folderVideos: RunFileInfo[];
  entry: RunEntry | null;
}

/** 保管場所の全部の走行 (新しい順) */
export async function listRuns(store: RunStore, onProgress?: (folder: string) => void): Promise<RunItem[]> {
  const all = await store.listAll();
  const folders = await loadLapHistory(store, onProgress);
  const out: RunItem[] = [];
  for (const f of folders) {
    const runs = await readRunsFile(store, f.folder);
    const folderVideos = all.filter(x => x.path.startsWith(`${f.folder}/`) && isRunVideoName(x.path.slice(f.folder.length + 1)));
    const hidden = new Set((f.index?.hidden ?? []).map(h => lapKey(h.file, h.part, h.n)));
    const names = new Set([
      ...Object.keys(f.index?.files ?? {}),
      ...all.filter(x => x.path.startsWith(`${f.folder}/`) && /\.bon4$/i.test(x.path)).map(x => x.path.slice(f.folder.length + 1))
    ]);
    for (const file of names) {
      if (file.includes('/')) continue;
      const rec = f.index?.files[file];
      const laps = (rec?.laps ?? []).filter(l => !hidden.has(lapKey(file, l.part, l.n)));
      const entry = runs.runs[file] ?? null;
      const videos = entry?.videos ?? rec?.videos ?? [];
      out.push({
        folder: f.folder,
        file,
        courseName: f.courseName,
        startMs: rec?.startMs ?? null,
        lapCount: laps.length,
        best: laps.length ? Math.min(...laps.map(l => l.time)) : null,
        videos,
        synced: !!entry?.sync,
        folderVideos,
        entry
      });
    }
  }
  return out.sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0) || b.file.localeCompare(a.file));
}

export const totalBytes = (files: RunFileInfo[]) => files.reduce((s, f) => s + f.size, 0);

/** 走行の動画にする候補: runs.json に書いたもの。なければ、同じフォルダの端末にある動画のうち、撮影の時刻が走り始めの ±14 時間のもの
 * (時差の分を広めに取る。最後は動画の GPS・撮影時刻での照合で、この走行に合わなかったものを外す) */
export async function videoCandidates(store: RunStore, item: RunItem): Promise<{ local: RemoteVideo[]; missing: RunFileInfo[]; fromRuns: boolean }> {
  const byName = new Map(item.folderVideos.map(v => [v.path.slice(item.folder.length + 1), v]));
  // 古いアプリ (lapfile:// を読めない) では、動画は開かない
  if (!(await store.supportsVideos())) return { local: [], missing: [], fromRuns: !!item.videos.length };
  const toRemote = (v: RunFileInfo): RemoteVideo => ({ name: v.path.slice(item.folder.length + 1), size: v.size, url: store.videoUrl(v.path), path: v.path, lastModified: v.mtimeMs });
  if (item.videos.length) {
    const listed = item.videos.map(n => byName.get(n)).filter((v): v is RunFileInfo => !!v);
    return { local: listed.filter(v => v.local).map(toRemote), missing: listed.filter(v => !v.local), fromRuns: true };
  }
  if (item.startMs === null) return { local: [], missing: [], fromRuns: false };
  const local: RemoteVideo[] = [];
  for (const v of item.folderVideos.filter(x => x.local && !/\.lrv$/i.test(x.path))) {
    const remote = toRemote(v);
    try {
      const meta = await parseVideoMetadata(remoteFileLike(remote));
      const t = meta.creationTime?.getTime();
      if (t !== undefined && Math.abs(t - item.startMs) <= 14 * 3600_000) local.push(remote);
    } catch {
      // 読めない動画は候補にしない
    }
  }
  return { local, missing: [], fromRuns: false };
}

/** 開いている走行 (動画と同期を runs.json に書くため) */
interface OpenRun {
  store: RunStore;
  item: RunItem;
  sessionIds: Set<string>;
  circuitName: () => string;
  sessions: () => Session[];
  /** 覚える動画のファイル名 */
  names: Set<string>;
  /** runs.json にあるが、今回は開かなかった動画 (iCloud にだけある・見つからない)。消さずに残す */
  kept: SyncProjectData['videos'];
  keptNames: string[];
}

let current: OpenRun | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

/** 開いている走行の動画と同期を、runs.json に書く */
async function saveCurrent(): Promise<void> {
  const run = current;
  if (!run) return;
  const tracks = videoSyncManager.getTracks().filter(t => t.remote && run.names.has(t.remote.path));
  if (tracks.length === 0 && run.keptNames.length === 0) return;
  const key = run.circuitName() || 'default';
  const pins = videoViewStore.getPins(key).filter(p => tracks.some(t => t.id === p.trackId));
  const sync = JSON.parse(videoSyncManager.exportProjectJson(run.sessions().filter(s => run.sessionIds.has(s.id)), run.circuitName(), pins)) as SyncProjectData;
  const opened = new Set(tracks.map(t => t.fileName));
  sync.videos = [...sync.videos.filter(v => opened.has(v.fileName)), ...run.kept.filter(v => !opened.has(v.fileName))];
  const videos = [...new Set([...opened, ...run.keptNames])];
  await updateRun(run.store, run.item.folder, run.item.file, { videos, sync }).catch(() => undefined);
}

function scheduleSave(): void {
  if (!current) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void saveCurrent(); }, 2000);
}

/** 走行を閉じた (ほかのログを開いた・消した): 覚えるのをやめる */
export function closeOpenRun(): void {
  if (timer) { clearTimeout(timer); timer = null; void saveCurrent(); }
  current = null;
  unsubscribe?.();
  unsubscribe = null;
}

/** 同期プロジェクトの形の同期を戻す (同期ピンも。動画はファイル名で今の動画に読み替える) */
export function restoreSync(sync: SyncProjectData, sessions: Session[], setClockOffset?: (id: string, sec: number) => void): void {
  const { data, clockOffsets } = videoSyncManager.importProjectJson(JSON.stringify(sync), sessions);
  for (const [id, sec] of clockOffsets) setClockOffset?.(id, sec);
  if (!data.pins?.length) return;
  const key = data.circuitName || 'default';
  const existing = videoViewStore.getPins(key);
  const all = videoSyncManager.getTracks();
  const restored = data.pins
    .filter(p => !existing.some(c => c.name === p.name && Math.abs(c.sessionTimeSec - p.sessionTimeSec) < 0.001))
    .map(p => ({
      ...createSyncPin(p.name, p.sessionTimeSec, p.videoTimeSec, all.find(t => t.fileName === p.trackFileName)?.id ?? ''),
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
      ...(p.createdAt ? { createdAt: p.createdAt } : {})
    }));
  if (restored.length) videoViewStore.setPins(key, [...existing, ...restored]);
}

/**
 * 走行の動画を開いて、同期を戻し、これからの変化を runs.json に書くようにする。
 * ログはもう読み込んであること (session)。videos は videoCandidates の local
 */
export async function attachRunVideos(opts: {
  store: RunStore;
  item: RunItem;
  /** 開いた走行のログ (走行が途中で長く止まって分かれたときは複数) */
  runSessions: Session[];
  videos: RemoteVideo[];
  fromRuns: boolean;
  sessions: () => Session[];
  circuitName: () => string;
  setClockOffset?: (id: string, sec: number) => void;
}): Promise<number> {
  closeOpenRun();
  const { store, item, videos } = opts;
  const ids = new Set(opts.runSessions.map(s => s.id));
  // 前に開いたほかの走行の動画 (保管場所のもの) は外す。GoPro の動画は、ほかのフォルダでも同じ名前のことがあり、
  // 残すと、戻す同期が名前でそちらに当たってしまうため。この走行の動画で、もう開いているものは残す
  const paths = new Set(videos.map(v => v.path));
  for (const t of videoSyncManager.getTracks()) if (t.remote && !paths.has(t.remote.path)) videoSyncManager.removeTrack(t.id);
  // 先に同期を戻す (動画はまだないので、名前だけの枠ができる。そこに動画をつなぐと、戻した同期のまま使える)
  if (opts.fromRuns && item.entry?.sync) {
    try { restoreSync(item.entry.sync, opts.sessions(), opts.setClockOffset); } catch { /* 壊れた同期は使わない */ }
  }
  // 同じ動画 (同じ道) がもう開いていれば足さない。名前と大きさだけでは見分けない (GoPro の名前は、ほかのフォルダの動画と同じことがある)
  const openPaths = new Set(videoSyncManager.getTracks().filter(t => t.remote).map(t => t.remote!.path));
  const add = videos.filter(v => !openPaths.has(v.path));
  const tracks = add.length ? await videoSyncManager.addVideoFiles(add, opts.sessions()) : [];
  // runs.json にない候補は、照合してこの走行に合ったものだけ残す (同じ日の別の走行の動画を外す)
  if (!opts.fromRuns) {
    for (const t of tracks) if (!t.matchedSessionId || !ids.has(t.matchedSessionId)) videoSyncManager.removeTrack(t.id);
  }
  // この走行の動画: 今回の候補の道で開いているもの (前に開いたほかの走行の動画は入れない)
  const names = new Set(videoSyncManager.getTracks()
    .filter(t => t.remote && paths.has(t.remote.path) && (opts.fromRuns || (t.matchedSessionId !== null && ids.has(t.matchedSessionId))))
    .map(t => t.remote!.path));
  const openedNames = new Set(videoSyncManager.getTracks().filter(t => t.remote && names.has(t.remote.path)).map(t => t.fileName));
  // 戻した同期の名前だけの枠で、動画が来なかったもの (iCloud にだけある・見つからない) は画面から外す。runs.json には残す
  const saved = item.entry?.sync?.videos ?? [];
  for (const t of videoSyncManager.getTracks()) if (!t.objectUrl && saved.some(v => v.fileName === t.fileName)) videoSyncManager.removeTrack(t.id);
  const keptNames = opts.fromRuns ? item.videos.filter(n => !openedNames.has(n)) : [];
  const kept = saved.filter(v => keptNames.includes(v.fileName));
  current = { store, item, sessionIds: ids, circuitName: opts.circuitName, sessions: opts.sessions, names, kept, keptNames };
  const offA = videoSyncManager.subscribe(scheduleSave);
  const offB = videoViewStore.subscribe(scheduleSave);
  unsubscribe = () => { offA(); offB(); };
  if (names.size && !opts.fromRuns) scheduleSave();
  return names.size;
}

/** 開いている走行に、同じフォルダの動画を足す (動画の画面から) */
export async function addVideoToOpenRun(video: RemoteVideo): Promise<boolean> {
  const run = current;
  if (!run) return false;
  // runs.json に同期を覚えていた動画 (開いたときは iCloud にだけあったもの) は、先にその同期を戻してからつなぐ
  const saved = run.kept.find(v => v.fileName === video.name);
  const sync = run.item.entry?.sync;
  if (saved && sync) {
    try {
      restoreSync({ ...sync, videos: [saved], pins: (sync.pins ?? []).filter(p => p.trackFileName === video.name) }, run.sessions());
    } catch { /* 壊れた同期は使わない */ }
  }
  await videoSyncManager.addVideoFiles([video], run.sessions());
  run.names.add(video.path);
  run.keptNames = run.keptNames.filter(n => n !== video.name);
  run.kept = run.kept.filter(v => v.fileName !== video.name);
  scheduleSave();
  return true;
}

/** 開いている走行 (動画の画面で、同じフォルダの動画を出すため) */
export function getOpenRun(): { store: RunStore; item: RunItem } | null {
  return current ? { store: current.store, item: current.item } : null;
}
