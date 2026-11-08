import { loadLapHistory, type LapFolder } from '../services/lapHistory';
import type { LapRow } from '../services/lapIndex';
import type { RunStore } from '../services/runStore';
import { getStorageRevision } from '../services/storageCourses';
import { filterOptions, effectiveFilter, matchesFilter, type ConditionFilter, type RunConditions } from '../services/runFilters';
import type { Lap, Session } from '../types/telemetry';

export type LapPickerChoice =
  | { kind: 'loaded'; session: Session; lap: Lap }
  | { kind: 'stored'; store: RunStore; storageRevision: number; row: LapRow; courseHash: string; size: number; mtimeMs: number };

/** 途中で閉じた一覧や読み取り失敗が、新しい保管場所の控えを書き換えないようにする。 */
export async function readPickerHistory(store: RunStore, signal: AbortSignal, revision = getStorageRevision()): Promise<LapFolder[]> {
  let failure: Error | undefined;
  const check = () => {
    if (signal.aborted || revision !== getStorageRevision()) throw new Error('Cancelled');
    if (failure) throw failure;
  };
  async function read<T>(operation: () => Promise<T>): Promise<T> {
    check();
    try {
      return await operation();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      throw failure;
    }
  }
  const folders = await loadLapHistory({
    list: () => read(() => store.list()),
    read: path => read(() => store.read(path)),
    readText: path => read(() => store.readTextStrict(path)),
    writeText: (path, text) => {
      check();
      return store.writeText(path, text);
    }
  });
  check();
  return folders;
}

export interface PickerRow {
  key: string;
  run: string;
  runName: string;
  date: number | null;
  number: string;
  time: number;
  hidden: boolean;
  reference?: string;
  conditions: RunConditions;
  choice: LapPickerChoice;
}

export function storedPickerRows(folder: LapFolder, store: RunStore, storageRevision: number): PickerRow[] {
  const index = folder.index;
  if (!index) return [];
  return folder.rows.map(row => {
    const record = index.files[row.file];
    const date = row.runStartMs === null ? NaN : new Date(row.runStartMs).getTime();
    return {
      key: JSON.stringify([row.folder, row.file, row.part, row.n]),
      run: row.file, runName: folder.names?.[row.file] || row.file, date: Number.isFinite(date) ? date : null,
      number: row.part ? `${row.part}-L${row.n}` : `L${row.n}`,
      time: row.time, hidden: row.hidden, reference: folder.references?.[row.file],
      conditions: folder.conditions?.[row.file] ?? {},
      choice: { kind: 'stored', store, storageRevision, row, courseHash: index.courseHash, size: record.size, mtimeMs: record.mtimeMs }
    };
  });
}

export function loadedPickerRows(sessions: Session[]): PickerRow[] {
  return sessions.flatMap(session => {
    const date = Date.parse(session.points[0]?.timestamp || session.date);
    return session.laps.map(lap => ({
      key: JSON.stringify([session.id, lap.lapNumber]), run: session.id,
      runName: session.sessionName || session.fileName, date: Number.isFinite(date) ? date : null,
      number: `L${lap.lapNumber}`, time: lap.lapTime, hidden: false,
      conditions: { car: session.vehicleName }, choice: { kind: 'loaded' as const, session, lap }
    }));
  });
}

export function pickerTable(rows: PickerRow[], filter: ConditionFilter, showHidden: boolean, order: 'time' | 'date') {
  const runs = new Map(rows.map(r => [r.run, r.conditions]));
  const options = filterOptions([...runs.values()]);
  const currentFilter = effectiveFilter(filter, options);
  const matching = rows.filter(r => matchesFilter(r.conditions, currentFilter));
  const times = [...new Set(matching.filter(r => r.choice.kind === 'stored' && !r.hidden && r.reference === undefined)
    .map(r => r.time))].sort((a, b) => a - b).slice(0, 3);
  const visible = matching.filter(r => showHidden || !r.hidden).sort((a, b) =>
    (order === 'time' ? a.time - b.time : 0) || (b.date ?? -Infinity) - (a.date ?? -Infinity) || a.run.localeCompare(b.run));
  return { options, currentFilter, times, visible };
}
