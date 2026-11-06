import { fault, defaultText } from './errors';
/**
 * ラップタイムの一覧を、保管場所から読み込む (2026-10-20、PLAN-19)。iPhone のアプリとデスクトップ版で共通。
 * 保管場所/<サーキットのフォルダ>/ ごとに、コースを見つけて控え (laptimes.json) を作り直し、一覧の行にする
 */

import { conditionsOf, type RunConditions } from './runFilters';
import { findRunRow, type RunsFileStore } from './runsFile';
import { StorageChangedError, type StorageContext } from './storageContext';
import {
  LAP_INDEX_FILE, carryHidden, groupBon4ByFolder, lapRows, parseLapIndex, createLapIndexQueue, reconcileFolder, setHidden,
  type LapCourse, type LapFileStore, type LapIndex, type LapRow, type LapRecord
} from './lapIndex';

export interface LapFolder {
  folder: string;
  /** コースの名前 (見つからなければ null。周は数えられない) */
  courseName: string | null;
  /** .bon4 の数 */
  fileCount: number;
  rows: LapRow[];
  index: LapIndex | null;
  /** 走行の名前 (runs.json の行の name。走行のファイル名 → 名前。PLAN-32) */
  names?: Record<string, string>;
  /** 参考ラップ (自分のではない走行。走行のファイル名 → 誰の走行か。PLAN-31)。順位・ベストに数えない */
  references?: Record<string, string>;
  /** 車種・タイヤ・天候 (走行のファイル名 → 値。書いた走行だけ。PLAN-37) */
  conditions?: Record<string, RunConditions>;
}
export function createLapHistory(context: StorageContext, courseForFolder: (folder: string) => Promise<LapCourse | null>, loadStorageCourses: () => Promise<unknown>, runs: RunsFileStore, queueLapIndexWrite: ReturnType<typeof createLapIndexQueue>) {
const {getStorageReadRevision,isStorageSelectionPending} = context;
const {readRunsFile}=runs;
/** 1 つのサーキットのフォルダの一覧 */


/**
 * 保管場所の全部のサーキットのフォルダを読み込む。変わったファイルだけ計算し、控えが変わったら書き直す。
 * onProgress は計算しているフォルダ (最初に大量のファイルを計算するとき、数秒かかることがある)
 */
async function loadLapHistory(store: LapFileStore, onProgress?: (folder: string) => void): Promise<LapFolder[]> {
  const reads = getStorageReadRevision();
  const check = () => { if (reads !== getStorageReadRevision()) throw new StorageChangedError(); };
  // 同じ名前のフォルダでも、前の保存先の計測線で控えを作らない。
  await loadStorageCourses();
  check();
  const groups = groupBon4ByFolder(await store.list());
  check();
  const out: LapFolder[] = [];
  for (const [folder, files] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const course = await courseForFolder(folder);
    check();
    if (!course) {
      out.push({ folder, courseName: null, fileCount: files.length, rows: [], index: null });
      continue;
    }
    onProgress?.(folder);
    const prev = parseLapIndex(await store.readText(`${folder}/${LAP_INDEX_FILE}`));
    check();
    const indexPath = `${folder}/${LAP_INDEX_FILE}`;
    // 書くのは 1 つずつ (lapIndex.ts)。計算している間に周を隠した・出したときは、その隠し方を残す
    let written: LapIndex | null = null;
    const writeIndex = (ix: LapIndex, final = false) => queueLapIndexWrite(async () => {
      check();
      const cur = parseLapIndex(await (store.readTextStrict ? store.readTextStrict(indexPath) : store.readText(indexPath)));
      check();
      const hidden = cur?.hidden ?? ix.hidden;
      const skipped = files.filter(f => f.local === false || ix.files[f.path.slice(folder.length + 1)]?.needsRecompute).map(f => f.path.slice(folder.length + 1));
      written = { ...ix, hidden: final ? carryHidden(hidden, ix.files, skipped) : hidden };
      await store.writeText(indexPath, JSON.stringify(written));
    });
    const result = await reconcileFolder(folder, files, course, prev, p => store.read(p), undefined, writeIndex);
    check();
    // 控えを書けなくても、一覧は出す (次に開いたときにもう一度計算する)
    if (result.changed) await writeIndex(result.index, true).catch(error => {
      if (error instanceof StorageChangedError) throw error;
    });
    // 一覧には、書いた中身 (計算の間に隠した周を残したもの) を出す
    const index: LapIndex = result.changed && written ? written : result.index;
    // 走行に付けた名前 (読めなくても一覧は出す)
    const runsFile = await readRunsFile(store, folder).catch(error => {
      if (error instanceof StorageChangedError) throw error;
      return null;
    });
    check();
    const names: Record<string, string> = {};
    const references: Record<string, string> = {};
    const conditions: Record<string, RunConditions> = {};
    if (runsFile) for (const file of Object.keys(index.files)) {
      const row = findRunRow(runsFile, file);
      if (row?.name) names[file] = row.name;
      if (row?.reference) references[file] = row.reference.driver ?? '';
      const c = conditionsOf(row);
      if (Object.keys(c).length) conditions[file] = c;
    }
    out.push({ folder, courseName: course.name, fileCount: files.length, rows: lapRows(folder, index), index, names, references, conditions });
  }
  return out;
}

/** 周の非表示を切り替えて、控えに書く (ファイルは消さない) */
async function updateLapHidden(store: LapFileStore, folder: string, file: string, lap: Pick<LapRecord, 'part' | 'n' | 'startMs'>, hide: boolean): Promise<LapIndex> {
  const reads = getStorageReadRevision();
  const check = () => { if (reads !== getStorageReadRevision() || isStorageSelectionPending()) throw new StorageChangedError(); };
  return queueLapIndexWrite(async () => {
    check();
    const path = `${folder}/${LAP_INDEX_FILE}`;
    const index = parseLapIndex(await (store.readTextStrict ? store.readTextStrict(path) : store.readText(path)));
    check();
    const current = index?.files[file]?.laps.find(l => (l.part ?? 1) === (lap.part ?? 1) && l.n === lap.n && l.startMs === lap.startMs);
    if (!index || !current) throw fault('lapHistory.1',{ja:'周の控えが変わりました。一覧を読み直してください。',en:'The lap index changed. Reload the lap list.'});
    const next = setHidden(index, file, current.part, current.n, hide);
    await store.writeText(path, JSON.stringify(next)); check();
    return next;
  });
}
async function toggleLapHidden(store: LapFileStore, item: LapFolder, file: string, part: number | undefined, n: number, hide: boolean): Promise<LapFolder> {
  const expected = item.index?.files[file]?.laps.find(l => (l.part ?? 1) === (part ?? 1) && l.n === n);
  if (!expected) throw fault('lapHistory.2',{ja:'周の控えが変わりました。一覧を読み直してください。',en:'The lap index changed. Reload the lap list.'});
  const index = await updateLapHidden(store, item.folder, file, expected, hide);
  return { ...item, index, rows: lapRows(item.folder, index) };
}

return {loadLapHistory,updateLapHidden,toggleLapHidden};
}
