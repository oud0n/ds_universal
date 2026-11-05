import type { SyncPin } from './videoSyncPinManager';
import { pinUtcMs } from './videoSyncPinManager';
import type { ClockSession } from './mediaClock';
export function createSyncPinStore(load: (key: string) => SyncPin[], save: (key: string, pins: SyncPin[]) => void) {
class SyncPinStore {
 private pinCache = new Map<string, SyncPin[]>();
 private allPins: SyncPin[] | null = null;
 private listeners = new Set<() => void>();
 subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  // 同期ピンはコースごとに保存する。同じ配列を返す (useSyncExternalStore が変化を見分けられるように)
  getPins = (key: string): SyncPin[] => {
    let pins = this.pinCache.get(key);
    if (!pins) {
      pins = load(key);
      if (!Array.isArray(pins)) pins = [];
      this.pinCache.set(key, pins);
      this.allPins = null;
    }
    return pins;
  };

  setPins(key: string, pins: SyncPin[]): void {
    this.pinCache.set(key, pins);
    this.allPins = null;
    save(key, pins);
    this.listeners.forEach(l => l());
  }

  getAllPins = (key?: string): SyncPin[] => {
    if (key) this.getPins(key);
    return this.allPins ??= [...new Map([...this.pinCache.values()].flat().map(p => [p.id, p])).values()];
  };

  /** コースの表示を変えても、同じ動画のピンを一つの集合として編集する。 */
  setTrackPins(key: string, ids: ReadonlySet<string>, pins: SyncPin[]): void {
    this.getPins(key);
    for (const [bucket, old] of this.pinCache) {
      const next = [...old.filter(p => !ids.has(p.trackId)), ...(bucket === key ? pins : [])];
      if (next.length !== old.length || next.some((p, i) => p !== old[i])) this.setPins(bucket, next);
    }
  }

  anchorPins(sessions: readonly ClockSession[]): void {
    for (const [key, pins] of this.pinCache) {
      let changed = false;
      const next = pins.map(p => {
        const utcMs = pinUtcMs(p, sessions);
        if (utcMs === null || utcMs === p.utcMs) return p;
        changed = true;return { ...p, utcMs };
      });
      if (changed) this.setPins(key, next);
    }
  }

  remapPinSessions(ids: ReadonlyMap<string, string>): void {
    for (const [key, pins] of this.pinCache) {
      const next = pins.map(p => p.sessionId && ids.has(p.sessionId) ? { ...p, sessionId: ids.get(p.sessionId)! } : p);
      if (next.some((p, i) => p !== pins[i])) this.setPins(key, next);
    }
  }
}
return new SyncPinStore();
}
export type SyncPinStore = ReturnType<typeof createSyncPinStore>;
