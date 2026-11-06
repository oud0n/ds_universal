import type { LapPickerChoice } from '../components/lapPickerRows';
import type { Session } from '../types/telemetry';
import { tr } from '../utils/i18n';
import { extractLaps } from './lapCalculator';
import { courseForFolder } from './lapHistory';
import { courseHash, isRunVideoName, LAP_INDEX_FILE, lapKey, parseLapIndex, type LapCourse, type LapRow } from './lapIndex';
import { findRunRow, isRunsConflictCopy, mergeRunsFiles, parseRunsFileStrict as parseRunsFile, noteRunsConflictCopies, RUNS_FILE } from './runsFile';
import {stampRunItem,type RunItem} from './runOpener';
import { getStorageRevision } from './storageCourses';

type StoredChoice = Extract<LapPickerChoice, { kind: 'stored' }>;

function onFolderCourse(session: Session, course: LapCourse) {
  const sameCourse = session.circuitName === course.name;
  return {
    ...session, ...extractLaps(session.points, course.controlLine, course.sectors),
    circuitName: course.name, controlLine: course.controlLine, finishLine: undefined,
    pathPolylines: sameCourse ? session.pathPolylines : undefined,
    pathPolylinesSource: sameCourse ? session.pathPolylinesSource : undefined,
  };
}

/** 一覧と同じく先頭点の UTC を基準にする。時刻の無いログにはまとまりごとに別の起点を置く。 */
function measuredLaps(sessions: Session[]) {
  return sessions.flatMap((session, index) => {
    const first = session.points[0];
    const utc = Date.parse(first?.timestamp ?? '');
    const origin = Number.isFinite(utc) ? utc : index * 1e9;
    return session.laps.filter(l => !l.isWholeSession && !l.isPartialLap).map((lap, i) => ({
      session, lap, record: {
        n: i + 1, part: sessions.length === 1 ? undefined : index + 1, time: lap.lapTime,
        startMs: Math.round(origin + (lap.startTime - first.time) * 1000),
        sectors: lap.sectors.map(s => s.time), topSpeed: lap.topSpeed,
      },
    }));
  });
}

function selectMeasuredLap(candidates: ReturnType<typeof measuredLaps>, row: LapRow) {
  const exact = candidates.find(({ record }) => record.n === row.n && (record.part ?? 1) === (row.part ?? 1) &&
    Math.abs(record.startMs - row.startMs) <= 50 && Math.abs(record.time - row.time) <= 0.01);
  if (exact) return { ...exact, moved: false };
  if (!candidates.length) throw new Error(tr('このコースで計測できる周がありません。', 'This run has no measured laps on this course.'));
  const nearest = candidates.reduce((a, b) => Math.abs(b.record.startMs - row.startMs) < Math.abs(a.record.startMs - row.startMs) ? b : a);
  return { ...nearest, moved: true };
}

/** 選んだ行を読み終えるまで画面を変更しない。ファイル・コースが変わった行は次の一覧で選び直す。 */
export async function prepareStoredLap(choice: StoredChoice, parse: (fileName: string, buffer: ArrayBuffer) => Promise<Session[]>, isCurrent: () => boolean) {
  const { row, store } = choice;
  const path = `${row.folder}/${row.file}`;
  const revision = choice.storageRevision;
  const check = () => {
    if (revision !== getStorageRevision() || !isCurrent()) throw new Error(tr('選択が変わりました。', 'Selection changed.'));
  };
  const checked = async <T>(operation: () => Promise<T>) => {
    check();
    try { return await operation(); } finally { check(); }
  };
  const changed = () => new Error(tr('走行またはコースが変わりました。一覧を読み直してください。', 'The run or course changed. Refresh the lap list.'));
  const list = async () => {
    const files = await checked(() => store.listAll());
    const file = files.find(f => f.path === path);
    if (!file || file.size !== choice.size || file.mtimeMs !== choice.mtimeMs) throw changed();
    return files;
  };
  const course = async () => {
    const current = await checked(() => courseForFolder(row.folder));
    if (!current || courseHash(current) !== choice.courseHash) throw changed();
    return current;
  };
  const readText = (name: string) => checked(() => store.readTextStrict(name));
  const listed = await list();
  const before = await course();
  const bytes = await checked(() => store.read(path));
  if (bytes.byteLength !== choice.size) throw changed();
  const fileName = row.file.slice(row.file.lastIndexOf('/') + 1);
  const parsed = await checked(() => parse(fileName, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));

  // この保管場所にある runs.json と競合の写しだけを合わせる。
  let runs = parseRunsFile(await readText(`${row.folder}/${RUNS_FILE}`));
  for (const file of listed) {
    const slash = file.path.lastIndexOf('/');
    if (file.path.slice(0, slash) === row.folder && isRunsConflictCopy(file.path.slice(slash + 1))) {
      runs = mergeRunsFiles(runs, parseRunsFile(await readText(file.path)));
    }
  }
  const entry = findRunRow(runs, row.file);
  const index = parseLapIndex(await readText(`${row.folder}/${LAP_INDEX_FILE}`));
  const files = await list();
  await course();
  check();
  noteRunsConflictCopies(row.folder,files.filter(f=>f.path.slice(0,f.path.lastIndexOf('/'))===row.folder&&isRunsConflictCopy(f.path.slice(f.path.lastIndexOf('/')+1))).map(f=>f.path),revision);

  const sessions = parsed.map((s, i) => ({
    ...onFolderCourse(s, before),
    sourceFile: { storageRevision: revision, folder: row.folder, file: row.file, part: i + 1,
      size: choice.size, mtimeMs: choice.mtimeMs, courseHash: choice.courseHash },
    sessionName: entry?.name ? (i ? `${entry.name} (${i + 1})` : entry.name) : s.sessionName,
    runNote: entry?.note ?? s.runNote, vehicleName: (entry?.reference ? entry.reference.car : entry?.car) ?? s.vehicleName,
  }));
  const candidates = measuredLaps(sessions);
  const { session, lap, moved, record } = selectMeasuredLap(candidates, row);
  const cached = index?.files[row.file];
  const freshIndex = index?.courseHash === choice.courseHash && cached?.size === choice.size && cached.mtimeMs === choice.mtimeMs;
  const hidden = new Set(freshIndex ? index.hidden.filter(h => h.file === row.file).map(h => lapKey(h.file, h.part, h.n)) : []);
  if (!freshIndex && row.hidden) hidden.add(lapKey(row.file, record.part, record.n));
  const laps = candidates.map(({ record }) => ({ ...record, hidden: hidden.has(lapKey(row.file, record.part, record.n)) }));
  const visible = laps.filter(l => !l.hidden);
  const dir = path.slice(0, path.lastIndexOf('/'));
  const videosIn = (folder: string) => files.filter(f => f.path.startsWith(folder + '/') && isRunVideoName(f.path.slice(folder.length + 1)));
  const item: RunItem = {
    storageRevision: revision,
    folder: row.folder, file: row.file, courseName: before.name, laps, startMs: row.runStartMs,
    lapCount: visible.length, best: visible.length ? Math.min(...visible.map(l => l.time)) : null,
    videos: entry?.videos?.map(v => v.name) ?? (freshIndex ? cached.videos ?? [] : []),
    folderVideos: [...(dir === row.folder ? [] : videosIn(row.folder)), ...videosIn(dir)],
    synced: !!entry?.videos?.some(v => !!v.clock), entry, pending: false,
  };
  stampRunItem(store,item);
  return { sessions, session, lap, moved, item, revalidate: async () => { await course(); await list(); check(); } };
}
