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

export interface CameraSettings {
  enabled: boolean;
  lensId: string | null;
  preset: CameraPreset;
  audio: boolean;
  /** null は自動 */
  iso: number | null;
  preview: boolean;
}

const KEY = 'ds_timer_camera';
export const DEFAULT_CAMERA: CameraSettings = { enabled: false, lensId: null, preset: '1080p30', audio: true, iso: null, preview: true };

export function loadCameraSettings(): CameraSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v === 'object' ? { ...DEFAULT_CAMERA, ...v } : DEFAULT_CAMERA;
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

export async function listLenses(): Promise<CameraLens[]> {
  try { return (await callNative('camera.lenses', {})).lenses; } catch { return []; }
}

/** ISO の選べる値 (レンズの範囲の中) */
export function isoChoices(lens: CameraLens | undefined): number[] {
  const all = [50, 100, 200, 400, 800, 1600, 3200];
  return lens ? all.filter(v => v >= lens.isoMin - 0.5 && v <= lens.isoMax + 0.5) : all;
}

export type CameraStatus = { recording: boolean; error: string | null };

/** 測っている間の録画 (TimerRuntime が持つ) */
export class PhoneCameraRecorder {
  private active = false;
  /** 端末の時計から GPS の時計への差 (ミリ秒)。測位ごとに大きいほうへ寄せる */
  private gpsMinusWall: number | null = null;
  status: CameraStatus = { recording: false, error: null };

  constructor(private readonly onStatus: (s: CameraStatus) => void) {}

  /** 測位を受け取った (GPS の時刻) */
  noteFix(gpsMs: number): void {
    if (!this.active) return;
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
    if (!s.enabled || this.active || !(await cameraAvailable())) return;
    try {
      const p = await callNative('camera.permission', { request: true, audio: s.audio });
      if (p.camera !== 'granted') { this.set({ error: 'permission' }); return; }
      this.active = true;
      this.gpsMinusWall = null;
      await callNative('camera.start', { lensId: s.lensId, preset: s.preset, audio: s.audio && p.mic === 'granted', iso: s.iso, preview: s.preview });
      this.set({ recording: true, error: null });
    } catch (e) {
      this.active = false;
      this.set({ recording: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** ネイティブの知らせ (裏に回って止まった・熱で止めた) */
  noteState(recording: boolean, error?: string): void {
    if (!this.active) return;
    this.set({ recording, error: error ?? null });
  }

  /**
   * 測定終了 (走行を替えたときも)。fileBase (LapTimer/ の下、拡張子なし。.nmea と同じ) に .mov を置き、走行の行に書く。
   * 走行のファイルが無い (測位が 1 つも無かった) ときは、撮り始めた時刻の名前で未分類に置く
   */
  async stop(fileBase: string | null, fallbackFolder: string): Promise<void> {
    if (!this.active) return;
    this.active = false;
    let base = fileBase;
    if (!base) {
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
      base = `${fallbackFolder}/${stamp.slice(0, 8)}/${stamp}`;
    }
    let files: CameraFile[] = [];
    try {
      files = (await callNative('camera.stop', { path: `${base}.mov` })).files;
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
async function writeRunVideos(fileBase: string, files: CameraFile[], gpsMinusWall: number | null): Promise<void> {
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
      // 測位が届かなかった (GPS の時計が分からない) ときは、端末の時計での撮影日時の扱い
      clock: { source: gpsMinusWall === null ? 'creation' : 'gps', logPart: null, offsetSec: 0, utcMs }
    };
  });
  await updateRun(store, folder, file, prev => {
    const names = new Set(videos.map(v => v.name));
    return { ...prev, videos: [...(prev?.videos ?? []).filter(v => !names.has(v.name)), ...videos] };
  });
}
