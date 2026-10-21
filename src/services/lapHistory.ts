/**
 * ラップタイムの一覧を、保管場所から読み込む (2026-10-20、PLAN-19)。iPhone のアプリとデスクトップ版で共通。
 * 保管場所/<サーキットのフォルダ>/ ごとに、コースを見つけて控え (laptimes.json) を作り直し、一覧の行にする
 */

import { CIRCUIT_PRESETS } from './circuitDatabase';
import { userCircuitStorage } from './userCircuitStorage';
import { courseFolder } from '../utils/courseNames';
import {
  LAP_INDEX_FILE, groupBon4ByFolder, lapRows, parseLapIndex, queueLapIndexWrite, reconcileFolder, setHidden,
  type LapCourse, type LapFileStore, type LapIndex, type LapRow
} from './lapIndex';

/** フォルダの名前から、周を数えるコースを見つける (入っているコースは ID、自分のコースは保存フォルダ名か名前から作ったフォルダ名) */
export async function courseForFolder(folder: string): Promise<LapCourse | null> {
  await userCircuitStorage.ready.catch(() => undefined);
  const preset = CIRCUIT_PRESETS.find(p => p.id === folder && p.controlLine);
  // コース編集で直したコースを先に見る (入っているコースを直して保存したときも、その計測線・セクター線で数える)
  const edited = userCircuitStorage.getEditedCircuits().find(c =>
    courseFolder(c.name, c.folder) === folder || (!!preset && !c.folder && c.name === preset.name));
  if (edited) return { name: edited.name, controlLine: edited.controlLine, sectors: edited.sectors };
  if (preset?.controlLine) return { name: preset.name, controlLine: preset.controlLine, sectors: preset.sectors };
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
    const indexPath = `${folder}/${LAP_INDEX_FILE}`;
    // 書くのは 1 つずつ (lapIndex.ts)。計算している間に周を隠した・出したときは、その隠し方を残す
    const writeIndex = (ix: LapIndex) => queueLapIndexWrite(async () => {
      const cur = parseLapIndex(await store.readText(indexPath));
      const userChanged = !!cur && JSON.stringify(cur.hidden) !== JSON.stringify(prev?.hidden ?? []);
      await store.writeText(indexPath, JSON.stringify(userChanged ? { ...ix, hidden: cur!.hidden } : ix));
    });
    const { index, changed } = await reconcileFolder(folder, files, course, prev, p => store.read(p), undefined, writeIndex);
    // 控えを書けなくても、一覧は出す (次に開いたときにもう一度計算する)
    if (changed) await writeIndex(index).catch(() => {});
    out.push({ folder, courseName: course.name, fileCount: files.length, rows: lapRows(folder, index), index });
  }
  return out;
}

/** 周の非表示を切り替えて、控えに書く (ファイルは消さない) */
export async function toggleLapHidden(store: LapFileStore, item: LapFolder, file: string, part: number | undefined, n: number, hide: boolean): Promise<LapFolder> {
  if (!item.index) return item;
  const index = setHidden(item.index, file, part, n, hide);
  await store.writeText(`${item.folder}/${LAP_INDEX_FILE}`, JSON.stringify(index));
  return { ...item, index, rows: lapRows(item.folder, index) };
}
