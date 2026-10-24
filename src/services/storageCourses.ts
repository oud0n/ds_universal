/**
 * 保管場所の course/ と digspice/ (デジスパイスのコースフォルダと同じ形: Circuit/*.pth・ControlLine/*.cln・Sector/*.sci) のコースデータを読む。2026-10-24。
 * 内蔵のコースと同じコースは、コース図 (.pth) だけを使い、計測線・セクター・コーナーの名前は内蔵のコースのものを使う
 * (circuitDatabase.ts の isShadowedByPreset)。内蔵のコースが無い場所のコースは、今までどおり自分のコースとして使う
 */

import { canUseRunStore, getRunStore } from './runStore';
import { userCircuitStorage, type CourseFile, type UserCircuitItem } from './userCircuitStorage';
import { COURSE_INDEX, courseFileKey, itemFromCourseFiles, markEditedCourseDeleted, mergeEditedCourses, parseCourseIndex, writeEditedCourse } from './courseFolderSync';

// digspice/ (デジスパイスのフォルダをそのまま置いたもの) と course/ (LapLoupe のコースフォルダ。同じ形)
const COURSE_FILE = /^(digspice|course)\/.+\.(cln|pth|sci)$/i;

/** 保管場所の digspice/ のコースデータを読み直す。読んだファイルの数 (保管場所が無ければ 0) */
export async function loadStorageCourses(): Promise<number> {
  if (!canUseRunStore()) return 0;
  const store = await getRunStore().catch(() => null);
  if (!store) return 0;
  // コース編集で保存したコース (course/courses.json に載っているもの) を、端末の中のコースと合わせる
  const indexed = await syncEditedCourses(store).catch(() => new Set<string>());
  // 保存・削除したら course/ に書く
  userCircuitStorage.onEditedChanged = e => {
    if (e.saved) void writeEditedCourse(store, e.saved).catch(() => undefined);
    if (e.deletedName) void markEditedCourseDeleted(store, e.deletedName).catch(() => undefined);
  };
  const list = (await store.listAll().catch(() => [])).filter(f => COURSE_FILE.test(f.path) && f.size < 4 * 1024 * 1024 && !indexed.has(f.path)
    && !(indexed === ALL_EDITED && /^course\/(ControlLine|Sector)\//.test(f.path)));
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

/** 一覧が読めないときの印: course/ の計測線・セクター線は、どれがコース編集のものか分からないので、読み込んだコースデータとしては使わない */
const ALL_EDITED = new Set<string>(['*']);

/** course/courses.json のコースと、端末の中のコース編集で保存したコースを合わせる。courses.json に載っているファイルの道を返す */
async function syncEditedCourses(store: NonNullable<Awaited<ReturnType<typeof getRunStore>>>): Promise<Set<string>> {
  // 読めない (無いのではなく。iCloud にだけある・ほかのアプリが開いている) ときは合わせない (空とみなすと、端末の中の古いコースで上書きするため)
  let idxText: string | null;
  try { idxText = await store.readTextStrict(COURSE_INDEX); } catch { return ALL_EDITED; }
  const idx = parseCourseIndex(idxText);
  const files = new Set<string>();
  const remote: Array<{ entry: (typeof idx.courses)[string]; item: UserCircuitItem | null }> = [];
  for (const e of Object.values(idx.courses)) {
    const cln = `course/ControlLine/${e.file}.cln`, sci = `course/Sector/${e.file}.sci`;
    files.add(cln);
    files.add(sci);
    let item: UserCircuitItem | null = null;
    if (!e.deleted) {
      try {
        const clnText = await store.readText(cln);
        if (clnText) item = itemFromCourseFiles(e, clnText, await store.readText(sci).catch(() => null));
      } catch { /* 読めないコースは端末の中のものを使う */ }
    }
    remote.push({ entry: e, item });
  }
  await userCircuitStorage.ready.catch(() => undefined);
  const { edited, upload } = mergeEditedCourses(userCircuitStorage.getEditedCircuits(), remote);
  await userCircuitStorage.setSyncedEdited(edited);
  for (const c of upload) {
    await writeEditedCourse(store, c.updatedAt ? c : { ...c, updatedAt: new Date(0).toISOString() }).catch(() => undefined);
    files.add(`course/ControlLine/${courseFileKey(c)}.cln`);
    files.add(`course/Sector/${courseFileKey(c)}.sci`);
  }
  return files;
}
