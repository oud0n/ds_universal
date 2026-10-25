/**
 * 動画だけの参考ラップ (LATER-17 の案 1。PLAN-31 の残り。2026-10-25)。
 *
 * GPS もログもない動画 (速い人の車載動画など) を再生しながら、計測線を通ったところで手で印を打ち、周とセクターのタイムを作る。
 * 位置・速度・G は無いので、比べるのはタイムと動画だけ (自分の走行の動画と、周の始まりをそろえて並べる)。
 *
 * 保存は動画と同じフォルダの runs.json の行 (鍵は「日付のフォルダ/動画のファイル名」。拡張子つきなので、ログの走行の行とぶつからない)。
 * 行には videoLaps (印) と reference (誰・車) を書く。動画のファイルは変えない
 */
import type { RunFileInfo, RunStore } from './runStore';
import type { RunItem } from './runOpener';
import { isRunVideoName, runStem } from './lapIndex';
import { RUNS_FILE, readRunsFile, removeRunRow, updateRun, type RunRow } from './runsFile';

export interface VideoLapMark {
  /** 動画の位置 (秒) */
  t: number;
  /** line: 計測線、sector: セクターの線 */
  kind: 'line' | 'sector';
}

export interface VideoLapsData {
  /** 印 (動画の位置の順) */
  marks: VideoLapMark[];
  [key: string]: unknown;
}

export interface VideoLap {
  n: number;
  /** 周の始まりの動画の位置 (秒) */
  start: number;
  time: number;
  /** セクタータイム (秒。最後のセクターは最後のセクターの線から計測線まで)。セクターの印が無ければ空 */
  sectors: number[];
}

/** 動画だけの参考ラップ (一覧の 1 行) */
export interface VideoRef {
  /** サーキットのフォルダ (runs.json のあるフォルダ) */
  folder: string;
  /** フォルダの中の動画 (例 20261025/GX010123.MP4) */
  file: string;
  /** 保管場所の道 */
  path: string;
  size: number;
  /** iCloud にだけあって、まだ落としていない */
  remote: boolean;
  row: RunRow;
  laps: VideoLap[];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** 印から周を作る: 計測線の印から次の計測線の印までが 1 周。その間のセクターの印でセクターに分ける */
export function lapsFromMarks(marks: VideoLapMark[]): VideoLap[] {
  const sorted = [...marks].filter(m => Number.isFinite(m.t) && m.t >= 0).sort((a, b) => a.t - b.t);
  const lines = sorted.filter(m => m.kind === 'line');
  const laps: VideoLap[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const start = lines[i].t, end = lines[i + 1].t;
    if (end - start < 1) continue;
    const cuts = sorted.filter(m => m.kind === 'sector' && m.t > start && m.t < end).map(m => m.t);
    const edges = [start, ...cuts, end];
    const sectors = cuts.length ? edges.slice(1).map((e, k) => round3(e - edges[k])) : [];
    laps.push({ n: laps.length + 1, start: round3(start), time: round3(end - start), sectors });
  }
  return laps;
}

/** 行から読む (おかしな印は落とす) */
export function videoLapsOf(row: RunRow | null | undefined): VideoLapsData | null {
  const v = row?.videoLaps as Partial<VideoLapsData> | undefined;
  if (!v || !Array.isArray(v.marks)) return null;
  const marks = v.marks.filter((m): m is VideoLapMark => !!m && typeof m.t === 'number' && Number.isFinite(m.t) && (m.kind === 'line' || m.kind === 'sector'));
  return { ...v, marks };
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** 動画の道を、サーキットのフォルダとフォルダの中の名前に分ける (サーキット/動画 か サーキット/日付/動画 だけ) */
export function splitVideoPath(path: string): { folder: string; file: string } | null {
  const parts = path.split('/');
  if (parts.length === 2) return { folder: parts[0], file: parts[1] };
  if (parts.length === 3 && /^\d{8}$/.test(parts[1])) return { folder: parts[0], file: `${parts[1]}/${parts[2]}` };
  return null;
}

/** 保管場所の動画だけの参考ラップ (runs.json の行に videoLaps があり、動画がまだあるもの) */
export async function listVideoRefs(store: RunStore, files?: RunFileInfo[]): Promise<VideoRef[]> {
  const all = files ?? await store.listAll();
  const byPath = new Map(all.map(f => [f.path, f]));
  const folders = [...new Set(all.filter(f => nameOf(f.path) === RUNS_FILE && !f.path.slice(0, -RUNS_FILE.length - 1).includes('/')).map(f => dirOf(f.path)))];
  const out: VideoRef[] = [];
  for (const folder of folders) {
    const runs = await readRunsFile(store, folder).catch(() => null);
    if (!runs) continue;
    for (const [key, row] of Object.entries(runs.runs)) {
      const data = videoLapsOf(row);
      if (!data || !isRunVideoName(nameOf(key))) continue;
      const path = `${folder}/${key}`;
      const f = byPath.get(path);
      if (!f) continue;
      out.push({ folder, file: key, path, size: f.size, remote: f.local === false, row, laps: lapsFromMarks(data.marks) });
    }
  }
  return out.sort((a, b) => b.row.updatedAt.localeCompare(a.row.updatedAt));
}

/**
 * 参考ラップにできる動画: サーキットのフォルダ (か、その日付のフォルダ) の動画で、どの走行にも付いていないもの。
 * 走行と同じ名前の動画 (内蔵カメラの <走行名>.mov など) と、もう参考ラップにした動画は出さない
 */
export function videoRefCandidates(files: RunFileInfo[], runs: RunItem[], refs: VideoRef[]): RunFileInfo[] {
  const used = new Set<string>(refs.map(r => r.path));
  const runStems = new Set<string>();
  for (const r of runs) {
    const dir = dirOf(`${r.folder}/${r.file}`);
    for (const v of r.videos) used.add(`${dir}/${v}`);
    runStems.add(`${dir}/${runStem(r.file)}`);
  }
  return files.filter(f => {
    const name = nameOf(f.path);
    if (!isRunVideoName(name) || !splitVideoPath(f.path) || used.has(f.path)) return false;
    if (f.path.startsWith('exports/') || f.path.startsWith('取り込み元/')) return false;
    // 内蔵カメラの動画 (<走行名>.mov・_2・_front・_v2)
    const stem = name.replace(/(_front)?(_\d+)?(_v\d+)?\.[^.]+$/i, '');
    return !runStems.has(`${dirOf(f.path)}/${stem}`);
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 印と、誰・車・名前を書く */
export async function saveVideoLaps(store: RunStore, path: string, marks: VideoLapMark[], meta: { name?: string; driver?: string; car?: string }): Promise<void> {
  const where = splitVideoPath(path);
  if (!where) throw new Error('not a circuit folder');
  const clean = [...marks].sort((a, b) => a.t - b.t).map(m => ({ t: round3(m.t), kind: m.kind }));
  await updateRun(store, where.folder, where.file, row => ({
    ...row,
    videoLaps: { ...(videoLapsOf(row) ?? {}), marks: clean },
    reference: { ...(meta.driver?.trim() ? { driver: meta.driver.trim() } : {}), ...(meta.car?.trim() ? { car: meta.car.trim() } : {}) },
    ...(meta.name?.trim() ? { name: meta.name.trim() } : { name: undefined })
  }));
}

/** 参考ラップをやめる (行を消す。動画は残す) */
export function removeVideoLaps(store: RunStore, ref: VideoRef): Promise<void> {
  return removeRunRow(store, ref.folder, ref.file);
}

/**
 * 自分の走行の周の始まりが、その走行に付けた動画の何秒目か (同期した動画のうち、周が映っている最初のもの)。
 * 動画の時刻がログの先頭からの位置 (分かれた走行の 1 番目) か、世界の時刻で分かっているときだけ。分からなければ null
 */
export function ownLapInVideo(run: RunItem, lap: { startMs: number; part?: number; time: number }): { video: string; path: string; sec: number } | null {
  const dir = dirOf(`${run.folder}/${run.file}`);
  for (const v of run.entry?.videos ?? []) {
    const c = v.clock;
    if (!c) continue;
    let startUtc: number | null = null;
    if (c.logPart === null || c.logPart === undefined) startUtc = c.utcMs ?? null;
    else if (c.logPart === 1 && (lap.part ?? 1) === 1 && run.startMs !== null) startUtc = run.startMs + c.offsetSec * 1000;
    if (startUtc === null) continue;
    const sec = (lap.startMs - startUtc) / 1000;
    if (sec < 0 || (v.durationSec !== undefined && sec + lap.time > v.durationSec + 0.5)) continue;
    return { video: v.name, path: `${dir}/${v.name}`, sec: round3(sec) };
  }
  return null;
}
