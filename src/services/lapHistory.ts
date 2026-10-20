/**
 * ラップタイムの一覧を、保管場所から読み込む (2026-10-20、PLAN-19)。iPhone のアプリとデスクトップ版で共通。
 * 保管場所/<サーキットのフォルダ>/ ごとに、コースを見つけて控え (laptimes.json) を作り直し、一覧の行にする
 */

import { CIRCUIT_PRESETS } from './circuitDatabase';
import { userCircuitStorage } from './userCircuitStorage';
import { courseFolder } from '../utils/courseNames';
import {
  LAP_INDEX_FILE, groupBon4ByFolder, lapRows, parseLapIndex, reconcileFolder, setHidden,
  type LapCourse, type LapFileStore, type LapIndex, type LapRow
} from './lapIndex';

/** フォルダの名前から、周を数えるコースを見つける (入っているコースは ID、自分のコースは保存フォルダ名か名前から作ったフォルダ名) */
export async function courseForFolder(folder: string): Promise<LapCourse | null> {
  const preset = CIRCUIT_PRESETS.find(p => p.id === folder && p.controlLine);
  if (preset?.controlLine) return { name: preset.name, controlLine: preset.controlLine, sectors: preset.sectors };
  await userCircuitStorage.ready.catch(() => undefined);
  const own = userCircuitStorage.getAllCircuits().find(c => courseFolder(c.name, c.folder) === folder);
  return own ? { name: own.name, controlLine: own.controlLine, sectors: own.sectors } : null;
}

/** 1 つのサーキットのフォルダの一覧 */
export interface LapFolder {
  folder: string;
  /** コースの名前 (見つからなければ null。周は数えられない) */
  courseName: string | null;
  /** .bon4 の数 */
  fileCount: number;
  rows: LapRow[];
  index: LapIndex | null;
}

/**
 * 保管場所の全部のサーキットのフォルダを読み込む。変わったファイルだけ計算し、控えが変わったら書き直す。
 * onProgress は計算しているフォルダ (最初に大量のファイルを計算するとき、数秒かかることがある)
 */
export async function loadLapHistory(store: LapFileStore, onProgress?: (folder: string) => void): Promise<LapFolder[]> {
  const groups = groupBon4ByFolder(await store.list());
  const out: LapFolder[] = [];
  for (const [folder, files] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const course = await courseForFolder(folder);
    if (!course) {
      out.push({ folder, courseName: null, fileCount: files.length, rows: [], index: null });
      continue;
    }
    onProgress?.(folder);
    const prev = parseLapIndex(await store.readText(`${folder}/${LAP_INDEX_FILE}`));
    const { index, changed } = await reconcileFolder(folder, files, course, prev, p => store.read(p));
    // 控えを書けなくても、一覧は出す (次に開いたときにもう一度計算する)
    if (changed) await store.writeText(`${folder}/${LAP_INDEX_FILE}`, JSON.stringify(index)).catch(() => {});
    out.push({ folder, courseName: course.name, fileCount: files.length, rows: lapRows(folder, index), index });
  }
  return out;
}

/** 周の非表示を切り替えて、控えに書く (ファイルは消さない) */
export async function toggleLapHidden(store: LapFileStore, item: LapFolder, file: string, n: number, hide: boolean): Promise<LapFolder> {
  if (!item.index) return item;
  const index = setHidden(item.index, file, n, hide);
  await store.writeText(`${item.folder}/${LAP_INDEX_FILE}`, JSON.stringify(index));
  return { ...item, index, rows: lapRows(item.folder, index) };
}
