/**
 * 保管場所の course/ と digspice/ (デジスパイスのコースフォルダと同じ形: Circuit/*.pth・ControlLine/*.cln・Sector/*.sci) のコースデータを読む。2026-10-24。
 * 内蔵のコースと同じコースは、コース図 (.pth) だけを使い、計測線・セクター・コーナーの名前は内蔵のコースのものを使う
 * (circuitDatabase.ts の isShadowedByPreset)。内蔵のコースが無い場所のコースは、今までどおり自分のコースとして使う
 */

import { loadCsvFormats } from './csvFormatStore';
import { canUseRunStore, getRunStore } from './runStore';
import { clearCourseCornersCache } from './courseCorners';
import { getStorageReadRevision, invalidateStorageReads, isStorageSelectionPending, subscribeStorageRevision, StorageChangedError } from './storageRevision';
import { userCircuitStorage, type CourseFile, type UserCircuitItem } from './userCircuitStorage';
import { COURSE_INDEX, courseFileKey, itemFromCourseFiles, markEditedCourseDeleted, mergeEditedCourses, parseCourseIndex, writeEditedCourse } from './courseFolderSync';

// digspice/ (デジスパイスのフォルダをそのまま置いたもの) と course/ (LapLoupe のコースフォルダ。同じ形)
const COURSE_FILE = /^(digspice|course)\/.+\.(cln|pth|sci)$/i;
const fallback = <T>(error: unknown, value: T): T => {
  if (error instanceof StorageChangedError) throw error;
  return value;
};

export { getStorageRevision, getStorageReadRevision, isStorageSelectionPending, subscribeStorageRevision, subscribeBeforeStorageSelection, invalidateStorageRevision, trackStorageSelection, pickDesktopStorage } from './storageRevision';

/** 保管場所を選んだ・変えたとき: その保管場所のコースデータ・コーナーの名前を読み直す */
export async function storageFolderChanged(): Promise<void> {
  invalidateStorageReads();
  clearCourseCornersCache();
  try { await loadStorageCourses(); } catch (error) {
    // 取消後のコース再試行が終わるまで、旧要求から後続の読込みを始めない。
    if (error instanceof StorageChangedError) return;
  }
  // CSV の形式の定義・計算式も、新しい保管場所のものにする (PLAN-36)
  await loadCsvFormats().catch(() => undefined);
  invalidateStorageReads();
}

/** 保管場所の digspice/ のコースデータを読み直す。読んだファイルの数 (保管場所が無ければ 0) */
let courseLoad: { reads: number; promise: Promise<number> } | null = null;
let courseRetryNeeded = false;
let courseRetryQueued = false;
function retryCourses(): void {
  if (!courseRetryNeeded || courseRetryQueued || isStorageSelectionPending()) return;
  courseRetryQueued = true;
  queueMicrotask(() => {
    courseRetryQueued = false;
    if (!courseRetryNeeded || isStorageSelectionPending()) return;
    const reads = getStorageReadRevision();
    void loadStorageCourses().then(() => {
      if (reads === getStorageReadRevision() && !isStorageSelectionPending()) invalidateStorageReads();
    }, () => undefined);
  });
}
subscribeStorageRevision(retryCourses);

/** 同じ期間の読込みを共有し、中断した最新の要求は選択終了後にやり直す。 */
export function loadStorageCourses(): Promise<number> {
  const reads = getStorageReadRevision();
  if (courseLoad?.reads === reads) return courseLoad.promise;
  courseRetryNeeded = false;
  const request = { reads, promise: loadStorageCoursesNow(reads) };
  courseLoad = request;
  void request.promise.catch(error => {
    if (courseLoad !== request) return;
    courseLoad = null;
    if (error instanceof StorageChangedError) { courseRetryNeeded = true; retryCourses(); }
  });
  return request.promise;
}

async function loadStorageCoursesNow(reads: number): Promise<number> {
  if (!canUseRunStore()) return 0;
  const check = () => { if (reads !== getStorageReadRevision()) throw new StorageChangedError(); };
  const store = await getRunStore().catch(() => null);
  check();
  if (!store) {
    // 保管場所が無くなった (外した) ときは、前の保管場所のコースデータを使わない
    userCircuitStorage.onEditedChanged = undefined;
    await userCircuitStorage.setStorageCourseFiles([], check);
    check();
    return 0;
  }
  // コース編集で保存したコース (course/courses.json に載っているもの) を、端末の中のコースと合わせる
  const indexed = await syncEditedCourses(store, check).catch(error => fallback(error, new Set<string>()));
  check();
  // 保存・削除したら course/ に書く
  userCircuitStorage.onEditedChanged = e => {
    if (e.saved) void writeEditedCourse(store, e.saved).catch(() => undefined);
    if (e.deletedName) void markEditedCourseDeleted(store, e.deletedName).catch(() => undefined);
  };
  const list = (await store.listAll().catch(error => fallback(error, []))).filter(f => COURSE_FILE.test(f.path) && f.size < 4 * 1024 * 1024 && !indexed.has(f.path)
    && !(indexed === ALL_EDITED && /^course\/(ControlLine|Sector)\//.test(f.path)));
  const decoder = new TextDecoder();
  const files: CourseFile[] = [];
  // いくつか同時に読む (iCloud にだけあるときは 1 つずつ取り込みを待つので、順番に読むと、200 個ほどで何分もかかっていた)
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const f = list[next++];
      try {
        files.push({ path: f.path, text: decoder.decode(await store.read(f.path)) });
      } catch (error) {
        if (error instanceof StorageChangedError) throw error;
        // 読めないファイル (iCloud から落とせないなど) は飛ばす
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
  // 読む順で結果が変わらないよう、道の順にそろえる
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  await userCircuitStorage.setStorageCourseFiles(files, check);
  check();
  return files.length;
}

/** 一覧が読めないときの印: course/ の計測線・セクター線は、どれがコース編集のものか分からないので、読み込んだコースデータとしては使わない */
const ALL_EDITED = new Set<string>(['*']);

/** course/courses.json のコースと、端末の中のコース編集で保存したコースを合わせる。courses.json に載っているファイルの道を返す */
async function syncEditedCourses(store: NonNullable<Awaited<ReturnType<typeof getRunStore>>>, check: () => void): Promise<Set<string>> {
  // 読めない (無いのではなく。iCloud にだけある・ほかのアプリが開いている) ときは合わせない (空とみなすと、端末の中の古いコースで上書きするため)
  let idxText: string | null;
  try { idxText = await store.readTextStrict(COURSE_INDEX); } catch (error) { return fallback(error, ALL_EDITED); }
  const idx = parseCourseIndex(idxText);
  const files = new Set<string>();
  const remote: Array<{ entry: (typeof idx.courses)[string]; item: UserCircuitItem | null }> = [];
  for (const e of Object.values(idx.courses)) {
    const cln = `course/ControlLine/${e.file}.cln`, sci = `course/Sector/${e.file}.sci`;
    files.add(cln);
    files.add(sci);
    // ほかの鍵へ移したコースの前のファイル: 使わない
    if (e.moved) continue;
    let item: UserCircuitItem | null = null;
    if (!e.deleted) {
      try {
        // セクター線も、読めない (iCloud にだけある) ときは読めたことにしない (セクターの無いコースとして端末に覚え、あとで直したときに消してしまうため)
        const clnText = await store.readTextStrict(cln);
        if (clnText) item = itemFromCourseFiles(e, clnText, await store.readTextStrict(sci));
      } catch (error) { fallback(error, undefined); /* 読めないコースは端末の中のものを使う */ }
    }
    remote.push({ entry: e, item });
  }
  await userCircuitStorage.ready.catch(() => undefined);
  check();
  const { edited, upload } = mergeEditedCourses(userCircuitStorage.getEditedCircuits(), remote);
  await userCircuitStorage.setSyncedEdited(edited, check);
  for (const c of upload) {
    check();
    await writeEditedCourse(store, c.updatedAt ? c : { ...c, updatedAt: new Date(0).toISOString() }, check).catch(error => fallback(error, undefined));
    files.add(`course/ControlLine/${courseFileKey(c)}.cln`);
    files.add(`course/Sector/${courseFileKey(c)}.sci`);
  }
  return files;
}
