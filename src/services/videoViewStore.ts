/**
 * 動画のウインドウの表示の状態 (選んでいる動画・2 カメラの表示・メーターの表示・同期ピン)。
 * 動画のウインドウはグラフ画面の左下・右下と動画同期タブに同時に開けるので、状態はここに 1 つだけ持ち、どのウインドウでも同じにする
 */
import { useSyncExternalStore } from 'react';
import { videoSyncManager, VideoTrack } from './videoSyncManager';
import { SyncPin, loadPinsFromStorage, savePinsToStorage } from './videoSyncPinManager';

export type VideoViewMode = 'single' | 'split' | 'pip';
export type PipPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface VideoViewState {
  selectedTrackId: string | null;
  subTrackId: string | null;
  viewMode: VideoViewMode;
  pipPosition: PipPosition;
  isSubMuted: boolean;
  showOverlay: boolean;
  showGForce: boolean;
  // 動画を書き出し中か。書き出し中は、どのウインドウも動画の切り替え・再生位置の合わせ直しをしない
  isExporting: boolean;
}

class VideoViewStore {
  private state: VideoViewState = {
    selectedTrackId: null,
    subTrackId: null,
    viewMode: 'single',
    pipPosition: 'bottom-right',
    isSubMuted: true,
    showOverlay: true,
    showGForce: true,
    isExporting: false
  };
  private listeners = new Set<() => void>();
  private pinCache = new Map<string, SyncPin[]>();
  // 照合した動画を自動で選んだセッション。同じセッションのあいだは選び直さない (タブの切り替え・書き出しの後に、手で選んだ動画を戻さない)
  autoSelectedSessionId: string | null = null;

  constructor() {
    // 動画を足したり消したりしたら、選んでいる動画がなくならないように選び直す
    videoSyncManager.subscribe(() => this.reconcile(videoSyncManager.getTracks()));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = (): VideoViewState => this.state;

  set(patch: Partial<VideoViewState>): void {
    const next = { ...this.state, ...patch };
    if ((Object.keys(patch) as (keyof VideoViewState)[]).every(k => next[k] === this.state[k])) return;
    this.state = next;
    this.listeners.forEach(l => l());
  }

  /** メインとサブが、今ある動画を指すようにする */
  private reconcile(tracks: VideoTrack[]): void {
    let { selectedTrackId, subTrackId } = this.state;
    if (!tracks.some(t => t.id === selectedTrackId)) {
      selectedTrackId = tracks[0]?.id ?? null;
      // 選んでいた動画を消したら、次に照合済みの動画を読み込んだときに自動で選び直す
      this.autoSelectedSessionId = null;
    }
    if (!tracks.some(t => t.id === subTrackId) || subTrackId === selectedTrackId) {
      subTrackId = tracks.find(t => t.id !== selectedTrackId)?.id ?? null;
    }
    this.set({ selectedTrackId, subTrackId });
  }

  /** メインの動画を選ぶ。サブと同じになったら、サブを別の動画にする */
  selectMain(trackId: string | null): void {
    const tracks = videoSyncManager.getTracks();
    let subTrackId = this.state.subTrackId;
    if (subTrackId === trackId) subTrackId = tracks.find(t => t.id !== trackId)?.id ?? null;
    this.set({ selectedTrackId: trackId, subTrackId });
  }

  swap(): void {
    const { selectedTrackId, subTrackId } = this.state;
    if (!selectedTrackId || !subTrackId) return;
    this.set({ selectedTrackId: subTrackId, subTrackId: selectedTrackId });
  }

  // 同期ピンはコースごとに保存する。同じ配列を返す (useSyncExternalStore が変化を見分けられるように)
  getPins = (key: string): SyncPin[] => {
    let pins = this.pinCache.get(key);
    if (!pins) {
      pins = loadPinsFromStorage(key);
      if (!Array.isArray(pins)) pins = [];
      this.pinCache.set(key, pins);
    }
    return pins;
  };

  setPins(key: string, pins: SyncPin[]): void {
    this.pinCache.set(key, pins);
    savePinsToStorage(key, pins);
    this.listeners.forEach(l => l());
  }
}

export const videoViewStore = new VideoViewStore();

export function useVideoView(): VideoViewState {
  return useSyncExternalStore(videoViewStore.subscribe, videoViewStore.getState);
}

export function useVideoTracks(): VideoTrack[] {
  return useSyncExternalStore(videoSyncManager.subscribe, videoSyncManager.getSnapshot);
}

export function useSyncPins(key: string): SyncPin[] {
  return useSyncExternalStore(videoViewStore.subscribe, () => videoViewStore.getPins(key));
}
