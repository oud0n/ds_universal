/**
 * 手動キーフレーム同期（特定地点ピン留め: Sync Pin）管理サービス
 * GPSの特定地点（クリッピング・コントロールライン通過等）と動画の同一フレームを1クリックでピン留め固定
 */

export interface SyncPin {
  id: string;
  name: string;                // 例: "1コーナーAPEX", "コントロールライン通過", "ダンロップ進入"
  sessionTimeSec: number;      // GPSセッション秒
  videoTimeSec: number;        // その瞬間における動画内秒 (local time)
  trackId: string;             // 対象動画トラックID
  calculatedOffsetSec: number; // sessionTimeSec - videoTimeSec
  createdAt: string;           // ISOタイムスタンプ
  notes?: string;
}

export function createSyncPin(
  name: string,
  sessionTimeSec: number,
  videoTimeSec: number,
  trackId: string,
  notes?: string
): SyncPin {
  const calculatedOffsetSec = Number((sessionTimeSec - videoTimeSec).toFixed(3));
  return {
    id: `pin_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: name.trim() || '同期ピン',
    sessionTimeSec: Number(sessionTimeSec.toFixed(3)),
    videoTimeSec: Number(videoTimeSec.toFixed(3)),
    trackId,
    calculatedOffsetSec,
    createdAt: new Date().toISOString(),
    notes,
  };
}

export function applyPinToTrack(
  pin: SyncPin,
  updateOffsetCallback: (trackId: string, newOffsetSec: number) => void
): number {
  const newOffsetSec = pin.calculatedOffsetSec;
  updateOffsetCallback(pin.trackId, newOffsetSec);
  return newOffsetSec;
}

export function formatPinTime(sec: number): string {
  const sClamped = Math.max(0, sec);
  const m = Math.floor(sClamped / 60);
  const s = (sClamped % 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

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
