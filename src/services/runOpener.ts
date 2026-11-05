import { sessionStartUtcMs, type ClockSession } from './mediaClock';
/**
 * 過去の走行の一覧と、走行を開く (ログ・同じフォルダの動画・動画の同期をそろえて開く)。2026-10-20。
 * docs/session_storage_design.md の「作る順番」の 1〜3。
 *
 * - 一覧: 保管場所のサーキットのフォルダの .bon4 (laptimes.json の控えで周を数えたもの) を、新しい順に並べる
 * - 開く: ログを読み込み、runs.json に書いた動画 (なければ、同じフォルダの動画のうち撮影の時刻が近いもの) を範囲を読みながら開き、
 *   runs.json の同期 (同期プロジェクトの形) を戻す
 * - 覚える: 開いた走行の動画と同期は、変わるたびに runs.json に書く (少し待ってまとめて書く)
 */

import { isTempC, isWeather, type Weather } from './runWeather';
import { notifyRunsChanged } from './runsChanged';
import type { Session } from '../types/telemetry';
import { loadLapHistory, updateLapHidden } from './lapHistory';
import { LAP_INDEX_FILE, groupRunsByFolder, isRunVideoName, lapKey, parseLapIndex, runStem, type LapRecord } from './lapIndex';
import { findRunRow, isRunsConflictCopy, noteRunsConflictCopies, readRunsFile, runKey, updateRun, type RunRow, type RunVideo } from './runsFile';
import { UnpersistableSyncError, rowParts, rowVideoFromTrack, syncPinsFromRow, syncVideoFromRow } from './runSync';
import type { RunFileInfo, RunStore } from './runStore';
import { parseVideoMetadata } from './videoMetadataParser';
import { remoteFileLike, type RemoteVideo } from './remoteVideo';
import { videoSyncManager } from './videoSyncManager';
import { videoViewStore } from './videoViewStore';
import { createSyncPin, type SyncPin } from './videoSyncPinManager';
import { getStorageRevision, isStorageSelectionPending, StorageChangedError } from './storageRevision';
import { tr } from '../utils/i18n';

/** 一覧の 1 行 (1 つの走行) */
export interface RunItem {
  storageRevision?: number;
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
  /** 周の一覧 (走った順。hidden: 隠した周。一覧のベスト・周の数には数えない) */
  laps: Array<LapRecord & { hidden: boolean }>;
  /** 周をまだ数えていない (iCloud にだけあって、まだ落としていない)。コースの分からないフォルダ (unsorted) の走行は含めない */
  pending: boolean;
  /** runs.json の行 (無ければ null) */
  entry: RunRow | null;
}

/** 道の最後の名前 */
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
/** 道のフォルダ */
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** ファイルの名前の時刻 (YYYYMMDDhhmmss、端末の時刻) から走り始めを出す。数えていない走行を並べるため */
export function startFromName(file: string): number | null {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})[^/]*$/.exec(file);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 保管場所の全部の走行 (新しい順)。走行は <サーキットのフォルダ>/<日付>/ か <サーキットのフォルダ>/ に置く。動画は走行と同じフォルダのものだけ */
export async function listRuns(store: RunStore, onProgress?: (folder: string) => void, strict = false): Promise<RunItem[]> {
  const all = await store.listAll();
  // 周の控えを作るときも、今引いたファイルの一覧を使う (iCloud の置き場所では、一覧を引くのに時間がかかるので 2 回引かない)
  const listed: RunStore = { ...store, list: async () => all };
  const folders = await loadLapHistory(listed, onProgress);
  // フォルダごとの動画と .bon4 を先に 1 回だけ分けておく (走行ごとに全部のファイルを探すと、数千件で遅くなる)
  const videosByDir = new Map<string, RunFileInfo[]>();
  // 走行の基準のファイル (.nmea、無ければ .bon4。同じ名前の 2 つは 1 つの走行)
  const runsByFolder = groupRunsByFolder(all);
  const remoteOnly = new Set(all.filter(x => x.local === false).map(x => x.path));
  for (const x of all) {
    const dir = dirName(x.path);
    if (isRunVideoName(baseName(x.path))) {
      const list = videosByDir.get(dir);
      if (list) list.push(x); else videosByDir.set(dir, [x]);
    }
  }
  const out: RunItem[] = [];
  for (const f of folders) {
    // iCloud がぶつかったときに作った写し (runs 2.json など) も読む
    noteRunsConflictCopies(f.folder, all.filter(x => dirName(x.path) === f.folder && isRunsConflictCopy(baseName(x.path))).map(x => x.path));
    const runs = await readRunsFile(store, f.folder, strict);
    const hidden = new Set((f.index?.hidden ?? []).map(h => lapKey(h.file, h.part, h.n)));
    // 控えにある走行と、フォルダにある走行 (同じ走行は 1 つに。控えの古い .bon4 の名前より、今の基準のファイルを使う)
    const byStem = new Map<string, string>();
    for (const k of Object.keys(f.index?.files ?? {})) byStem.set(`${dirName(k)}|${runStem(k)}`, k);
    for (const x of runsByFolder.get(f.folder) ?? []) {
      const rel = x.path.slice(f.folder.length + 1);
      byStem.set(`${dirName(rel)}|${runStem(rel)}`, rel);
    }
    const names = new Set(byStem.values());
    for (const file of names) {
      if (!/^(\d{8}\/)?[^/]+$/.test(file)) continue;
      const runDir = dirName(`${f.folder}/${file}`);
      // 走行と同じフォルダの動画。日付のフォルダの走行には、サーキットのフォルダにじかに置いた動画 (前の置き方) も候補にする
      // 同じ名前の動画がサーキットのフォルダにもあるときは、走行と同じフォルダのものを使う (名前で引くので、後ろが勝つ)
      const folderVideos = runDir === f.folder
        ? [...(videosByDir.get(runDir) ?? [])]
        : [...(videosByDir.get(f.folder) ?? []), ...(videosByDir.get(runDir) ?? [])];
      const rec = f.index?.files[file];
      const allLaps = (rec?.laps ?? []).map(l => ({ ...l, hidden: hidden.has(lapKey(file, l.part, l.n)) }));
      const laps = allLaps.filter(l => !l.hidden);
      // 行の名前は「日付のフォルダ/拡張子なしの名前」(.nmea と .bon4 は 1 行)。日付のフォルダへ移す前の、名前だけの行も引く
      const entry = findRunRow(runs, file);
      const videos = entry?.videos?.map(v => v.name) ?? rec?.videos ?? [];
      out.push({
        storageRevision: store.storageRevision,
        folder: f.folder,
        file,
        courseName: f.courseName,
        startMs: rec?.startMs ?? startFromName(file),
        lapCount: laps.length,
        laps: allLaps,
        best: laps.length ? Math.min(...laps.map(l => l.time)) : null,
        videos,
        synced: !!entry?.videos?.some(v => !!v.clock),
        folderVideos,
        pending: !rec && remoteOnly.has(`${f.folder}/${file}`),
        entry
      });
    }
  }
  return out.sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0) || b.file.localeCompare(a.file));
}

export const totalBytes = (files: RunFileInfo[]) => files.reduce((s, f) => s + f.size, 0);

/** 走行の動画にする候補: runs.json に書いたもの。なければ、同じフォルダの端末にある動画のうち、撮影の時刻が走り始めの ±14 時間のもの
 * (時差の分を広めに取る。最後は動画の GPS・撮影時刻での照合で、この走行に合わなかったものを外す) */
export async function videoCandidates(store: RunStore, item: RunItem, isCurrent = () => true): Promise<{ local: RemoteVideo[]; missing: RunFileInfo[]; fromRuns: boolean }> {
  const byName = new Map(item.folderVideos.map(v => [baseName(v.path), v]));
  // 古いアプリ (lapfile:// を読めない) では、動画は開かない
  const empty = { local: [], missing: [], fromRuns: !!item.videos.length };
  if (!isCurrent() || !(await store.supportsVideos()) || !isCurrent()) return empty;
  const toRemote = (v: RunFileInfo): RemoteVideo => ({ name: baseName(v.path), size: v.size, url: store.videoUrl(v.path), path: v.path, lastModified: v.mtimeMs, readRange: store.rangeReader?.(v.path) });
  if (item.videos.length) {
    const listed = item.videos.map(n => byName.get(n)).filter((v): v is RunFileInfo => !!v);
    return { local: listed.filter(v => v.local).map(toRemote), missing: listed.filter(v => !v.local), fromRuns: true };
  }
  if (item.startMs === null) return { local: [], missing: [], fromRuns: false };
  const local: RemoteVideo[] = [];
  for (const v of item.folderVideos.filter(x => x.local && !/\.lrv$/i.test(x.path))) {
    if (!isCurrent()) return empty;
    const remote = toRemote(v);
    try {
      const meta = await parseVideoMetadata(remoteFileLike(remote));
      if (!isCurrent()) return empty;
      const t = meta.creationTime?.getTime();
      if (t !== undefined && Math.abs(t - item.startMs) <= 14 * 3600_000) local.push(remote);
    } catch {
      // 読めない動画は候補にしない
    }
  }
  // iCloud にだけある動画は中を読めないので、ファイルの日時 (GoPro から写した動画は撮影の終わりの時刻のことが多い) で候補にし、取り込むか聞く
  const missing = item.folderVideos.filter(x => !x.local && !/\.lrv$/i.test(x.path) && Math.abs(x.mtimeMs - item.startMs!) <= 14 * 3600_000);
  return isCurrent() ? { local, missing, fromRuns: false } : empty;
}

/**
 * 開いている走行 (Car 1 の走行と、比べる相手 Car 2〜4 の走行)。その走行の動画と同期を、その走行の runs.json の行に書く
 */
interface OpenRun {
  store: RunStore;
  item: RunItem;
  /** 最後に覚えるよう頼んだメーターの並び (書き終わる前に続けて選んでも、最後の選びで書くため) */
  requestedLayout?: string;
  /** その走行のログ (読み込んだ順。何番目 = 分かれた走行の番号) */
  sessionIds: string[];
  /** 元の part 番号と時計だけを保持。閉じた点列は持たない。 */
  partClocks: Map<number, ClockSession>;
  /** 先行する通常保存も含めて、同じ担当の保存を順番に完了させる。 */
  saving: Promise<void>;
  mediaAttached: boolean;
  circuitName: () => string;
  sessions: () => Session[];
  /** その走行の動画 (保管場所の道) */
  paths: Set<string>;
  /** runs.json にあるが、今回は開かなかった動画 (iCloud にだけある・見つからない)。消さずに残す */
  kept: RunVideo[];
  /**
   * 開いたときに、この走行の動画として知っていた名前 (runs.json にあったもの・開いた動画)。
   * 書くとき、これに無い動画が runs.json にあれば、開いている間にほかの端末が足したものなので残す (知っていて外したものは書かない)
   */
  known: Set<string>;
  /** 前に書いた (か、開いたときの) 中身。同じなら書かない (開いて画面を触っただけで書かない) */
  baseline: string | null;
  /**
   * runs.json から戻したログの時計の補正 (ログの ID → 秒)。ログ (画面の状態) に入るのは少しあとなので、
   * 入るまではこの値を使って中身を作る (入る前の値で作ると、入ったときに「変わった」とみなして書いてしまう・動画の時刻を誤る)
   */
  pendingOffsets: Map<string, { sec: number; until: number }>;
}

/** Car 1 の走行 (動画の画面で同じフォルダの動画を足す先) */
let current: OpenRun | null = null;
/** 比べる相手 (Car 2〜4) の走行 (走行の道 → 走行)。走行比較で、その車の枠にその車の動画を出す */
const companions = new Map<string, OpenRun>();
let timer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;
let editSequence = 0;

const runPath = (item: RunItem) => `${item.folder}/${item.file}`;
const durableKey = (item: RunItem) => `${item.folder}/${runKey(item.file)}`;

function rejectAlias(store: RunStore, item: RunItem): void {
  assertRunItemCurrent(item);
  for (const run of [...(current ? [current] : []), ...companions.values()]) {
    if (run.store.storageRevision === store.storageRevision && durableKey(run.item) === durableKey(item) && run.item.file !== item.file) {
      throw new Error(tr('同じ走行の別形式が開いています。先に閉じてください。', 'Another format of this run is open. Close it first.'));
    }
  }
}

export function assertRunItemCurrent(item: RunItem): void {
  if (isStorageSelectionPending() || item.storageRevision !== undefined && item.storageRevision !== getStorageRevision()) throw new StorageChangedError();
}

function assertVideoOwnership(opts: AttachOptions): void {
  const wanted = new Set(opts.videos.map(v => v.path));
  for (const run of [...(current ? [current] : []), ...companions.values()]) {
    if (run.store.storageRevision === opts.store.storageRevision && runPath(run.item) === runPath(opts.item)) continue;
    if ([...run.paths].some(path => wanted.has(path))) throw new Error(tr('この動画は別の開いている走行が使用中です。先にその走行の動画を閉じてください。', 'This video belongs to another open run. Close that run’s video first.'));
  }
}

/** 動画を待つ前に、ログの補正を復元し保存担当を用意する。採用直前、待機なしで呼ぶ。 */
export function registerRunSessions(store: RunStore, item: RunItem, incoming: Session[], sessions: () => Session[]): Session[] {
  rejectAlias(store, item);
  const prior = current && runPath(current.item) === runPath(item) ? current : companions.get(runPath(item));
  const liveIds = new Set(sessions().map(s => s.id));
  const restored = incoming.map((s, i) => {
    const sec = item.entry?.parts?.[String(s.sourceFile?.part ?? i + 1)]?.clockOffsetSec;
    return liveIds.has(s.id) || typeof sec !== 'number' || !Number.isFinite(sec) || Math.abs(sec) > 3600 ? s : { ...s, clockOffsetSec: sec };
  });
  if (prior) {
    const next = partClocksOf(restored, prior), remap = new Map<string, string>();
    for (const [part, s] of next) {
      const old = prior.partClocks.get(part);
      if (old && old.id !== s.id) remap.set(old.id, s.id);
    }
    videoViewStore.remapPinSessions(remap);
    videoSyncManager.remapLiveSessionIds(remap);
    prior.partClocks = next;prior.sessionIds = restored.map(s => s.id);prior.sessions = sessions;
    return restored;
  }
  const key = restored[0]?.circuitName ?? '';
  const run: OpenRun = { store, item, sessionIds: restored.map(s => s.id), partClocks: partClocksOf(restored), saving: Promise.resolve(), mediaAttached: false,
    circuitName: () => key, sessions, paths: new Set(), kept: item.entry?.videos ?? [], known: new Set(item.entry?.videos?.map(v => v.name) ?? []), baseline: null, pendingOffsets: new Map() };
  const content = rowContent(run, item.entry, { all: restored, parts: run.partClocks, tracks: [], pins: [] });
  run.baseline = content ? contentKey(content) : null;
  companions.set(runPath(item), run);ensureSubscribed();
  return restored;
}
/** その走行が見るログ (戻した時計の補正がまだ入っていなければ、入れたもの) */
const sessionsOf = (run: OpenRun): Session[] => {
  const all = run.sessions();
  if (run.pendingOffsets.size === 0) return all;
  const now = Date.now();
  return all.map(s => {
    const p = run.pendingOffsets.get(s.id);
    if (!p) return s;
    // 入った・時間が経った (利用者が直したかもしれない) ら、もう使わない
    if ((s.clockOffsetSec ?? 0) === p.sec || now > p.until) { run.pendingOffsets.delete(s.id); return s; }
    return { ...s, clockOffsetSec: p.sec };
  });
};
const clockCopy = (s: ClockSession): ClockSession => ({ id: s.id, clockOffsetSec: s.clockOffsetSec, points: s.points.length ? [{ timestamp: s.points[0].timestamp }] : [] });
function partClocksOf(sessions: Session[], prior?: OpenRun): Map<number, ClockSession> {
  const parts = prior && sessions.some(s => prior.sessionIds.includes(s.id)) ? new Map(prior.partClocks) : new Map<number, ClockSession>();
  sessions.forEach((s, i) => parts.set(s.sourceFile?.part ?? i + 1, clockCopy(s)));
  return parts;
}
const runSessionsOf = (run: OpenRun, all: Session[] = sessionsOf(run)): Array<Session | undefined> =>
  Array.from({ length: Math.max(0, ...run.partClocks.keys()) }, (_, i) => all.find(s => s.id === run.partClocks.get(i + 1)?.id));

function clockPartsOf(parts: Map<number, ClockSession>, all: readonly ClockSession[], saved?: RunRow['parts']): Array<ClockSession | undefined> {
  return Array.from({ length: Math.max(0, ...parts.keys()) }, (_, i) => {
    const prior = parts.get(i + 1);
    return prior ? all.find(s => s.id === prior.id) ?? { ...prior, clockOffsetSec: saved?.[String(i + 1)]?.clockOffsetSec ?? prior.clockOffsetSec } : undefined;
  });
}

/** その走行の今の動画・ピン・ログ (書く前に取っておく。書くのを待つ間に動画が外されても、外す前の中身で書くため) */
interface RunSnapshot {
  all: ClockSession[];
  parts: Map<number, ClockSession>;
  tracks: ReturnType<typeof videoSyncManager.getTracks>;
  pins: SyncPin[];
}
function snapshotOf(run: OpenRun): RunSnapshot {
  const all = sessionsOf(run);
  videoViewStore.getPins(run.circuitName() || 'default');
  videoViewStore.anchorPins(all);
  for (const [part, prior] of run.partClocks) {
    const live = all.find(s => s.id === prior.id);
    if (live) run.partClocks.set(part, clockCopy(live));
  }
  return {
    all: all.map(clockCopy), parts: new Map(run.partClocks),
    tracks: videoSyncManager.getTracks().filter(t => t.remote && run.paths.has(t.remote.path)).map(t => ({ ...t, clock: { ...t.clock } })),
    pins: videoViewStore.getAllPins().slice()
  };
}

/** その走行の、行の中身 (動画・時計の補正)。ログが 1 つも無い (閉じた) ときは null */
function rowContent(run: OpenRun, prev: RunRow | null, snap: RunSnapshot = snapshotOf(run)): Pick<RunRow, 'parts' | 'videos'> | null {
  const { all, tracks, pins, parts } = snap;
  const liveParts = Array.from({ length: Math.max(0, ...parts.keys()) }, (_, i) => all.find(s => s.id === parts.get(i + 1)?.id));
  if (!liveParts.some(Boolean)) return null;
  // 欠けた part は時計換算だけに使い、保存する補正は存命 part だけ。閉じた part の最新行を上書きしない。
  const runSessions = clockPartsOf(parts, all, prev?.parts);
  const clocks = [...all, ...runSessions.filter((s): s is ClockSession => !!s && !all.some(l => l.id === s.id))];
  const opened = new Set(tracks.map(t => t.fileName));
  const videos = [
    ...tracks.map(t => rowVideoFromTrack(t, pins.filter(p => p.trackId === t.id), runSessions, clocks, prev?.videos?.find(v => v.name === t.fileName))),
    ...run.kept.filter(v => !opened.has(v.name)),
    // 開いている間にほかの端末が足した動画 (書く直前の行にあって、開いたときには知らなかったもの)
    ...(prev?.videos ?? []).filter(v => !opened.has(v.name) && !run.known.has(v.name) && !run.kept.some(k => k.name === v.name))
  ];
  return { parts: rowParts(liveParts, prev?.parts), videos };
}

const contentKey = (c: Pick<RunRow, 'parts' | 'videos'>) => JSON.stringify(c);

/** 走行の動画と同期を runs.json に書く (中身が変わったときだけ) */
function saveRun(run: OpenRun, strict = false): Promise<void> {
  // トラックやログを外す前の状態を確保する。同値判定は先行保存の完了後に行う。
  const snap = snapshotOf(run);
  const metadata = new Map(pendingMetadata.get(metadataKeyOf(run.store, run.item)) ?? []);
  const next = run.saving.then(() => saveRunSnapshot(run, snap, metadata, strict));
  run.saving = next.catch(() => undefined);
  return next;
}
async function saveRunSnapshot(run: OpenRun, snap: RunSnapshot, metadata: Map<keyof RunMetaPatch, { version: number; value: unknown }>, strict: boolean): Promise<void> {
  try {
    const content = rowContent(run, run.item.entry, snap);
    const metadataKey = metadataKeyOf(run.store, run.item);
    if (!content && metadata.size === 0) return;
    const key = content ? contentKey(content) : null;
    if (content && key === run.baseline && metadata.size === 0) return;
    let writtenMetadata = new Map<keyof RunMetaPatch, { version: number; value: unknown }>();
    const row = await updateRun(run.store, run.item.folder, run.item.file, prev => {
      // 書く直前の行で作り直す (ほかの端末が足した項目を残す)。動画・ピンは取っておいたもの
      const fresh = content ? rowContent(run, prev ?? null, snap) ?? content : null;
      // 先に別の保存が完了した項目や、その後に編集した項目へ古い値を書かない。
      writtenMetadata = new Map([...metadata].filter(([k, v]) => pendingMetadata.get(metadataKey)?.get(k)?.version === v.version));
      return patchMetadata({ ...prev, ...(fresh ?? {}) }, Object.fromEntries([...writtenMetadata].map(([k, v]) => [k, v.value])) as RunMetaPatch);
    });
    if (content) run.baseline = key;
    const pending = pendingMetadata.get(metadataKey);
    if (pending) {
      for (const [k, v] of writtenMetadata) if (pending.get(k)?.version === v.version) pending.delete(k);
      if (!pending.size) pendingMetadata.delete(metadataKey);
    }
    run.item.entry = withPendingMetadata(run.store, run.item, row);
    // 次にこの走行を開き直すとき (Car 1 を替えて戻ったときなど) の動画の候補も、書いた中身にする (外した動画が戻らないように)
    const synced = !!row.videos?.some(v => !!v.clock);
    const videosChanged = synced !== run.item.synced || (row.videos?.length ?? 0) !== run.item.videos.length;
    run.item.videos = row.videos?.map(v => v.name) ?? [];
    run.item.synced = synced;
    // 動画を外した・同期した: 走行の一覧の「同期済み」などをすぐ直す (BUG-39 の 4)
    if (videosChanged) notifyRunsChanged();
  } catch (error) {
    if (strict) throw error;
    // 書けない (読めない形の runs.json など) ときは、次に変わったときにもう一度試す
  }
}

function saveAll(strict = false): Promise<unknown> {
  const runs = [...(current ? [current] : []), ...companions.values()];
  return Promise.all(runs.map(run => saveRun(run, strict)));
}

function scheduleSave(): void {
  editSequence++;
  if (!current && companions.size === 0) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void saveAll(); }, 2000);
}

/** 動画・ピンが変わったら書く (変わっていなければ書かない) */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  videoSyncManager.subscribe(scheduleSave);
  videoViewStore.subscribe(scheduleSave);
}

/** ログの時計の補正を変えたときなど、動画・ピンのほかに走行の中身が変わったとき (App から) */
export function scheduleRunSave(): void {
  scheduleSave();
}

/**
 * その動画 (道) が、比べる相手の走行の動画なら、その走行のログの ID。Car 1 の走行の動画・どの走行のものでもなければ null
 * (動画が出すログが決まっていないときも、比べる相手の動画を Car 1 の道具で合わせないように)
 */
export function companionSessionsOfVideo(path: string): string[] | null {
  if (current?.paths.has(path)) return null;
  for (const run of companions.values()) if (run.paths.has(path)) return run.sessionIds;
  return null;
}

/**
 * 書きかけをすぐ書く (ログを「走行とコース」から外す前に。外したあとでは、その走行のログが見つからず書けないため)。
 * 中身は呼んだときに取っておくので、書くのを待つ間にログを外してよい
 */
/** 保存先や開いたログを手放す前に、失敗を呼出し側へ返して保存する。 */
export async function flushOpenRunsStrict(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  try {
    let version: number;
    do {
      version = editSequence;
      await saveAll(true);
    } while (version !== editSequence);
    if (timer) { clearTimeout(timer); timer = null; }
  }
  catch (error) { scheduleSave(); throw error; }
}

export function flushOpenRuns(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  void saveAll();
}

/** 走行を閉じた (ほかのログを開いた・消した): 書きかけを書いて、Car 1 の走行として覚えるのをやめる */
export function closeOpenRun(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  // 中身が変わっていなければ書かない (saveRun が開いたときの中身と比べる)
  void saveAll();
  if (current && current.sessionIds.some(id => current!.sessions().some(s => s.id === id))) {
    const run = current;
    run.kept = rowContent(run, run.item.entry)?.videos ?? run.item.entry?.videos ?? [];
    run.paths = new Set();run.mediaAttached = false;
    companions.set(runPath(run.item), run);
  }
  current = null;
}

/**
 * 行の動画の同期とピンを、開いた動画 (道で見分ける) に戻す。同じ名前の動画がほかの走行にあっても、ほかの動画には当てない
 */
function restoreRowVideos(run: OpenRun, row: RunRow | null, setClockOffset?: (id: string, sec: number) => void, onlyTracks?: Set<string>): void {
  if (!row) return;
  // ログの時計の補正 (何番目ごと)。ログに入るまでは pendingOffsets の値を使う
  const before = runSessionsOf(run);
  for (const [n, p] of Object.entries(onlyTracks ? {} : row.parts ?? {})) {
    const s = before[Number(n) - 1];
    if (s && typeof p.clockOffsetSec === 'number' && Number.isFinite(p.clockOffsetSec) && Math.abs(p.clockOffsetSec) <= 3600 && (s.clockOffsetSec ?? 0) !== p.clockOffsetSec) {
      run.pendingOffsets.set(s.id, { sec: p.clockOffsetSec, until: Date.now() + 5000 });
      setClockOffset?.(s.id, p.clockOffsetSec);
    }
  }
  const all = sessionsOf(run);
  const runSessions = clockPartsOf(run.partClocks, all, row.parts);
  const key = run.circuitName() || 'default';
  let pins = videoViewStore.getPins(key);
  let pinsChanged = false;
  const trackIds = new Set(videoSyncManager.getTracks().map(t => t.id));
  const restore: Array<{ trackId: string; vData: NonNullable<ReturnType<typeof syncVideoFromRow>> }> = [];
  for (const t of videoSyncManager.getTracks()) {
    if (!t.remote || !run.paths.has(t.remote.path) || (onlyTracks && !onlyTracks.has(t.id))) continue;
    const v = row.videos?.find(x => x.name === t.fileName);
    if (!v) continue;
    const vData = syncVideoFromRow(v, runSessions);
    if (vData) restore.push({ trackId: t.id, vData });
    for (const p of syncPinsFromRow(v, t.id, runSessions)) {
      // 前に開いたときのピン (動画の ID は開くたびに変わる) は、今の動画に付け直す (重ねて足さない)
      const same = (c: SyncPin) => c.name === p.name && Math.abs(c.sessionTimeSec - p.sessionTimeSec) < 0.001 && Math.abs(c.videoTimeSec - p.videoTimeSec) < 0.001;
      const mine = pins.find(c => same(c) && c.trackId === t.id);
      if (mine) {
        if (mine.sessionId !== p.sessionId) {
          pins = pins.map(c => c === mine ? { ...c, sessionId: p.sessionId } : c);
          pinsChanged = true;
        }
        continue;
      }
      const stale = pins.find(c => same(c) && !trackIds.has(c.trackId));
      if (stale) {
        pins = pins.map(c => (c === stale ? { ...c, trackId: t.id, ...(p.sessionId ? { sessionId: p.sessionId } : {}) } : c));
      } else {
        pins = [...pins, { ...createSyncPin(p.name, p.sessionTimeSec, p.videoTimeSec, t.id), ...(p.sessionId ? { sessionId: p.sessionId } : {}), ...(p.createdAt ? { createdAt: p.createdAt } : {}) }];
      }
      pinsChanged = true;
    }
  }
  // チャプターに分かれた動画は、全部を戻してから時刻をそろえる
  if (restore.length) videoSyncManager.restoreTracksSync(restore, all);
  if (pinsChanged) videoViewStore.setPins(key, pins);
}

/** 動画を付ける処理は 1 つずつ行う (続けて走行を開いたとき・相手の走行の動画を読んでいる間に、同じ動画を 2 回足さないように) */
let attachQueue: Promise<unknown> = Promise.resolve();
let attachmentGeneration = 0;

/** 保管場所を替えたとき、以前の走行の予約と動画を手放す。以前の場所への保存は始めない。 */
export function abandonOpenRuns(): void {
  attachmentGeneration++;
  attachQueue = Promise.resolve();
  if (timer) { clearTimeout(timer); timer = null; }
  current = null;
  companions.clear();
  for (const track of videoSyncManager.getTracks()) if (track.remote) videoSyncManager.removeTrack(track.id);
  for (const f of openRunListeners) f();
}

function queued<T>(fn: () => Promise<T>): Promise<T> {
  const next = attachQueue.then(fn, fn);
  attachQueue = next.catch(() => undefined);
  return next;
}

/**
 * 走行の動画を開いて、同期を戻し、これからの変化を runs.json に書くようにする。
 * ログはもう読み込んであること (session)。videos は videoCandidates の local
 */
interface AttachOptions {
  store: RunStore;
  item: RunItem;
  /** 開いた走行のログ (走行が途中で長く止まって分かれたときは複数。読み込んだ順) */
  runSessions: Session[];
  videos: RemoteVideo[];
  fromRuns: boolean;
  sessions: () => Session[];
  circuitName: string | (() => string);
  setClockOffset?: (id: string, sec: number) => void;
  isCurrent?: () => boolean;
  /** 別の基準走行を開く際、まだ比較に使う旧走行の保存担当を引き継ぐ。 */
  keepPrevious?: (sessionIds: readonly string[]) => boolean;
}

function queueAttachment(opts: AttachOptions, attach: (opts: AttachOptions, isCurrent: () => boolean) => Promise<number>) {
  const generation = attachmentGeneration;
  const isCurrent = () => generation === attachmentGeneration && (opts.isCurrent?.() ?? true);
  return queued(() => isCurrent() ? attach(opts, isCurrent) : Promise.resolve(0));
}

export function attachRunVideos(opts: AttachOptions): Promise<number> {
  return queueAttachment(opts, attachRunVideosNow);
}

async function attachRunVideosNow(opts: AttachOptions, isCurrent: () => boolean): Promise<number> {
  const { store, item, videos } = opts;
  rejectAlias(store, item);
  assertVideoOwnership(opts);
  const circuitName = typeof opts.circuitName === 'function' ? opts.circuitName() : opts.circuitName;
  const ids = new Set(opts.runSessions.map(s => s.id));
  const owned = current && runPath(current.item) === runPath(item) ? current : companions.get(runPath(item));
  const retained = owned && owned.store.storageRevision === store.storageRevision && owned.sessionIds.length === opts.runSessions.length
    && owned.sessionIds.every((id, i) => id === opts.runSessions[i].id) ? owned : undefined;
  if (retained && !retained.mediaAttached) { await saveRun(retained, true); if (!isCurrent()) return 0; }
  const paths = new Set([...videos.map(v => v.path), ...(retained?.paths ?? [])]);
  const openPaths = new Set(videoSyncManager.getTracks().filter(t => t.remote).map(t => t.remote!.path));
  const oldTrackIds = new Set(videoSyncManager.getTracks().map(t => t.id));
  const add = videos.filter(v => !openPaths.has(v.path));
  const switchRun = () => {
    if (current && current !== retained && opts.keepPrevious?.(current.sessionIds)) {
      companions.set(runPath(current.item), current);
      current = null;
    } else if (current !== retained) closeOpenRun();
    ensureSubscribed();
    // 引き継ぐ担当は、動画の準備が完了するまで比較側にも保持しておく。
    if (!retained) companions.delete(runPath(item));
    const keep = companionPaths();
    for (const t of videoSyncManager.getTracks()) if (t.remote && !paths.has(t.remote.path) && !keep.has(t.remote.path)) videoSyncManager.removeTrack(t.id);
  };
  if (add.length) await videoSyncManager.addVideoFiles(add, opts.sessions(), true, isCurrent, switchRun);
  else switchRun();
  if (!isCurrent()) return 0;
  // runs.json にない候補は、照合してこの走行に合ったものだけ残す (同じ日の別の走行の動画を外す)。
  // 見るのは今回足した動画だけ (addVideoFiles は開いている動画を全部返す。比べる相手の動画まで外すと、その走行の行から動画が消えるため)
  if (!opts.fromRuns && add.length) {
    const addPaths = new Set(add.map(v => v.path));
    for (const t of videoSyncManager.getTracks()) {
      if (t.remote && addPaths.has(t.remote.path) && (!t.matchedSessionId || !ids.has(t.matchedSessionId))) videoSyncManager.removeTrack(t.id);
    }
  }
  // この走行の動画: 今回の候補の道で開いているもの
  const mine = new Set(videoSyncManager.getTracks()
    .filter(t => t.remote && paths.has(t.remote.path) && (retained?.paths.has(t.remote.path) || opts.fromRuns || (t.matchedSessionId !== null && ids.has(t.matchedSessionId))))
    .map(t => t.remote!.path));
  const openedNames = new Set(videoSyncManager.getTracks().filter(t => t.remote && mine.has(t.remote.path)).map(t => t.fileName));
  const row = retained?.item.entry ?? item.entry;
  const run: OpenRun = retained ?? {
    store, item, sessionIds: opts.runSessions.map(s => s.id), partClocks: partClocksOf(opts.runSessions, owned ?? undefined), saving: Promise.resolve(), mediaAttached: true, circuitName: () => circuitName, sessions: opts.sessions, paths: mine,
    // runs.json にあって今回は開かなかった動画 (iCloud にだけある・見つからない) は、消さずに残す
    kept: opts.fromRuns ? (row?.videos ?? []).filter(v => !openedNames.has(v.name)) : [],
    known: new Set([...(row?.videos ?? []).map(v => v.name), ...openedNames]),
    baseline: null,
    pendingOffsets: new Map()
  };
  if (retained) {
    const saved = { entry: run.item.entry, videos: run.item.videos, synced: run.item.synced };
    Object.assign(run.item, item, saved);
    run.store = store; run.sessions = opts.sessions; run.circuitName = () => circuitName; run.paths = mine;
    run.kept = [...run.kept, ...(row?.videos ?? []).filter(v => !run.known.has(v.name) && !run.kept.some(k => k.name === v.name))].filter(v => !openedNames.has(v.name));
    for (const name of openedNames) run.known.add(name);
    // 既存トラックとログの未保存調整は戻さず、今回初めて開けた動画だけ復元する。
    if (opts.fromRuns) restoreRowVideos(run, row, undefined, new Set(videoSyncManager.getTracks().filter(t => !oldTrackIds.has(t.id)).map(t => t.id)));
  } else restoreRowVideos(run, row, opts.setClockOffset);
  run.mediaAttached = true;
  companions.delete(runPath(item));
  current = run;
  for (const f of openRunListeners) f();
  // runs.json から開いたときは、今の中身を「書いたもの」とする (開いただけでは書かない)。
  // runs.json に無い動画を付けたときは書く (付けたことを覚える)
  const content = rowContent(run, row);
  if (!retained) run.baseline = opts.fromRuns || mine.size === 0 ? (content ? contentKey(content) : null) : null;
  if (retained || run.baseline === null) scheduleSave();
  return mine.size;
}

/** 比べる相手の走行の動画の道 (全部) */
export function companionPaths(): Set<string> {
  const out = new Set<string>();
  for (const r of companions.values()) for (const p of r.paths) out.add(p);
  return out;
}

/** 動画を読んである、比べる相手の走行 */
export function companionRuns(): string[] {
  return [...companions].filter(([, run]) => run.mediaAttached).map(([path]) => path);
}

export function companionRunMatches(path: string, sessionIds: readonly string[]): boolean {
  const run = companions.get(path);
  return !!run && run.mediaAttached && run.sessionIds.length === sessionIds.length && run.sessionIds.every((id, i) => id === sessionIds[i]);
}

/** 道だけでなく、保存する分割ログの組も今の走行と一致するか。 */
export function currentRunMatches(path: string, sessionIds: readonly string[]): boolean {
  return !!current && current.mediaAttached && runPath(current.item) === path && current.sessionIds.length === sessionIds.length
    && current.sessionIds.every((id, i) => id === sessionIds[i]);
}

/** ログを全部手放した保存担当の動画を、次の動画の準備待ち中に編集させない。 */
export function releaseClosedRunVideos(liveIds: ReadonlySet<string>): void {
  if (current && !current.sessionIds.some(id => liveIds.has(id))) {
    const paths = current.paths;
    closeOpenRun();
    const keep = companionPaths();
    for (const track of videoSyncManager.getTracks()) {
      if (track.remote && paths.has(track.remote.path) && !keep.has(track.remote.path)) videoSyncManager.removeTrack(track.id);
    }
  }
  for (const [path, run] of companions) if (!run.sessionIds.some(id => liveIds.has(id))) dropCompanion(path);
}

/**
 * 比べる相手の走行の動画を足す (Car 2〜4 に、開いている走行のほかの走行の周を入れたとき)。端末にある動画だけ。
 * 同期はその走行の runs.json の行から戻し、変えたらその行に書く
 */
export function attachCompanionVideos(opts: AttachOptions): Promise<number> {
  return queueAttachment(opts, attachCompanionVideosNow);
}

async function attachCompanionVideosNow(opts: AttachOptions, isCurrent: () => boolean): Promise<number> {
  rejectAlias(opts.store, opts.item);
  assertVideoOwnership(opts);
  const circuitName = typeof opts.circuitName === 'function' ? opts.circuitName() : opts.circuitName;
  // 基準のないログへ切り替わった場合も、同じ走行の保存者を二重に作らない。
  const path = runPath(opts.item);
  const idsNow = opts.runSessions.map(s => s.id);
  if (current && runPath(current.item) === path) {
    if (current.sessionIds.length === idsNow.length && current.sessionIds.every((id, i) => id === idsNow[i])) return current.paths.size;
    closeOpenRun();
  }
  if (companionRunMatches(path, idsNow)) return companions.get(path)!.paths.size;
  let retained = companions.get(path);
  if (retained && !retained.mediaAttached) { await saveRun(retained, true); if (!isCurrent()) return 0; }
  if (retained && (retained.sessionIds.length !== idsNow.length || !retained.sessionIds.every((id, i) => id === idsNow[i]))) {
    await saveRun(retained, true);
    if (!isCurrent()) return 0;
    companions.delete(path);
    for (const t of videoSyncManager.getTracks()) if (t.remote && retained.paths.has(t.remote.path) && !current?.paths.has(t.remote.path)) videoSyncManager.removeTrack(t.id);
    retained = undefined;
  }
  ensureSubscribed();
  const { item, videos } = opts;
  const ids = new Set(opts.runSessions.map(s => s.id));
  const openPaths = new Set(videoSyncManager.getTracks().filter(t => t.remote).map(t => t.remote!.path));
  const add = videos.filter(v => !openPaths.has(v.path));
  // もう開いている動画 (Car 1 の動画など) は、runs.json にこの走行の動画として書いてあるか、照合でこの走行に合ったものだけ
  // (同じ日の別の走行の動画を、比べる相手の走行の動画として書かないように)
  const mine = new Set(videos.filter(v => {
    if (!openPaths.has(v.path)) return false;
    if (opts.fromRuns) return true;
    const t = videoSyncManager.getTracks().find(x => x.remote?.path === v.path);
    return !!t?.matchedSessionId && ids.has(t.matchedSessionId);
  }).map(v => v.path));
  if (add.length) {
    await videoSyncManager.addVideoFiles(add, opts.sessions(), true, isCurrent);
    if (!isCurrent()) return 0;
    const addPaths = new Set(add.map(v => v.path));
    for (const t of videoSyncManager.getTracks()) {
      if (!t.remote || !addPaths.has(t.remote.path)) continue;
      // runs.json にない候補は、照合してこの走行に合ったものだけ残す
      if (!opts.fromRuns && (!t.matchedSessionId || !ids.has(t.matchedSessionId))) { videoSyncManager.removeTrack(t.id); continue; }
      mine.add(t.remote.path);
    }
  }
  const openedNames = new Set(videoSyncManager.getTracks().filter(t => t.remote && mine.has(t.remote.path)).map(t => t.fileName));
  const row = item.entry;
  const run: OpenRun = retained ?? {
    store: opts.store, item, sessionIds: opts.runSessions.map(s => s.id), partClocks: partClocksOf(opts.runSessions), saving: Promise.resolve(), mediaAttached: true, circuitName: () => circuitName, sessions: opts.sessions, paths: mine,
    kept: opts.fromRuns ? (row?.videos ?? []).filter(v => !openedNames.has(v.name)) : [],
    known: new Set([...(row?.videos ?? []).map(v => v.name), ...openedNames]),
    baseline: null,
    pendingOffsets: new Map()
  };
  if (retained) {
    run.paths = mine;run.kept = run.kept.filter(v => !openedNames.has(v.name));
    restoreRowVideos(run, row, undefined, new Set(videoSyncManager.getTracks().filter(t => t.remote && mine.has(t.remote.path)).map(t => t.id)));
  } else restoreRowVideos(run, row, opts.setClockOffset);
  run.mediaAttached = true;
  const content = rowContent(run, row);
  // 比べる相手の走行は、runs.json に無い動画を付けても書かない (Car 1 として開いたときに書く)。変えたら書く
  if (!retained) run.baseline = content ? contentKey(content) : null;
  companions.set(runPath(item), run);
  return mine.size;
}

/** 比べる相手の走行の動画を外す (その走行がどの Car にもいなくなったとき)。開いている走行・ほかの相手の動画は残す */
export function dropCompanion(path: string): void {
  const run = companions.get(path);
  if (!run) return;
  void saveRun(run);
  const paths = run.paths;
  if (run.sessionIds.some(id => run.sessions().some(s => s.id === id))) {
    run.kept = rowContent(run, run.item.entry)?.videos ?? run.item.entry?.videos ?? [];
    run.paths = new Set();run.mediaAttached = false;
  } else companions.delete(path);
  const keep = companionPaths();
  for (const t of videoSyncManager.getTracks()) {
    if (t.remote && paths.has(t.remote.path) && !keep.has(t.remote.path) && !current?.paths.has(t.remote.path)) videoSyncManager.removeTrack(t.id);
  }
}

/** 開いている走行に、同じフォルダの動画を足す (動画の画面から) */
export async function addVideoToOpenRun(video: RemoteVideo): Promise<boolean> {
  const run = current;
  if (!run) return false;
  await videoSyncManager.addVideoFiles([video], run.sessions(), true, () => current === run);
  if (current !== run) return false;
  run.paths.add(video.path);
  run.known.add(video.name);
  // runs.json に同期を覚えていた動画 (開いたときは iCloud にだけあったもの) は、その同期を戻す
  const saved = run.kept.find(v => v.name === video.name);
  if (saved) {
    run.kept = run.kept.filter(v => v !== saved);
    const only: RunRow = { updatedAt: '', videos: [saved] };
    const tmp: OpenRun = { ...run, paths: new Set([video.path]), pendingOffsets: run.pendingOffsets };
    restoreRowVideos(tmp, only);
  }
  scheduleSave();
  return true;
}

/** 保存元へ換算できない調整は、時計やピンを変える前に止める。 */
export function assertRunSyncTarget(trackId: string, session: Session, pin = false): void {
  const track = videoSyncManager.getTracks().find(t => t.id === trackId);
  if (!track?.remote) return;
  const owner = [...(current ? [current] : []), ...companions.values()].find(r => r.paths.has(track.remote!.path));
  if (!owner) return;
  if ([...owner.partClocks.values()].some(p => p.id === session.id)) return;
  const own = [...owner.partClocks.values()].find(p => p.id === track.matchedSessionId) ?? [...owner.partClocks.values()][0];
  if (sessionStartUtcMs(session) === null || (pin && sessionStartUtcMs(own) === null)) throw new UnpersistableSyncError();
}

/** 開いている走行 (動画の画面で、同じフォルダの動画を出すため) */
export function getOpenRun(): { store: RunStore; item: RunItem } | null {
  return current ? { store: current.store, item: current.item } : null;
}

const openRunListeners = new Set<() => void>();
/** 走行を開いたことを知らせてもらう (動画の窓が、その走行に覚えた並びにするため)。外す関数を返す */
export function onOpenRun(f: () => void): () => void {
  openRunListeners.add(f);
  return () => { openRunListeners.delete(f); };
}

/**
 * 開いている走行に覚えたメーターの並び (PLAN-08)。sessionId がその走行のログのときだけ。覚えていなければ null
 */
export function openRunOverlayLayout(sessionId: string | undefined): string | null {
  if (!current || !sessionId || !current.sessionIds.includes(sessionId)) return null;
  const v = current.item.entry?.overlayLayout;
  return typeof v === 'string' && v ? v : null;
}

/**
 * 開いている走行 (sessionId がそのログのとき) の行に、メーターの並びを覚える (PLAN-08)。自動は 'auto'
 */
export async function setOpenRunOverlayLayout(sessionId: string | undefined, id: string): Promise<void> {
  const run = current;
  if (!run || !sessionId || !run.sessionIds.includes(sessionId)) return;
  // 自動も 'auto' として覚える (覚えていない走行と分けるため。覚えていない走行はウインドウの並びのまま)
  if ((run.requestedLayout ?? run.item.entry?.overlayLayout) === id) return;
  run.requestedLayout = id;
  try {
    const row = await updateRun(run.store, run.item.folder, run.item.file, prev => ({ ...prev, overlayLayout: run.requestedLayout ?? id }));
    run.item.entry = row;
  } catch {
    // 書けなくても、今のウインドウではその並びで出す
  }
}

/** 走行の行に書ける項目 (null・空は消す) */
export interface RunMetaPatch {
  name?: string | null;
  note?: string | null;
  car?: string | null;
  tyre?: string | null;
  reference?: { driver?: string; car?: string } | null;
  weather?: Weather | null;
  airTempC?: number | null;
  trackTempC?: number | null;
}

/** 天候・気温・路面温度を行に入れる (null・読めない値は消す) */
function applyConditions(row: Partial<RunRow>, patch: RunMetaPatch): void {
  if ('weather' in patch) { if (isWeather(patch.weather)) row.weather = patch.weather; else delete row.weather; }
  for (const k of ['airTempC', 'trackTempC'] as const) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (isTempC(v)) row[k] = v; else delete row[k];
  }
}

let metadataSequence = 0;
const pendingMetadata = new Map<string, Map<keyof RunMetaPatch, { version: number; value: unknown }>>();
const metadataStores = new WeakMap<RunStore, number>();
let metadataStoreSequence = 0;

function metadataKeyOf(store: RunStore, item: RunItem): string {
  if (store.storageRevision === undefined && !metadataStores.has(store)) metadataStores.set(store, ++metadataStoreSequence);
  return JSON.stringify([store.storageRevision === undefined ? ['store', metadataStores.get(store)] : ['root', store.storageRevision],
    item.folder, item.file.slice(0, item.file.lastIndexOf('/') + 1), runStem(item.file)]);
}

function patchMetadata(row: Partial<RunRow> | null | undefined, patch: RunMetaPatch): RunRow {
  const next: RunRow = { updatedAt: '', ...row };
  for (const k of ['name', 'note', 'car', 'tyre'] as const) if (k in patch) {
    const value = patch[k]?.trim(); if (value) next[k] = value; else delete next[k];
  }
  if ('reference' in patch) {
    if (patch.reference) next.reference = { driver: patch.reference.driver?.trim() || undefined, car: patch.reference.car?.trim() || undefined };
    else delete next.reference;
  }
  applyConditions(next, patch);
  return next;
}

function withPendingMetadata(store: RunStore, item: RunItem, row: RunRow): RunRow {
  const pending = pendingMetadata.get(metadataKeyOf(store, item));
  return pending?.size ? patchMetadata(row, Object.fromEntries([...pending].map(([k, v]) => [k, v.value])) as RunMetaPatch) : row;
}

function relatedRunItems(store: RunStore, item: RunItem): Set<RunItem> {
  return new Set([item, ...[current, ...companions.values()].filter((r): r is OpenRun =>
    !!r && metadataKeyOf(r.store, r.item) === metadataKeyOf(store, item)).map(r => r.item)]);
}

export function getRunItemEntry(store: RunStore, item: RunItem): RunRow | null {
  return pendingMetadata.get(metadataKeyOf(store, item))?.size
    ? withPendingMetadata(store, item, item.entry ?? { updatedAt: '' }) : item.entry;
}

/**
 * 走行の名前・メモを runs.json の行に書く (PLAN-32・33)。ファイルの名前は変えない (同期・控え・runs.json の鍵がファイル名で引いているため)。
 * 空にしたら消す。開いている走行の行も、書いた中身にそろえる
 */
export async function setRunMeta(store: RunStore, item: RunItem, patch: RunMetaPatch): Promise<RunRow> {
  editSequence++;
  const version = ++metadataSequence;
  const targets = relatedRunItems(store, item);
  const key = metadataKeyOf(store, item);
  const pending = pendingMetadata.get(key) ?? new Map<keyof RunMetaPatch, { version: number; value: unknown }>();
  for (const [field, value] of Object.entries(patch)) pending.set(field as keyof RunMetaPatch, { version, value });
  pendingMetadata.set(key, pending);
  for (const target of targets) {
    target.entry = withPendingMetadata(store, target, target.entry ?? { updatedAt: '' });
  }
  const row = await updateRun(store, item.folder, item.file, prev => patchMetadata(prev, patch));
  for (const target of relatedRunItems(store, item)) targets.add(target);
  for (const [field, value] of pending) if (value.version === version) pending.delete(field);
  if (!pending.size && pendingMetadata.get(key) === pending) pendingMetadata.delete(key);
  for (const target of targets) target.entry = withPendingMetadata(store, target, row);
  return row;
}

/** 走行の周を隠す・出す (控え laptimes.json に書く。ファイルは消さない) */
export async function setRunLapHidden(store: RunStore, item: RunItem, lap: LapRecord, hide: boolean): Promise<void> {
  await updateLapHidden(store, item.folder, item.file, lap, hide);
}

/** 保存を待ったあと、開いている走行の最新の同期行を採用側へ渡す。 */
export function getOpenRunItem(folder: string, file: string): RunItem | null {
  const path = `${folder}/${file}`;
  return current && runPath(current.item) === path ? current.item : companions.get(path)?.item ?? null;
}
