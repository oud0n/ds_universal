/**
 * 動画のウインドウの状態。どのウインドウでも同じもの (出すカメラ・書き出し中か・同期ピン) はここに 1 つだけ持つ。
 * ウインドウごとのもの (モード・並べ方・大きく出す枠・メーター) は useWindowView で、ウインドウごとに持つ
 * (グラフ画面の左下・右下と動画同期タブで、別々の並べ方にできるように)
 */
import { useState, useSyncExternalStore } from 'react';
import { videoSyncManager, VideoTrack, PlacedTrack } from './videoSyncManager';
import { SyncPin, loadPinsFromStorage, savePinsToStorage } from './videoSyncPinManager';

export type PipPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type StageLayout = 'single' | 'grid' | 'pip';
/** cameras: 1 台の車の走行を、いくつかのカメラで同じ時刻に見る。compare: 走行比較 (比較の車が同じ地点を走った時刻) */
export type VideoMode = 'cameras' | 'compare';

export const MAX_CAMERAS = 4;

export interface VideoViewState {
  /** 出すカメラ (動画の ID。チャプターに分かれた動画は最初のチャプター)。1 つ目がメイン (メーター・同期の調整・書き出しの対象) */
  cameraIds: string[];
  /** 走行比較で、Car (スロット) ごとに利用者が選んだ動画。ないスロットは、その周を映している動画を自動で選ぶ */
  compareCameras: Record<number, string>;
  // 動画を書き出し中か。書き出し中は、どのウインドウも動画の切り替え・再生位置の合わせ直しをしない
  isExporting: boolean;
}

/** チャプターに分かれた動画は、最初のチャプターの ID にそろえる */
function leadId(trackId: string): string {
  return videoSyncManager.getChapterGroupForTrack(trackId)?.tracks[0]?.track.id ?? trackId;
}

class VideoViewStore {
  private state: VideoViewState = { cameraIds: [], compareCameras: {}, isExporting: false };
  private listeners = new Set<() => void>();
  private pinCache = new Map<string, SyncPin[]>();
  // 照合した動画を自動で選んだセッション。同じセッションのあいだは選び直さない (タブの切り替え・書き出しの後に、手で選んだ動画を戻さない)
  autoSelectedSessionId: string | null = null;

  constructor() {
    // 動画を足したり消したりしたら、出すカメラがなくならないように選び直す
    videoSyncManager.subscribe(() => this.reconcile(videoSyncManager.getTracks()));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = (): VideoViewState => this.state;

  set(patch: Partial<VideoViewState>): void {
    const next = { ...this.state, ...patch };
    if ((Object.keys(patch) as (keyof VideoViewState)[]).every(k => JSON.stringify(next[k]) === JSON.stringify(this.state[k]))) return;
    this.state = next;
    this.listeners.forEach(l => l());
  }

  /** 出すカメラが、今ある動画 (の最初のチャプター) を指すようにする。動画があれば少なくとも 1 つ出す */
  private reconcile(tracks: VideoTrack[]): void {
    const ids = new Set(tracks.map(t => t.id));
    const cams: string[] = [];
    for (const id of this.state.cameraIds) {
      if (!ids.has(id)) continue;
      const lead = leadId(id);
      if (!cams.includes(lead)) cams.push(lead);
    }
    if (cams.length === 0 && tracks.length > 0) {
      cams.push(leadId(tracks[0].id));
      // 選んでいた動画を消したら、次に照合済みの動画を読み込んだときに自動で選び直す
      this.autoSelectedSessionId = null;
    }
    const compareCameras = Object.fromEntries(Object.entries(this.state.compareCameras).filter(([, id]) => ids.has(id)));
    this.set({ cameraIds: cams, compareCameras });
  }

  /** 走行比較で、Car (スロット) の枠に出す動画を選ぶ。null で自動 (その周を映している動画) に戻す */
  setCompareCamera(slot: number, trackId: string | null): void {
    const next = { ...this.state.compareCameras };
    if (trackId === null) delete next[slot]; else next[slot] = leadId(trackId);
    this.set({ compareCameras: next });
  }

  /** メインのカメラを選ぶ。ほかの枠に出していたら、その枠からは外す */
  selectMain(trackId: string | null): void {
    if (!trackId) return;
    const id = leadId(trackId);
    this.set({ cameraIds: [id, ...this.state.cameraIds.filter(c => c !== id)].slice(0, MAX_CAMERAS) });
  }

  /** index 番目の枠のカメラを変える (null で枠を外す)。同じカメラがほかの枠にあれば入れ替える */
  setCamera(index: number, trackId: string | null): void {
    const cams = [...this.state.cameraIds];
    if (trackId === null) {
      if (index > 0) cams.splice(index, 1);
      this.set({ cameraIds: cams });
      return;
    }
    const id = leadId(trackId);
    const at = cams.indexOf(id);
    if (at >= 0 && index < cams.length) cams[at] = cams[index];
    if (index < cams.length) cams[index] = id; else if (at < 0) cams.push(id);
    this.set({ cameraIds: cams.slice(0, MAX_CAMERAS) });
  }

  /** index 番目の枠のカメラをメインにする (メインだったカメラはその枠へ) */
  makeMain(index: number): void {
    const cams = [...this.state.cameraIds];
    if (index <= 0 || index >= cams.length) return;
    [cams[0], cams[index]] = [cams[index], cams[0]];
    this.set({ cameraIds: cams });
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

/** 動画の終わりの、置いたログの時刻。チャプターに分かれた動画は、最後のチャプターの終わり */
export function videoEndSessionSec(track: PlacedTrack | null | undefined): number {
  if (!track?.objectUrl || !track.isPlaced) return 0;
  const group = videoSyncManager.getChapterGroupForTrack(track.id);
  const me = group && group.tracks.length > 1 ? group.tracks.find(ct => ct.track.id === track.id) : undefined;
  if (group && me) return track.syncOffsetSec - me.groupOffsetSec + group.totalDurationSec;
  return track.syncOffsetSec + (track.durationSec || 0);
}

/** ウインドウごとの表示の状態 */
export interface WindowViewState {
  mode: VideoMode;
  layout: StageLayout;
  /** 大きく出している枠 (null: 並べる) */
  focus: number | null;
  pipPosition: PipPosition;
  showOverlay: boolean;
  showGForce: boolean;
  /** 重ねる部品: ラップの欄 (Best・Lap・セクター・タイム差) と、コース図 (docs/overlay_parts_design.md) */
  showLapPanel: boolean;
  showMap: boolean;
  /** ラップの欄で比べる周。'best': そのログのベストラップ、数字: その Car の枠 (0〜3) で選んだ周 */
  lapRef: 'best' | number;
  /**
   * 走行比較の合わせ方。distance: Car 1 と同じ地点を走ったときの映像 (比べる車の動画は速さを変えて回す)。
   * time: 周の始めからの同じ経過時間の映像 (比べる車も 1 倍で回す。差が開くと映る場所がずれる)
   */
  compareAlign: CompareAlign;
}

export type CompareAlign = 'distance' | 'time';

const WINDOW_DEFAULT: WindowViewState = { mode: 'cameras', layout: 'grid', focus: null, pipPosition: 'bottom-right', showOverlay: true, showGForce: true, showLapPanel: true, showMap: true, lapRef: 'best', compareAlign: 'distance' };

/**
 * ウインドウごとの表示の状態。key ごとにブラウザに覚える (読めないとき・書けないときは既定のまま。動作には要らない)
 */
export function useWindowView(key: string): [WindowViewState, (patch: Partial<WindowViewState>) => void] {
  const storageKey = `ds_video_window_${key}`;
  const [state, setState] = useState<WindowViewState>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? { ...WINDOW_DEFAULT, ...JSON.parse(raw), focus: null } : WINDOW_DEFAULT;
    } catch {
      return WINDOW_DEFAULT;
    }
  });
  const update = (patch: Partial<WindowViewState>) => setState(prev => {
    const next = { ...prev, ...patch };
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* 覚えられなくても動く */ }
    return next;
  });
  return [state, update];
}

export function useVideoView(): VideoViewState {
  return useSyncExternalStore(videoViewStore.subscribe, videoViewStore.getState);
}

export function useVideoTracks(): VideoTrack[] {
  return useSyncExternalStore(videoSyncManager.subscribe, videoSyncManager.getSnapshot);
}

export function useSyncPins(key: string): SyncPin[] {
  return useSyncExternalStore(videoViewStore.subscribe, () => videoViewStore.getPins(key));
}
