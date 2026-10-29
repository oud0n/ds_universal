/**
 * ラップタイマーの内蔵カメラ (2026-10-25)。測定開始で録画を始め、測定終了で止めて、走行のログ (.nmea) と同じフォルダに .mov を置く。
 * 撮った動画は、その走行の行 (runs.json) に GPS の時刻で書いておく (走行の画面から開くと、はじめから同期済みになる)。
 *
 * 時刻: カメラは先頭のコマの「端末の時計」を返す。測位ごとに「GPS の時刻 − 受け取った端末の時計」を見て、いちばん大きいもの
 * (届くまでの遅れがいちばん少なかった測位) を端末の時計と GPS の時計の差とし、動画の先頭の GPS の時刻にする
 */

import { callNative, hasNative, nativeCapabilities } from '../../native/bridge';
import type { CameraFile, CameraLens, CameraPreset } from '../../native/contract';
import { getRunStore } from '../runStore';
import { updateRun, type RunVideo } from '../runsFile';
import { runFileBase } from '../runFiles';

export interface CameraSettings {
  enabled: boolean;
  lensId: string | null;
  preset: CameraPreset;
  audio: boolean;
  /** 前の版の ISO (2026-10-25 に明るさの補正へ替えた。今は使わず、いつも自動) */
  iso: number | null;
  /** 明るさの補正 (EV。−2〜+1。マイナスで暗め = 窓の外が白く飛びにくい) */
  ev: number;
  /** ピントを遠く (無限遠の側) に合わせて固定する (車載向け。前のカメラは機種による) */
  focusFar: boolean;
  preview: boolean;
  /** 前のカメラ (自分側) も同時に撮る (前と後ろを同時に撮れる端末だけ。後ろのカメラは lensId のもの) */
  front: { enabled: boolean; preset: CameraPreset; iso: number | null; ev: number };
}

/** 明るさの補正の選べる値 (EV) */
export const EV_CHOICES = [-2, -1.5, -1, -0.5, 0, 0.5, 1];

const KEY = 'ds_timer_camera';
export const DEFAULT_CAMERA: CameraSettings = {
  enabled: false, lensId: null, preset: '1080p30', audio: true, iso: null, ev: 0, focusFar: true, preview: true,
  front: { enabled: false, preset: '1080p30', iso: null, ev: 0 }
};

export function loadCameraSettings(): CameraSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v === 'object' ? { ...DEFAULT_CAMERA, ...v, front: { ...DEFAULT_CAMERA.front, ...(v.front ?? {}) } } : DEFAULT_CAMERA;
  } catch {
    return DEFAULT_CAMERA;
  }
}

export function saveCameraSettings(s: CameraSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 覚えられなくても撮れる */ }
}

/** 内蔵カメラで撮れるか (アプリで、カメラの約束に対応した版) */
export async function cameraAvailable(): Promise<boolean> {
  if (!hasNative()) return false;
  try { return !!(await nativeCapabilities())?.features.camera; } catch { return false; }
}

export async function listLenses(): Promise<{ lenses: CameraLens[]; multiCam: boolean }> {
  try {
    const r = await callNative('camera.lenses', {});
    return { lenses: r.lenses, multiCam: !!r.multiCam };
  } catch { return { lenses: [], multiCam: false }; }
}

/**
 * 前も同時に撮るときの、後ろ・前のレンズと画質 (同時に撮れなければ null)。
 * 後ろのレンズは選んだもの (前を選んでいたら広角)、画質は同時に撮れるもの
 */
export function dualPlan(s: CameraSettings, lenses: CameraLens[], multiCam: boolean): { back: CameraLens; front: CameraLens; backPresets: CameraPreset[]; frontPresets: CameraPreset[] } | null {
  if (!multiCam) return null;
  const front = lenses.find(l => l.position === 'front');
  const backs = lenses.filter(l => l.position === 'back' && (l.multiCamPresets?.length ?? 0) > 0);
  const back = backs.find(l => l.id === s.lensId) ?? backs.find(l => l.kind === 'wide') ?? backs[0];
  if (!front || !back || !front.multiCamPresets?.length) return null;
  return { back, front, backPresets: back.multiCamPresets!, frontPresets: front.multiCamPresets };
}

/** 撮るときに渡す前のカメラの設定 (前を撮らない・同時に撮れないときは null)。画質は同時に撮れるものに直す */
export function frontParams(s: CameraSettings, plan: ReturnType<typeof dualPlan>): { preset: CameraPreset; iso: null; ev: number } | null {
  if (!s.front.enabled || !plan) return null;
  return { preset: plan.frontPresets.includes(s.front.preset) ? s.front.preset : plan.frontPresets[0], iso: null, ev: s.front.ev ?? 0 };
}

export type CameraStatus = { recording: boolean; error: string | null };

/** 測っている間の録画 (TimerRuntime が持つ) */
export class PhoneCameraRecorder {
  private active = false;
  private starting = false;
  /** 止めている最中 (アプリの書き終わりを待っている)。終わるまで次の録画を始めない (重なると、録画が始まらなかった) */
  private stopping: Promise<void> | null = null;
  /** 始める途中で止められた (始められなかったことをエラーとして出さない) */
  private stopRequested = false;
  /** 始める途中に、止めてからまた始めるよう頼まれた (区切り直し。始め終わったら、もう一度始める。BUG-38 の 9) */
  private restartWanted = false;
  /** 熱すぎて録画を止めた (冷めるまで、区切り直しでも撮り始めない。BUG-38 の 8) */
  private hot = false;
  /** 撮り始めた時刻 (走行のファイルが無いときの動画の名前に使う) */
  private startedMs: number | null = null;
  /** 端末の時計から GPS の時計への差 (ミリ秒)。測位ごとに大きいほうへ寄せる */
  private gpsMinusWall: number | null = null;
  status: CameraStatus = { recording: false, error: null };

  constructor(private readonly onStatus: (s: CameraStatus) => void) {}

  /**
   * 測位を受け取った (GPS の時刻)。deviceClock: 端末の GPS の測位 (時刻が端末の時計なので、差は 0。
   * 届くまでの遅れの分を差と取り違えると、動画が遅れの分だけ前にずれていた)
   */
  noteFix(gpsMs: number, deviceClock = false): void {
    if (!this.active) return;
    if (deviceClock) { this.gpsMinusWall = 0; return; }
    const d = gpsMs - Date.now();
    if (this.gpsMinusWall === null || d > this.gpsMinusWall) this.gpsMinusWall = d;
  }

  private set(s: Partial<CameraStatus>): void {
    this.status = { ...this.status, ...s };
    this.onStatus(this.status);
  }

  /** 測定開始 */
  async start(): Promise<void> {
    const s = loadCameraSettings();
    // 続けて呼ばれても (測位ごとなど) 1 回だけ始める
    if (!s.enabled || this.active) return;
    if (this.starting) {
      // 前の始めを止めるよう頼まれていたら、それが終わったあとで始め直す
      if (this.stopRequested) this.restartWanted = true;
      return;
    }
    if (this.hot) { this.set({ recording: false, error: 'thermal' }); return; }
    this.starting = true;
    this.stopRequested = false;
    try {
      if (this.stopping) await this.stopping.catch(() => {});
      if (await cameraAvailable()) await this.begin(s);
    } finally {
      this.starting = false;
    }
    if (this.restartWanted) {
      this.restartWanted = false;
      await this.start();
    }
  }

  private async begin(s: CameraSettings): Promise<void> {
    try {
      const p = await callNative('camera.permission', { request: true, audio: s.audio });
      // 許可を聞いている間に測定を終えていたら、撮り始めない
      if (this.stopRequested) return;
      if (p.camera !== 'granted') { this.set({ error: 'permission' }); return; }
      this.active = true;
      this.startedMs = Date.now();
      this.gpsMinusWall = null;
      // 前も同時に撮るときは、後ろのレンズ・画質も同時に撮れるものにする
      const { lenses, multiCam } = s.front.enabled ? await listLenses() : { lenses: [], multiCam: false };
      const plan = s.front.enabled ? dualPlan(s, lenses, multiCam) : null;
      const front = frontParams(s, plan);
      const lensId = front && plan ? plan.back.id : s.lensId;
      const preset = front && plan && !plan.backPresets.includes(s.preset) ? plan.backPresets[0] : s.preset;
      if (this.stopRequested) { this.active = false; return; }
      await callNative('camera.start', { lensId, preset, audio: s.audio && p.mic === 'granted', iso: null, ev: s.ev, focusFar: s.focusFar, preview: s.preview, front });
      this.set({ recording: true, error: null });
    } catch (e) {
      this.active = false;
      // 始める途中で止めた (測定を終えた) ときは、エラーにしない
      this.set({ recording: false, error: this.stopRequested ? null : e instanceof Error ? e.message : String(e) });
    }
  }

  /** ネイティブの知らせ (裏に回って止まった・熱で止めた) */
  noteState(recording: boolean, error?: string, thermal?: string): void {
    if (error === 'thermal') this.hot = true;
    else if (thermal && thermal !== 'critical' && thermal !== 'serious') this.hot = false;
    if (!this.active) return;
    this.set({ recording, error: error ?? null });
  }

  /**
   * 測定終了 (走行を替えたときも)。fileBase (LapTimer/ の下、拡張子なし。.nmea と同じ) に .mov を置き、走行の行に書く。
   * 走行のファイルが無い (測位が 1 つも無かった) ときは、撮り始めた時刻の名前で未分類に置く
   */
  stop(fileBase: string | null, fallbackFolder: string): Promise<void> {
    // 始める途中 (許可を聞いている・アプリが組み立てている) なら、始めないように印を付ける
    this.restartWanted = false;
    if (this.starting) this.stopRequested = true;
    if (!this.active) return this.stopping ?? Promise.resolve();
    this.active = false;
    this.stopRequested = true;
    const run = this.stopNow(fileBase, fallbackFolder).finally(() => { if (this.stopping === run) this.stopping = null; });
    this.stopping = run;
    return run;
  }

  private async stopNow(fileBase: string | null, fallbackFolder: string): Promise<void> {
    let base = fileBase;
    if (!base) {
      // 撮り始めた時刻の名前 (走行のファイルと同じ形)
      const stamp = runFileBase(this.startedMs ?? Date.now());
      base = `${fallbackFolder}/${stamp.slice(0, 8)}/${stamp}`;
    }
    let files: CameraFile[] = [];
    try {
      const r = await callNative('camera.stop', { path: `${base}.mov`, frontPath: `${base}_front.mov` });
      files = [...r.files, ...(r.frontFiles ?? []).map(f => ({ ...f, front: true }))];
    } catch (e) {
      this.set({ recording: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.set({ recording: false });
    if (!fileBase || files.length === 0) return;
    await writeRunVideos(fileBase, files, this.gpsMinusWall).catch(() => {});
  }
}

/** 走行の行 (runs.json) に、撮った動画を GPS の時刻で書く */
async function writeRunVideos(fileBase: string, files: Array<CameraFile & { front?: boolean }>, gpsMinusWall: number | null): Promise<void> {
  const store = await getRunStore();
  if (!store) return;
  const i = fileBase.indexOf('/');
  const folder = fileBase.slice(0, i);
  const file = `${fileBase.slice(i + 1)}.nmea`;
  const videos: RunVideo[] = files.map(f => {
    const utcMs = Math.round(f.startWallMs + (gpsMinusWall ?? 0));
    return {
      name: f.path.slice(f.path.lastIndexOf('/') + 1),
      size: f.bytes,
      durationSec: f.durationSec,
      recordedAt: new Date(utcMs).toISOString(),
      part: 1,
      // 前のカメラ (自分側) の動画
      ...(f.front ? { camera: 'front' } : {}),
      // 測位が届かなかった (GPS の時計が分からない) ときは、端末の時計での撮影日時の扱い
      clock: { source: gpsMinusWall === null ? 'creation' : 'gps', logPart: null, offsetSec: 0, utcMs }
    };
  });
  await updateRun(store, folder, file, prev => {
    const names = new Set(videos.map(v => v.name));
    return { ...prev, videos: [...(prev?.videos ?? []).filter(v => !names.has(v.name)), ...videos] };
  });
}
