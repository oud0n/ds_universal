import type { SyncPin } from '../engine/videoSyncPinManager';
export * from '../engine/videoSyncPinManager';
const STORAGE_KEY_PREFIX = 'ds_universal_sync_pins_';

export function savePinsToStorage(projectIdOrCircuit: string, pins: SyncPin[]): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${projectIdOrCircuit}`, JSON.stringify(pins));
  } catch (e) {
    console.warn('Failed to save sync pins to localStorage', e);
  }
}

export function loadPinsFromStorage(projectIdOrCircuit: string): SyncPin[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${projectIdOrCircuit}`);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('Failed to load sync pins from localStorage', e);
    return [];
  }
}
