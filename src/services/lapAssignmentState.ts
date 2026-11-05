import type { SelectedCarSlot, Session } from '../types/telemetry';
import { tr } from '../utils/i18n';

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

/** 選び終わった時点の一覧へ反映し、Car 1〜4 に残った走行だけを開いておく。 */
export function assignLap(state: AnalysisState, incoming: Session[], sessionId: string, lapNumber: number, slot: number, releaseUnused = true): AnalysisState {
  if (!Number.isInteger(slot) || slot < 0 || slot >= colors.length) {
    throw new RangeError(tr('Car 1〜4 を選んでください。', 'Choose Car 1 through Car 4.'));
  }
  const merged = new Map(state.sessions.map(session => [session.id, session]));
  for (const session of incoming) merged.set(session.id, session);
  const session = merged.get(sessionId);
  if (!session?.laps.some(lap => lap.lapNumber === lapNumber)) {
    throw new Error(tr('この走行またはラップは閉じたか変更されました。', 'This run or lap was closed or changed.'));
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
        throw new Error(tr(`Car ${index + 1} のラップが読み直した走行にありません。`, `The updated run no longer contains the lap used by Car ${index + 1}.`));
      }
      continue;
    }
    const origin = owner.sourceFile;
    if (origin && incoming.some(s => {
      const next = s.sourceFile;
      return next && next.storageRevision === origin.storageRevision && next.folder === origin.folder && next.file === origin.file
        && (next.size !== origin.size || next.mtimeMs !== origin.mtimeMs);
    })) {
      throw new Error(tr(`Car ${index + 1} の元ファイルが変わりました。先に古い走行を外してください。`, `The source used by Car ${index + 1} changed. Remove the old run first.`));
    }
    const former = state.sessions.find(item => item.id === car.sessionId);
    if (index !== slot && former && former !== owner) {
      const before = former.laps.find(lap => lap.lapNumber === car.lapNumber);
      const after = owner.laps.find(lap => lap.lapNumber === car.lapNumber)!;
      if (before && (Math.abs(before.startTime - after.startTime) > 0.05 || Math.abs(before.endTime - after.endTime) > 0.05)) {
        throw new Error(tr(`Car ${index + 1} の周の範囲が変わりました。選び直してください。`, `The lap used by Car ${index + 1} changed. Select it again.`));
      }
    }
    keep.add(sourceKey(owner));
    const label = `${owner.sessionName} (L${car.lapNumber})`;
    selectedCars.push(label === car.label ? car : { ...car, label });
  }
  return { sessions: [...merged.values()].filter(item => !releaseUnused || keep.has(sourceKey(item))), selectedCars };
}

/** 同じ元ファイルを解析し直しても、同期の調整と手動のコース図は引き継ぐ。コースの署名は解析条件でありファイルの ID ではない。 */
export function reuseStoredSessions(prior: Session[], incoming: Session[]): Session[] {
  return incoming.map(session => {
    const f = session.sourceFile;
    if (!f) return session;
    const old = prior.find(s => {
      const p = s.sourceFile;
      return p && p.storageRevision === f.storageRevision && p.folder === f.folder && p.file === f.file
        && p.part === f.part && p.size === f.size && p.mtimeMs === f.mtimeMs;
    });
    if (!old) return session;
    const keepPath = old.pathPolylinesSource === 'manual' || old.sourceFile!.courseHash === f.courseHash;
    return { ...session, id: old.id, clockOffsetSec: old.clockOffsetSec,
      ...(keepPath && old.pathPolylines ? { pathPolylines: old.pathPolylines, pathPolylinesSource: old.pathPolylinesSource } : {}) };
  });
}
