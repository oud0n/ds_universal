import type { Session } from '../types/telemetry';
import type { BinaryFile } from './ports';
import { clockOffsetIn, clockStartUtcMs, type VideoClock } from './mediaClock';
export interface RemoteVideo { name: string; size: number; url: string; path: string; lastModified: number; readRange?: (start: number, end: number) => Promise<ArrayBuffer> }
export interface VideoTrack<TFile extends BinaryFile = BinaryFile> {
  id: string;
  projectKey?: string;
  projectSourcePath?: string;
  file?: TFile;
  objectUrl?: string;
  /** 保管場所の動画 (lapfile://run/。file はない。範囲を頼んで読む) */
  remote?: RemoteVideo;
  fileName: string;
  fileSize: number;
  durationSec: number;
  rawRecordedAt: Date | null; // 動画メタデータから抽出された元の時刻
  recordedAtJst: Date | null; // 後方互換性
  videoTimezone: string;      // 動画の解釈タイムゾーン ('JST' | 'UTC' ...)
  gpsTimezone: string;        // GPS走行ログの解釈タイムゾーン ('JST' | 'UTC' ...)
  /** 動画を出すログ (その走行の主のログ)。動画の時刻とは別 (時刻は clock) */
  matchedSessionId: string | null;
  /** 動画の時刻 (mediaClock.ts)。チャプターに分かれた動画は、同じ時計でチャプターの長さずつ進む */
  clock: VideoClock;
  isAutoMatched: boolean;
  /** GoPro の低画質のファイル (.LRV)。小さな枠・下書きの書き出しに使う。時刻の基準は元の動画と同じ */
  proxyUrl?: string;
  proxyFileName?: string;
  // 利用者が「動画に合わせるログ」を選んだもの。記録の細かいログへの自動の付け替えをしない (LATER-12)
  isSessionChosenManually?: boolean;
  notes?: string;
}

/**
 * あるログ (画面の基準の Car 1) の時刻に置いた動画。syncOffsetSec は、そのログの時刻での動画の先頭の位置 (秒)。
 * 画面・書き出し・タイムラインは、これだけを使う (動画がどのログに時刻を付けたかを気にしない)
 */
export interface PlacedTrack<TFile extends BinaryFile = BinaryFile> extends VideoTrack<TFile> {
  syncOffsetSec: number;
  /** そのログの時刻に置けた (時刻が分かった) か。置けないときの syncOffsetSec は 0 */
  isPlaced: boolean;
}

export function placeTrack<TFile extends BinaryFile>(track: VideoTrack<TFile>, session: Session | null | undefined, sessions: Session[]): PlacedTrack<TFile> {
  const offset = clockOffsetIn(track.clock, session, sessions);
  return { ...track, syncOffsetSec: offset ?? 0, isPlaced: offset !== null };
}

/**
 * 動画をまとめて置く。ログがないとき (動画だけを読み込んだとき) は、いちばん早く始まる動画の頭を 0 秒として、撮影の時刻の差で並べる
 * (時刻の分からない動画は 0 秒から)。動画だけでも再生できるように
 */
export function placeTracks<TFile extends BinaryFile>(tracks: VideoTrack<TFile>[], session: Session | null | undefined, sessions: Session[]): PlacedTrack<TFile>[] {
  if (session) return tracks.map(t => placeTrack(t, session, sessions));
  const starts = tracks.map(t => clockStartUtcMs(t.clock, sessions));
  const known = starts.filter((x): x is number => x !== null);
  const origin = known.length ? Math.min(...known) : 0;
  return tracks.map((t, i) => ({ ...t, syncOffsetSec: starts[i] === null ? 0 : Number(((starts[i]! - origin) / 1000).toFixed(3)), isPlaced: true }));
}

/** 手で合わせた (同期ピン・ずれの入力) 動画か。自動の照合では変えない */
export function isClockManual(track: VideoTrack): boolean {
  return track.clock.source === 'manual';
}

/** 保存の形式 2.0。1.0 (ずれを照合したログからの秒で持つ形) も読める */
export interface SyncProjectData {
  version: '2.0';
  savedAt: string;
  circuitName: string;
  videos: Array<{
    key?: string;
    sourcePath?: string;
    fileName: string;
    fileSize: number;
    durationSec: number;
    rawRecordedAt?: string | null;
    recordedAtJst: string | null;
    videoTimezone?: string;
    gpsTimezone?: string;
    matchedSessionId: string | null;
    sessionChosenManually?: boolean;
    clock: VideoClock;
  }>;
  sessions: Array<{
    id: string;
    fileName: string;
    sessionName: string;
    startDateJst: string;
    totalLaps: number;
    samplingRate: number;
    /** ログの時計の補正 (秒) */
    clockOffsetSec?: number;
    filePart?: number;
  }>;
  // 同期ピン。動画の ID は読み込むたびに変わるので、ファイル名で持つ
  pins?: Array<{
    name: string;
    sessionTimeSec: number;
    videoTimeSec: number;
    calculatedOffsetSec: number;
    trackFileName: string | null;
    trackKey?: string | null;
    /** ピンを打ったときの基準のログ (sessionTimeSec はこのログの時刻) */
    sessionId?: string | null;
    utcMs?: number;
    createdAt?: string;
  }>;
}

