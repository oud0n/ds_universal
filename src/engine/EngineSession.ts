import type { Session, SelectedCarSlot } from '../types/telemetry';
import type { RunItem } from './runRecords';
import { assignLap, selectAvailableCars, type AnalysisState } from './lapAssignmentState';
import { asSessionSec, type SessionSec } from './playbackPosition';
import { createStorageContext, type StorageContext } from './storageContext';

export interface Playhead { source: string | null; sessionSec: SessionSec }
export interface EngineSnapshot { analysis: AnalysisState; playhead: Playhead; isPlaying: boolean; playbackSpeed: number }
type Change<T> = T | ((current: T) => T);

/** 画面やホストを持たない、アプリ一つ分の正本。UIはこのインスタンスを購読する。 */
export function createEngineSession(options: { storage?: StorageContext; flush?: () => Promise<void> } = {}) {
  let snapshot: EngineSnapshot = { analysis: { sessions: [], selectedCars: [] }, playhead: { source: null, sessionSec: asSessionSec(0) }, isPlaying: false, playbackSpeed: 1 };
  const listeners = new Set<() => void>();
  const storage = options.storage ?? createStorageContext();
  const operations = {
    pickerActive: { current: false }, slotRequests: { current: [0, 0, 0, 0] }, selectionEpoch: { current: 0 }, manualSelection: { current: 0 },
    pendingParses: { current: new Map<string, { readers: number; parsed?: Promise<Session[]> }>() },
    savedOpening: { current: false }, runOpening: { current: false },
    runSessions: { current: new Map<string, string[]>() }, runItems: { current: new Map<string, RunItem>() },
    attachedRun: { current: null as string | null }, openedRun: { current: null as string | null }, runDownloadToken: { current: 0 }
  };
  const publish = (next: EngineSnapshot) => { if (next === snapshot) return; snapshot = next;for (const listener of listeners) listener(); };
  const subscribe = (listener: () => void) => { listeners.add(listener);return () => { listeners.delete(listener); }; };
  const analysis = {
    getSnapshot: () => snapshot.analysis,
    getSessions: () => snapshot.analysis.sessions,
    subscribe,
    update(change: (state: AnalysisState) => AnalysisState): AnalysisState {
      const next = change(snapshot.analysis);
      if (next !== snapshot.analysis) publish({ ...snapshot, analysis: next });
      return next;
    }
  };
  const setPlayhead = (change: Change<Playhead>) => {
    const next = typeof change === 'function' ? change(snapshot.playhead) : change;
    if (!Number.isFinite(next.sessionSec)) return;
    if (next.source !== snapshot.playhead.source || next.sessionSec !== snapshot.playhead.sessionSec) publish({ ...snapshot, playhead: next });
  };
  const selectCarsAtLapStart = (cars: SelectedCarSlot[]) => {
    const next = selectAvailableCars(snapshot.analysis, cars), base = next.selectedCars[0];
    const lap = next.sessions.find(s => s.id === base?.sessionId)?.laps.find(l => l.lapNumber === base?.lapNumber);
    publish({ ...snapshot, analysis: next, ...(base && lap ? { playhead: { source: base.sessionId, sessionSec: asSessionSec(lap.startTime) }, isPlaying: false } : {}) });
    return next;
  };
  const cancelPending = () => { operations.pickerActive.current = false;operations.selectionEpoch.current++;operations.runDownloadToken.current++; };
  return {
    storage, operations, analysis, getSnapshot: () => snapshot, subscribe, setPlayhead, selectCarsAtLapStart,
    setIsPlaying(change: Change<boolean>) { const next = typeof change === 'function' ? change(snapshot.isPlaying) : change;if (next !== snapshot.isPlaying) publish({ ...snapshot, isPlaying: next }); },
    setPlaybackSpeed(change: Change<number>) { const next = typeof change === 'function' ? change(snapshot.playbackSpeed) : change;if (Number.isFinite(next) && next > 0 && next !== snapshot.playbackSpeed) publish({ ...snapshot, playbackSpeed: next }); },
    assign(incoming: Session[], id: string, lap: number, slot: number, retained: readonly string[] = [], register?: (incoming: Session[]) => Session[]) {
      const proposed = assignLap(snapshot.analysis, incoming, id, lap, slot, false);
      const base = proposed.sessions.find(s => s.id === proposed.selectedCars[0]?.sessionId);
      const keep = base && !base.sourceFile ? retained : [];
      assignLap(snapshot.analysis, incoming, id, lap, slot, true, keep);
      const next = assignLap(snapshot.analysis, register?.(incoming) ?? incoming, id, lap, slot, true, keep);
      const chosenBase = next.selectedCars[0];
      if (chosenBase?.slot === slot) {
        const chosenLap = next.sessions.find(s => s.id === id)?.laps.find(l => l.lapNumber === lap)!;
        publish({ ...snapshot, analysis: next, playhead: { source: id, sessionSec: asSessionSec(chosenLap.startTime) }, isPlaying: false });
      } else publish({ ...snapshot, analysis: next });
      return next;
    },
    cancelPending,
    async close() { await options.flush?.();cancelPending();publish({ ...snapshot, isPlaying: false }); }
  };
}
export type EngineSession = ReturnType<typeof createEngineSession>;
