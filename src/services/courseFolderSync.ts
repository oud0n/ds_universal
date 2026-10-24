/**
 * コース編集で直したコースを、保管場所の course/ に書いて、端末の間で共有する (2026-10-24)。
 *
 * course/ControlLine/<鍵>.cln (計測線)・course/Sector/<鍵>.sci (セクター線。計測線・ゴールの線は含めない。デジスパイスと同じ形)と、
 * course/courses.json (名前・英語名・記録のフォルダ名・ゴールの線・書いた時刻。消したコースは deleted の印) に置く。
 * 鍵は記録のフォルダ名 (無ければ名前から作る)。
 *
 * - 保存・削除したら書く (userCircuitStorage の onEditedChanged)
 * - 起動したときに読み、端末の中のコースと合わせる (同じ名前なら書いた時刻の新しいほう)。端末の中にだけあるコースは書く
 * - courses.json に載っているファイルは、読み込んだコースデータ (デジスパイスのコースなど) としては使わない
 */

import type { ControlLine, Sector } from '../types/telemetry';
import { exportCln, parseCln, parseSci } from './pthParser';
import type { RunStore } from './runStore';
import { exportSci, type UserCircuitItem } from './userCircuitStorage';

export const COURSE_INDEX = 'course/courses.json';

export interface CourseIndexEntry {
  name: string;
  /** ControlLine/<file>.cln・Sector/<file>.sci */
  file: string;
  nameEn?: string;
  folder?: string;
  finishLine?: ControlLine;
  updatedAt: string;
  deleted?: boolean;
  [key: string]: unknown;
}

export interface CourseIndex {
  version: 1;
  courses: Record<string, CourseIndexEntry>;
  [key: string]: unknown;
}

const FILE_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

/** コースの鍵 (ファイル名)。記録のフォルダ名、無ければ名前から */
export function courseFileKey(item: Pick<UserCircuitItem, 'name' | 'folder'>): string {
  if (item.folder && FILE_RE.test(item.folder)) return item.folder;
  let h = 0;
  for (const ch of item.name) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `c_${h.toString(36)}`;
}

export function parseCourseIndex(text: string | null): CourseIndex {
  try {
    const v = text ? JSON.parse(text) : null;
    if (v && v.version === 1 && v.courses && typeof v.courses === 'object') {
      const courses: Record<string, CourseIndexEntry> = {};
      for (const [k, e] of Object.entries(v.courses as Record<string, CourseIndexEntry>)) {
        if (e && typeof e.name === 'string' && typeof e.file === 'string' && FILE_RE.test(e.file) && typeof e.updatedAt === 'string') courses[k] = e;
      }
      return { ...v, version: 1, courses };
    }
  } catch { /* 壊れていれば空 */ }
  return { version: 1, courses: {} };
}

const sameLine = (a: Sector | ControlLine, b?: ControlLine) => !!b &&
  Math.abs(a.latA - b.latA) < 1e-7 && Math.abs(a.lonA - b.lonA) < 1e-7 && Math.abs(a.latB - b.latB) < 1e-7 && Math.abs(a.lonB - b.lonB) < 1e-7;

/** 書くファイルの中身 */
export function courseFiles(item: UserCircuitItem): { cln: string; sci: string } {
  return {
    cln: exportCln(item.controlLine),
    // ゴールの線 (スタートとゴールが別のコース) も、計測線と同じく .sci には入れない (courses.json に持つ)
    sci: exportSci(item.sectors.filter(s => !sameLine(s, item.finishLine)), item.controlLine)
  };
}

/** course/ のファイルから、コース編集で保存したコースを作る */
export function itemFromCourseFiles(e: CourseIndexEntry, clnText: string, sciText: string | null): UserCircuitItem {
  const cl = parseCln(clnText, e.name);
  const gates = sciText ? parseSci(sciText, e.file) : [];
  const fin = e.finishLine ?? cl;
  const sectors: Sector[] = gates.length || e.finishLine
    ? [...gates.map((g, i) => ({ ...g, id: `${e.file}_s${i + 1}`, name: `S${i + 1}` })), { latA: fin.latA, lonA: fin.lonA, latB: fin.latB, lonB: fin.lonB, id: `${e.file}_finish`, name: `S${gates.length + 1}` }]
    : [];
  return {
    id: `edited:${e.name}`,
    name: e.name,
    controlLine: { ...cl, name: e.name },
    sectors,
    sources: { cln: 'edited' },
    ...(e.nameEn && e.folder ? { nameEn: e.nameEn, folder: e.folder } : {}),
    ...(e.finishLine ? { finishLine: { ...e.finishLine, name: 'Finish Line' } } : {}),
    updatedAt: e.updatedAt
  };
}

/** course/courses.json の書き換えは 1 つずつ */
let indexWrites: Promise<unknown> = Promise.resolve();

async function updateIndex(store: RunStore, change: (idx: CourseIndex) => void): Promise<void> {
  const run = async () => {
    // 読めないとき (無いのではなく) は書かない (ほかの端末のコースの行を消さないように)
    const text = await store.readTextStrict(COURSE_INDEX);
    const idx = parseCourseIndex(text);
    change(idx);
    await store.writeText(COURSE_INDEX, JSON.stringify(idx, null, 1));
  };
  const next = indexWrites.then(run, run);
  indexWrites = next.catch(() => undefined);
  return next;
}

/** コースを course/ に書く */
export async function writeEditedCourse(store: RunStore, item: UserCircuitItem): Promise<void> {
  // 一覧 (courses.json) が読めない (iCloud からまだ落ちてきていないなど) ときは、計測線・セクター線も書かない
  // (読めない一覧を空とみなして書くと、ほかの端末で直した新しいコースのファイルを、古い中身で上書きするため)
  await store.readTextStrict(COURSE_INDEX);
  const file = courseFileKey(item);
  const { cln, sci } = courseFiles(item);
  await store.writeText(`course/ControlLine/${file}.cln`, cln);
  await store.writeText(`course/Sector/${file}.sci`, sci);
  await updateIndex(store, idx => {
    // 同じ名前の前の行 (鍵が変わったとき) は外す
    for (const [k, e] of Object.entries(idx.courses)) if (e.name === item.name && k !== file) delete idx.courses[k];
    const prev = idx.courses[file];
    idx.courses[file] = {
      ...prev,
      name: item.name,
      file,
      ...(item.nameEn ? { nameEn: item.nameEn } : {}),
      ...(item.folder ? { folder: item.folder } : {}),
      ...(item.finishLine ? { finishLine: { name: 'Finish Line', latA: item.finishLine.latA, lonA: item.finishLine.lonA, latB: item.finishLine.latB, lonB: item.finishLine.lonB } } : {}),
      updatedAt: item.updatedAt ?? new Date().toISOString(),
      deleted: undefined
    };
    if (!item.finishLine) delete idx.courses[file].finishLine;
    delete idx.courses[file].deleted;
  });
}

/** 消したことを course/courses.json に書く (ほかの端末でも消す。ファイルは残す) */
export async function markEditedCourseDeleted(store: RunStore, name: string): Promise<void> {
  await updateIndex(store, idx => {
    for (const e of Object.values(idx.courses)) if (e.name === name) { e.deleted = true; e.updatedAt = new Date().toISOString(); }
  });
}

/**
 * course/ のコースと端末の中のコースを合わせる。
 * 返すもの: 端末で使うコース (edited)、course/ に書くべき端末の中のコース、読み込んだコースデータとして使わないファイルの道
 */
export function mergeEditedCourses(
  local: UserCircuitItem[],
  remote: Array<{ entry: CourseIndexEntry; item: UserCircuitItem | null }>
): { edited: UserCircuitItem[]; upload: UserCircuitItem[] } {
  const t = (s?: string) => { const v = s ? Date.parse(s) : NaN; return Number.isFinite(v) ? v : 0; };
  const out = new Map(local.map(c => [c.name, c]));
  const upload: UserCircuitItem[] = [];
  for (const { entry, item } of remote) {
    const mine = out.get(entry.name);
    // 端末の中のほうが新しければ、端末のものを使い、あとで書く
    if (mine && t(mine.updatedAt) > t(entry.updatedAt)) continue;
    if (entry.deleted) { out.delete(entry.name); continue; }
    if (item) out.set(entry.name, mine?.polylines && !item.polylines ? { ...item, polylines: mine.polylines } : item);
  }
  const remoteNames = new Set(remote.map(r => r.entry.name));
  for (const c of out.values()) {
    const r = remote.find(x => x.entry.name === c.name);
    if (!remoteNames.has(c.name) || (r && t(c.updatedAt) > t(r.entry.updatedAt))) upload.push(c);
  }
  // 書いた時刻の順に並べる (同じ場所に複数あるときは、あとに書いたものを使うため)
  return { edited: [...out.values()].sort((a, b) => t(a.updatedAt) - t(b.updatedAt)), upload };
}
