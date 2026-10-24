/**
 * 保管場所の digspice/ (デジスパイスのコースフォルダと同じ形: Circuit/*.pth・ControlLine/*.cln・Sector/*.sci) のコースデータを読む。2026-10-24。
 * 内蔵のコースと同じコースは、コース図 (.pth) だけを使い、計測線・セクター・コーナーの名前は内蔵のコースのものを使う
 * (circuitDatabase.ts の isShadowedByPreset)。内蔵のコースが無い場所のコースは、今までどおり自分のコースとして使う
 */

import { canUseRunStore, getRunStore } from './runStore';
import { userCircuitStorage, type CourseFile } from './userCircuitStorage';

const COURSE_FILE = /^digspice\/.+\.(cln|pth|sci)$/i;

/** 保管場所の digspice/ のコースデータを読み直す。読んだファイルの数 (保管場所が無ければ 0) */
export async function loadStorageCourses(): Promise<number> {
  if (!canUseRunStore()) return 0;
  const store = await getRunStore().catch(() => null);
  if (!store) return 0;
  const list = (await store.listAll().catch(() => [])).filter(f => COURSE_FILE.test(f.path) && f.size < 4 * 1024 * 1024);
  const decoder = new TextDecoder();
  const files: CourseFile[] = [];
  for (const f of list) {
    try {
      files.push({ path: f.path, text: decoder.decode(await store.read(f.path)) });
    } catch {
      // 読めないファイル (iCloud から落とせないなど) は飛ばす
    }
  }
  await userCircuitStorage.setStorageCourseFiles(files);
  return files.length;
}
