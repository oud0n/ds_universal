import { fault } from './errors';
import type { SelectedCarSlot, Session } from '../types/telemetry';
import { runKey, type RunRow } from './runsFile';

export interface AnalysisState {
  sessions: Session[];
  selectedCars: SelectedCarSlot[];
}

/** App ごとの解析状態。直前の割り当てを含む一覧で検証し、成功してからまとめて知らせる。 */
export function createAnalysisStore(initial: AnalysisState = { sessions: [], selectedCars: [] }) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    getSessions: () => snapshot.sessions,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(change: (current: AnalysisState) => AnalysisState): AnalysisState {
      const next = change(snapshot);
      if (next !== snapshot) {
        snapshot = next;
        for (const listener of listeners) listener();
      }
      return next;
    }
  };
}

const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b'];

/** 保管場所の走行は分割された全セッションで一組。直接開いたログはセッションごとに扱う。 */
function sourceKey(session: Session): string {
  const file = session.sourceFile;
  return file ? JSON.stringify(['file', file.storageRevision, file.folder, file.file, file.size, file.mtimeMs]) : JSON.stringify(['open', session.id]);
}

/** 選び終わった一覧へ反映し、Car と保存のために指定された元走行を開いておく。 */
export function assignLap(state: AnalysisState, incoming: Session[], sessionId: string, lapNumber: number, slot: number, releaseUnused = true, retainedSessionIds: readonly string[] = []): AnalysisState {
  if (!Number.isInteger(slot) || slot < 0 || slot >= colors.length) {
    throw fault('lapAssignmentState.1', { ja: 'Car 1〜4 を選んでください。', en: 'Choose Car 1 through Car 4.' }, true);
  }
  const merged = new Map(state.sessions.map(session => [session.id, session]));
  for (const session of incoming) merged.set(session.id, session);
  const conflicts = (owner: Session) => {
    const origin = owner.sourceFile;
    return !!origin && incoming.some(s => {
      const next = s.sourceFile;
      return next && next.storageRevision === origin.storageRevision && next.folder === origin.folder && next.file === origin.file
        && (next.size !== origin.size || next.mtimeMs !== origin.mtimeMs);
    });
  };
  const session = merged.get(sessionId);
  if (!session?.laps.some(lap => lap.lapNumber === lapNumber)) {
    throw fault('lapAssignmentState.2', { ja: 'この走行またはラップは閉じたか変更されました。', en: 'This run or lap was closed or changed.' });
  }

  const slots = new Map(state.selectedCars.map(car => [car.slot, car]));
  slots.set(slot, { slot, sessionId, lapNumber, colorHex: colors[slot], label: '' });
  const keep = new Set<string>();
  const selectedCars: SelectedCarSlot[] = [];
  for (const [index, car] of [...slots].sort(([a], [b]) => a - b)) {
    if (!Number.isInteger(index) || index < 0 || index >= colors.length) continue;
    const owner = merged.get(car.sessionId);
    if (!owner?.laps.some(lap => lap.lapNumber === car.lapNumber)) {
      const former = state.sessions.find(item => item.id === car.sessionId);
      if (former?.laps.some(lap => lap.lapNumber === car.lapNumber)) {
        throw fault('lapAssignmentState.3', { ja: `Car ${index + 1} のラップが読み直した走行にありません。`, en: `The updated run no longer contains the lap used by Car ${index + 1}.` });
      }
      continue;
    }
    if (conflicts(owner)) {
      throw fault('lapAssignmentState.4', { ja: `Car ${index + 1} の元ファイルが変わりました。先に古い走行を外してください。`, en: `The source used by Car ${index + 1} changed. Remove the old run first.` });
    }
    const former = state.sessions.find(item => item.id === car.sessionId);
    if (index !== slot && former && former !== owner) {
      const before = former.laps.find(lap => lap.lapNumber === car.lapNumber);
      const after = owner.laps.find(lap => lap.lapNumber === car.lapNumber)!;
      if (before && (Math.abs(before.startTime - after.startTime) > 0.05 || Math.abs(before.endTime - after.endTime) > 0.05)) {
        throw fault('lapAssignmentState.5', { ja: `Car ${index + 1} の周の範囲が変わりました。選び直してください。`, en: `The lap used by Car ${index + 1} changed. Select it again.` });
      }
    }
    keep.add(sourceKey(owner));
    const label = `${owner.sessionName} (L${car.lapNumber})`;
    selectedCars.push(label === car.label ? car : { ...car, label });
  }
  for (const id of retainedSessionIds) {
    const owner = state.sessions.find(s => s.id === id);
    if (!owner) continue;
    if (conflicts(owner)) throw fault('lapAssignmentState.6', { ja: '動画に使っている走行の元ファイルが変わりました。開いている走行を閉じてから選び直してください。', en: 'The source used by the video changed. Close that run before selecting it again.' });
    keep.add(sourceKey(owner));
  }
  return { sessions: [...merged.values()].filter(item => !releaseUnused || keep.has(sourceKey(item))), selectedCars };
}

/** 同じ元ファイルを解析し直しても、同期の調整と手動のコース図は引き継ぐ。コースの署名は解析条件でありファイルの ID ではない。 */
export function reuseStoredSessions(prior: Session[], incoming: Session[]): Session[] {
  return incoming.map(session => {
    const f = session.sourceFile;
    if (!f) return session;
    if (prior.some(s => {
      const p = s.sourceFile;
      return p && p.storageRevision === f.storageRevision && p.folder === f.folder && runKey(p.file) === runKey(f.file) && p.file !== f.file;
    })) throw fault('lapAssignmentState.7', { ja: '同じ走行の別形式が開いています。先に閉じてください。', en: 'Another format of this run is open. Close it first.' });
    const old = prior.find(s => {
      const p = s.sourceFile;
      return p && p.storageRevision === f.storageRevision && p.folder === f.folder && p.file === f.file
        && p.part === f.part && p.size === f.size && p.mtimeMs === f.mtimeMs;
    });
    if (!old) return session;
    const keepPath = old.pathPolylinesSource === 'manual' || old.sourceFile!.courseHash === f.courseHash;
    return { ...session, id: old.id, clockOffsetSec: old.clockOffsetSec,
      sessionName: old.sessionName, runNote: old.runNote, vehicleName: old.vehicleName,
      ...(keepPath && old.pathPolylines ? { pathPolylines: old.pathPolylines, pathPolylinesSource: old.pathPolylinesSource } : {}) };
  });
}

/** 保存待ちの編集は共有する行から取り、解析前に読んだ古い控えで戻さない。 */
export function applyRunMetadata(sessions: Session[], entry: RunRow | null): Session[] {
  if (!entry) return sessions;
  const car = entry.reference ? entry.reference.car : entry.car;
  return sessions.map((session, i) => ({ ...session,
    ...(entry.name ? { sessionName: i ? `${entry.name} (${i + 1})` : entry.name } : {}),
    runNote: entry.note, vehicleName: car ?? session.vehicleName }));
}

/** 保存した比べ方も、採用する瞬間に存在する走行と周だけを割り当てる。 */
export function selectAvailableCars(state: AnalysisState, cars: SelectedCarSlot[]): AnalysisState {
  const valid = new Map<number, SelectedCarSlot>();
  for (const car of cars) {
    const session = state.sessions.find(s => s.id === car.sessionId);
    if (!Number.isInteger(car.slot) || car.slot < 0 || car.slot > 3 || !session?.laps.some(l => l.lapNumber === car.lapNumber)) continue;
    valid.set(car.slot, { ...car, label: `${session.sessionName} (L${car.lapNumber})` });
  }
  return { ...state, selectedCars: [...valid.values()].sort((a, b) => a.slot - b.slot) };
}
