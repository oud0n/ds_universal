import { fault } from '../engine/errors';
import { currentCsvFormats, loadCsvFormats, csvFormatsReady } from './csvFormatStore';
import { getGFilterLevel } from './physics';
import { createLapHistory } from '../engine/lapHistory';
export type { LapFolder } from '../engine/lapHistory';
import { queueLapIndexWrite, type LapCourse } from './lapIndex';
import { runsFileStore } from './runsFile';
import { CIRCUIT_PRESETS } from './circuitDatabase';
import { userCircuitStorage } from './userCircuitStorage';
import { courseFolder } from '../utils/courseNames';
import { loadStorageCourses } from './storageCourses';
import { storageContext } from './storageRevision';
import { withEngineErrors } from '../adapters/web/engineErrors';
/** フォルダの名前から、周を数えるコースを見つける (入っているコースは ID、自分のコースは保存フォルダ名か名前から作ったフォルダ名) */
export async function courseForFolder(folder: string): Promise<LapCourse | null> {
  await userCircuitStorage.ready.catch(() => undefined);
  const preset = CIRCUIT_PRESETS.find(p => p.id === folder && p.controlLine);
  // コース編集で直したコースを先に見る (入っているコースを直して保存したときも、その計測線・セクター線で数える)
  const edited = userCircuitStorage.getEditedCircuits().find(c =>
    courseFolder(c.name, c.folder) === folder || (!!preset && !c.folder && c.name === preset.name));
  if (edited) return { name: edited.name, controlLine: edited.controlLine, finishLine: edited.finishLine, sectors: edited.sectors };
  if (preset?.controlLine) return { name: preset.name, controlLine: preset.controlLine, sectors: preset.sectors };
  const own = userCircuitStorage.getAllCircuits().find(c => courseFolder(c.name, c.folder) === folder);
  return own ? { name: own.name, controlLine: own.controlLine, finishLine: own.finishLine, sectors: own.sectors } : null;
}


const history = createLapHistory(storageContext, folder => courseForFolder(folder), async () => { await loadStorageCourses(); await loadCsvFormats(); if (!csvFormatsReady()) throw fault('formats.unready', { ja: 'CSVの定義を読めませんでした。再読込みしてください。', en: 'Could not read CSV definitions. Reload the library.' }); }, runsFileStore, queueLapIndexWrite, () => ({ formats: currentCsvFormats(), physicsLevel: getGFilterLevel() }));
export const loadLapHistory: typeof history.loadLapHistory = withEngineErrors(history.loadLapHistory);
export const updateLapHidden: typeof history.updateLapHidden = withEngineErrors(history.updateLapHidden);
export const toggleLapHidden: typeof history.toggleLapHidden = withEngineErrors(history.toggleLapHidden);
