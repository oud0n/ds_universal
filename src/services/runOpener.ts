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
import type { Session } from '../types/telemetry';
import { loadLapHistory } from './lapHistory';
import { LAP_INDEX_FILE, groupRunsByFolder, queueLapIndexWrite, isRunVideoName, lapKey, parseLapIndex, runStem, setHidden, type LapRecord } from './lapIndex';
import { findRunRow, isRunsConflictCopy, noteRunsConflictCopies, readRunsFile, updateRun, type RunRow, type RunVideo } from './runsFile';
import { rowParts, rowVideoFromTrack, syncPinsFromRow, syncVideoFromRow } from './runSync';
import type { RunFileInfo, RunStore } from './runStore';
import { parseVideoMetadata } from './videoMetadataParser';
import { remoteFileLike, type RemoteVideo } from './remoteVideo';
import { videoSyncManager } from './videoSyncManager';
import { videoViewStore } from './videoViewStore';
import { createSyncPin, type SyncPin } from './videoSyncPinManager';

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
export async function listRuns(store: RunStore, onProgress?: (folder: string) => void): Promise<RunItem[]> {
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
    const runs = await readRunsFile(store, f.folder);
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
export async function videoCandidates(store: RunStore, item: RunItem): Promise<{ local: RemoteVideo[]; missing: RunFileInfo[]; fromRuns: boolean }> {
  const byName = new Map(item.folderVideos.map(v => [baseName(v.path), v]));
  // 古いアプリ (lapfile:// を読めない) では、動画は開かない
  if (!(await store.supportsVideos())) return { local: [], missing: [], fromRuns: !!item.videos.length };
  const toRemote = (v: RunFileInfo): RemoteVideo => ({ name: baseName(v.path), size: v.size, url: store.videoUrl(v.path), path: v.path, lastModified: v.mtimeMs, readRange: store.rangeReader?.(v.path) });
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
  // iCloud にだけある動画は中を読めないので、ファイルの日時 (GoPro から写した動画は撮影の終わりの時刻のことが多い) で候補にし、取り込むか聞く
  const missing = item.folderVideos.filter(x => !x.local && !/\.lrv$/i.test(x.path) && Math.abs(x.mtimeMs - item.startMs!) <= 14 * 3600_000);
  return { local, missing, fromRuns: false };
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

const runPath = (item: RunItem) => `${item.folder}/${item.file}`;
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
const runSessionsOf = (run: OpenRun, all: Session[] = sessionsOf(run)) =>
  run.sessionIds.map(id => all.find(s => s.id === id)).filter((s): s is Session => !!s);

/** その走行の今の動画・ピン・ログ (書く前に取っておく。書くのを待つ間に動画が外されても、外す前の中身で書くため) */
interface RunSnapshot {
  all: Session[];
  tracks: ReturnType<typeof videoSyncManager.getTracks>;
  pins: SyncPin[];
}
function snapshotOf(run: OpenRun): RunSnapshot {
  return {
    all: sessionsOf(run),
    tracks: videoSyncManager.getTracks().filter(t => t.remote && run.paths.has(t.remote.path)).map(t => ({ ...t, clock: { ...t.clock } })),
    pins: videoViewStore.getPins(run.circuitName() || 'default').slice()
  };
}

/** その走行の、行の中身 (動画・時計の補正)。ログが 1 つも無い (閉じた) ときは null */
function rowContent(run: OpenRun, prev: RunRow | null, snap: RunSnapshot = snapshotOf(run)): Pick<RunRow, 'parts' | 'videos'> | null {
  const { all, tracks, pins } = snap;
  const runSessions = runSessionsOf(run, all);
  // その走行のログが 1 つでも外されていたら書かない (残ったログの番号が詰まり、2 番目のログの同期を 1 番目として書いてしまうため)
  if (!runSessions.length || runSessions.length !== run.sessionIds.length) return null;
  const opened = new Set(tracks.map(t => t.fileName));
  const videos = [
    ...tracks.map(t => rowVideoFromTrack(t, pins.filter(p => p.trackId === t.id), runSessions, all, prev?.videos?.find(v => v.name === t.fileName))),
    ...run.kept.filter(v => !opened.has(v.name)),
    // 開いている間にほかの端末が足した動画 (書く直前の行にあって、開いたときには知らなかったもの)
    ...(prev?.videos ?? []).filter(v => !opened.has(v.name) && !run.known.has(v.name) && !run.kept.some(k => k.name === v.name))
  ];
  return { parts: rowParts(runSessions, prev?.parts), videos };
}

const contentKey = (c: Pick<RunRow, 'parts' | 'videos'>) => JSON.stringify(c);

/** 走行の動画と同期を runs.json に書く (中身が変わったときだけ) */
async function saveRun(run: OpenRun): Promise<void> {
  // 今の中身を取っておく (書くのを待つ間に、Car 1 を替えた・比べる相手から外したなどで動画が外されても、外す前の中身で書く)
  const snap = snapshotOf(run);
  const content = rowContent(run, run.item.entry, snap);
  if (!content) return;
  const key = contentKey(content);
  if (key === run.baseline) return;
  try {
    const row = await updateRun(run.store, run.item.folder, run.item.file, prev => {
      // 書く直前の行で作り直す (ほかの端末が足した項目を残す)。動画・ピンは取っておいたもの
      const fresh = rowContent(run, prev ?? null, snap) ?? content;
      return { ...prev, ...fresh };
    });
    run.baseline = key;
    run.item.entry = row;
    // 次にこの走行を開き直すとき (Car 1 を替えて戻ったときなど) の動画の候補も、書いた中身にする (外した動画が戻らないように)
    run.item.videos = row.videos?.map(v => v.name) ?? [];
    run.item.synced = !!row.videos?.some(v => !!v.clock);
  } catch {
    // 書けない (読めない形の runs.json など) ときは、次に変わったときにもう一度試す
  }
}

function saveAll(): Promise<unknown> {
  const runs = [...(current ? [current] : []), ...companions.values()];
  return Promise.all(runs.map(saveRun));
}

function scheduleSave(): void {
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
export function flushOpenRuns(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  void saveAll();
}

/** 走行を閉じた (ほかのログを開いた・消した): 書きかけを書いて、Car 1 の走行として覚えるのをやめる */
export function closeOpenRun(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  // 中身が変わっていなければ書かない (saveRun が開いたときの中身と比べる)
  void saveAll();
  current = null;
}

/**
 * 行の動画の同期とピンを、開いた動画 (道で見分ける) に戻す。同じ名前の動画がほかの走行にあっても、ほかの動画には当てない
 */
function restoreRowVideos(run: OpenRun, row: RunRow | null, setClockOffset?: (id: string, sec: number) => void): void {
  if (!row) return;
  // ログの時計の補正 (何番目ごと)。ログに入るまでは pendingOffsets の値を使う
  const before = runSessionsOf(run);
  for (const [n, p] of Object.entries(row.parts ?? {})) {
    const s = before[Number(n) - 1];
    if (s && typeof p.clockOffsetSec === 'number' && Number.isFinite(p.clockOffsetSec) && Math.abs(p.clockOffsetSec) <= 3600 && (s.clockOffsetSec ?? 0) !== p.clockOffsetSec) {
      run.pendingOffsets.set(s.id, { sec: p.clockOffsetSec, until: Date.now() + 5000 });
      setClockOffset?.(s.id, p.clockOffsetSec);
    }
  }
  const all = sessionsOf(run);
  const runSessions = runSessionsOf(run, all);
  const key = run.circuitName() || 'default';
  let pins = videoViewStore.getPins(key);
  let pinsChanged = false;
  const trackIds = new Set(videoSyncManager.getTracks().map(t => t.id));
  const restore: Array<{ trackId: string; vData: NonNullable<ReturnType<typeof syncVideoFromRow>> }> = [];
  for (const t of videoSyncManager.getTracks()) {
    if (!t.remote || !run.paths.has(t.remote.path)) continue;
    const v = row.videos?.find(x => x.name === t.fileName);
    if (!v) continue;
    const vData = syncVideoFromRow(v, runSessions);
    if (vData) restore.push({ trackId: t.id, vData });
    for (const p of syncPinsFromRow(v, t.id, runSessions)) {
      // 前に開いたときのピン (動画の ID は開くたびに変わる) は、今の動画に付け直す (重ねて足さない)
      const same = (c: SyncPin) => c.name === p.name && Math.abs(c.sessionTimeSec - p.sessionTimeSec) < 0.001 && Math.abs(c.videoTimeSec - p.videoTimeSec) < 0.001;
      const mine = pins.find(c => same(c) && c.trackId === t.id);
      if (mine) continue;
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
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const next = attachQueue.then(fn, fn);
  attachQueue = next.catch(() => undefined);
  return next;
}

/**
 * 走行の動画を開いて、同期を戻し、これからの変化を runs.json に書くようにする。
 * ログはもう読み込んであること (session)。videos は videoCandidates の local
 */
export function attachRunVideos(opts: Parameters<typeof attachRunVideosNow>[0]): Promise<number> {
  return queued(() => attachRunVideosNow(opts));
}

async function attachRunVideosNow(opts: {
  store: RunStore;
  item: RunItem;
  /** 開いた走行のログ (走行が途中で長く止まって分かれたときは複数。読み込んだ順) */
  runSessions: Session[];
  videos: RemoteVideo[];
  fromRuns: boolean;
  sessions: () => Session[];
  circuitName: () => string;
  setClockOffset?: (id: string, sec: number) => void;
}): Promise<number> {
  closeOpenRun();
  ensureSubscribed();
  const { store, item, videos } = opts;
  const ids = new Set(opts.runSessions.map(s => s.id));
  // この走行が比べる相手の走行だったら、Car 1 の走行として扱う
  companions.delete(runPath(item));
  // 前に開いたほかの走行の動画 (保管場所のもの) は外す。この走行の動画で、もう開いているものと、比べる相手の走行の動画は残す
  const paths = new Set(videos.map(v => v.path));
  const keep = companionPaths();
  for (const t of videoSyncManager.getTracks()) if (t.remote && !paths.has(t.remote.path) && !keep.has(t.remote.path)) videoSyncManager.removeTrack(t.id);
  // 同じ動画 (同じ道) がもう開いていれば足さない (名前では見分けない。GoPro の名前は、ほかのフォルダの動画と同じことがある)
  const openPaths = new Set(videoSyncManager.getTracks().filter(t => t.remote).map(t => t.remote!.path));
  const add = videos.filter(v => !openPaths.has(v.path));
  if (add.length) await videoSyncManager.addVideoFiles(add, opts.sessions());
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
    .filter(t => t.remote && paths.has(t.remote.path) && (opts.fromRuns || (t.matchedSessionId !== null && ids.has(t.matchedSessionId))))
    .map(t => t.remote!.path));
  const openedNames = new Set(videoSyncManager.getTracks().filter(t => t.remote && mine.has(t.remote.path)).map(t => t.fileName));
  const row = item.entry;
  const run: OpenRun = {
    store, item, sessionIds: opts.runSessions.map(s => s.id), circuitName: opts.circuitName, sessions: opts.sessions, paths: mine,
    // runs.json にあって今回は開かなかった動画 (iCloud にだけある・見つからない) は、消さずに残す
    kept: opts.fromRuns ? (row?.videos ?? []).filter(v => !openedNames.has(v.name)) : [],
    known: new Set([...(row?.videos ?? []).map(v => v.name), ...openedNames]),
    baseline: null,
    pendingOffsets: new Map()
  };
  if (opts.fromRuns) restoreRowVideos(run, row, opts.setClockOffset);
  current = run;
  for (const f of openRunListeners) f();
  // runs.json から開いたときは、今の中身を「書いたもの」とする (開いただけでは書かない)。
  // runs.json に無い動画を付けたときは書く (付けたことを覚える)
  const content = rowContent(run, row);
  run.baseline = opts.fromRuns || mine.size === 0 ? (content ? contentKey(content) : null) : null;
  if (run.baseline === null) scheduleSave();
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
  return [...companions.keys()];
}

/**
 * 比べる相手の走行の動画を足す (Car 2〜4 に、開いている走行のほかの走行の周を入れたとき)。端末にある動画だけ。
 * 同期はその走行の runs.json の行から戻し、変えたらその行に書く
 */
export function attachCompanionVideos(opts: Parameters<typeof attachCompanionVideosNow>[0]): Promise<number> {
  return queued(() => attachCompanionVideosNow(opts));
}

async function attachCompanionVideosNow(opts: {
  store: RunStore;
  item: RunItem;
  runSessions: Session[];
  videos: RemoteVideo[];
  fromRuns: boolean;
  sessions: () => Session[];
  circuitName: () => string;
  setClockOffset?: (id: string, sec: number) => void;
}): Promise<number> {
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
    await videoSyncManager.addVideoFiles(add, opts.sessions());
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
  const run: OpenRun = {
    store: opts.store, item, sessionIds: opts.runSessions.map(s => s.id), circuitName: opts.circuitName, sessions: opts.sessions, paths: mine,
    kept: opts.fromRuns ? (row?.videos ?? []).filter(v => !openedNames.has(v.name)) : [],
    known: new Set([...(row?.videos ?? []).map(v => v.name), ...openedNames]),
    baseline: null,
    pendingOffsets: new Map()
  };
  if (opts.fromRuns) restoreRowVideos(run, row, opts.setClockOffset);
  const content = rowContent(run, row);
  // 比べる相手の走行は、runs.json に無い動画を付けても書かない (Car 1 として開いたときに書く)。変えたら書く
  run.baseline = content ? contentKey(content) : null;
  companions.set(runPath(item), run);
  return mine.size;
}

/** 比べる相手の走行の動画を外す (その走行がどの Car にもいなくなったとき)。開いている走行・ほかの相手の動画は残す */
export function dropCompanion(path: string): void {
  const run = companions.get(path);
  if (!run) return;
  void saveRun(run);
  companions.delete(path);
  const keep = companionPaths();
  for (const t of videoSyncManager.getTracks()) {
    if (t.remote && run.paths.has(t.remote.path) && !keep.has(t.remote.path) && !current?.paths.has(t.remote.path)) videoSyncManager.removeTrack(t.id);
  }
}

/** 開いている走行に、同じフォルダの動画を足す (動画の画面から) */
export async function addVideoToOpenRun(video: RemoteVideo): Promise<boolean> {
  const run = current;
  if (!run) return false;
  await videoSyncManager.addVideoFiles([video], run.sessions());
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

/**
 * 走行の名前・メモを runs.json の行に書く (PLAN-32・33)。ファイルの名前は変えない (同期・控え・runs.json の鍵がファイル名で引いているため)。
 * 空にしたら消す。開いている走行の行も、書いた中身にそろえる
 */
export async function setRunMeta(store: RunStore, item: RunItem, patch: RunMetaPatch): Promise<RunRow> {
  // 書き終わる前に開いても新しい値が使われるよう、先に手元の行にも入れておく (車種を書いてすぐ「解析で開く」を押したとき)
  if (item.entry) {
    const preview = { ...item.entry };
    for (const k of ['name', 'note', 'car', 'tyre'] as const) if (k in patch) { const v = patch[k]?.trim(); if (v) preview[k] = v; else delete preview[k]; }
    applyConditions(preview, patch);
    // 参考ラップの印も先に入れる (入れないと、参考ラップに替えた直後に一覧から外れ、詳細が一度消えていた)
    if ('reference' in patch) {
      if (patch.reference) preview.reference = { driver: patch.reference.driver?.trim() || undefined, car: patch.reference.car?.trim() || undefined };
      else delete preview.reference;
    }
    item.entry = preview;
  }
  const row = await updateRun(store, item.folder, item.file, prev => {
    const next: Partial<RunRow> = { ...prev };
    // 参考ラップの印 (null で外す)。誰・車は前後の空白を落とす
    if ('reference' in patch) {
      if (patch.reference) next.reference = { driver: patch.reference.driver?.trim() || undefined, car: patch.reference.car?.trim() || undefined };
      else delete next.reference;
    }
    for (const k of ['name', 'note', 'car', 'tyre'] as const) {
      if (!(k in patch)) continue;
      const v = patch[k]?.trim();
      if (v) next[k] = v;
      else delete next[k];
    }
    applyConditions(next, patch);
    return next;
  });
  item.entry = row;
  for (const r of [current, ...companions.values()]) if (r && runPath(r.item) === runPath(item)) r.item.entry = row;
  return row;
}

/** 走行の周を隠す・出す (控え laptimes.json に書く。ファイルは消さない) */
export function setRunLapHidden(store: RunStore, item: RunItem, lap: LapRecord, hide: boolean): Promise<void> {
  const run = async () => {
    const path = `${item.folder}/${LAP_INDEX_FILE}`;
    const index = parseLapIndex(await store.readText(path));
    if (!index) return;
    await store.writeText(path, JSON.stringify(setHidden(index, item.file, lap.part, lap.n, hide)));
  };
  return queueLapIndexWrite(run);
}
