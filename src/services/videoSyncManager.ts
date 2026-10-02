/**
 * 複数車載動画 & GPS走行データ 自動同期・プロジェクト管理サービス
 */
import { Session } from '../types/telemetry';
import { parseVideoMetadata, VideoMetadata } from './videoMetadataParser';

export type TimezoneMode = 'JST' | 'UTC' | 'LOCAL' | '+8' | '+1' | '-5' | '-8';

export const TIMEZONE_OPTIONS: { value: string; label: string; offsetHours: number }[] = [
  { value: 'JST', label: 'JST (UTC+9: 日本標準時)', offsetHours: 9 },
  { value: 'UTC', label: 'UTC (±0: 世界標準時 / GPS時刻)', offsetHours: 0 },
  { value: 'LOCAL', label: 'PCローカル時刻', offsetHours: -new Date().getTimezoneOffset() / 60 },
  { value: '+8', label: 'UTC+8 (アジア標準時)', offsetHours: 8 },
  { value: '+1', label: 'UTC+1 (CET: 欧州中央時)', offsetHours: 1 },
  { value: '-5', label: 'UTC-5 (EST: 米東部標準時)', offsetHours: -5 },
  { value: '-8', label: 'UTC-8 (PST: 米太平洋標準時)', offsetHours: -8 }
];

export function getTimezoneOffsetMs(mode: string): number {
  switch (mode) {
    case 'JST':
    case '+9':
      return 9 * 3600 * 1000;
    case 'UTC':
    case '+0':
    case '0':
      return 0;
    case 'LOCAL':
      return -new Date().getTimezoneOffset() * 60 * 1000;
    case '+8':
      return 8 * 3600 * 1000;
    case '+1':
      return 1 * 3600 * 1000;
    case '-5':
      return -5 * 3600 * 1000;
    case '-8':
      return -8 * 3600 * 1000;
    default:
      const parsed = parseFloat(mode);
      return !isNaN(parsed) ? parsed * 3600 * 1000 : 9 * 3600 * 1000;
  }
}

export interface VideoTrack {
  id: string;
  file?: File;
  objectUrl?: string;
  fileName: string;
  fileSize: number;
  durationSec: number;
  rawRecordedAt: Date | null; // 動画メタデータから抽出された元の時刻
  recordedAtJst: Date | null; // 後方互換性
  videoTimezone: string;      // 動画の解釈タイムゾーン ('JST' | 'UTC' ...)
  gpsTimezone: string;        // GPS走行ログの解釈タイムゾーン ('JST' | 'UTC' ...)
  matchedSessionId: string | null;
  syncOffsetSec: number;      // GPSセッション t=0 に対する動画開始位置のオフセット (秒)
  isAutoMatched: boolean;
  notes?: string;
}

export interface SyncProjectData {
  version: '1.0';
  savedAt: string;
  circuitName: string;
  videos: Array<{
    fileName: string;
    fileSize: number;
    durationSec: number;
    rawRecordedAt?: string | null;
    recordedAtJst: string | null;
    videoTimezone?: string;
    gpsTimezone?: string;
    matchedSessionId: string | null;
    syncOffsetSec: number;
  }>;
  sessions: Array<{
    id: string;
    fileName: string;
    sessionName: string;
    startDateJst: string;
    totalLaps: number;
    samplingRate: number;
  }>;
}

class VideoSyncManager {
  private videos: VideoTrack[] = [];
  public defaultVideoTimezone: string = 'JST';
  public defaultGpsTimezone: string = 'JST';
  public onTracksUpdated?: (tracks: VideoTrack[]) => void;

  public getTracks(): VideoTrack[] {
    return this.videos;
  }

  // 複数動画ファイルの読み込み & 自動解析
  public async addVideoFiles(files: FileList | File[], sessions: Session[]): Promise<VideoTrack[]> {
    const newTracks: VideoTrack[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const meta: VideoMetadata = await parseVideoMetadata(file);

      const track: VideoTrack = {
        id: `vid_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        file,
        objectUrl: URL.createObjectURL(file),
        fileName: file.name,
        fileSize: file.size,
        durationSec: meta.durationSec,
        rawRecordedAt: meta.creationTime,
        recordedAtJst: meta.creationTime,
        videoTimezone: this.defaultVideoTimezone,
        gpsTimezone: this.defaultGpsTimezone,
        matchedSessionId: null,
        syncOffsetSec: 0,
        isAutoMatched: false
      };

      newTracks.push(track);
    }

    this.videos = [...this.videos, ...newTracks];

    // GPSセッションとの自動照合
    this.autoMatchTracks(sessions);

    if (this.onTracksUpdated) {
      this.onTracksUpdated(this.videos);
    }

    return this.videos;
  }

  // タイムスタンプオフセット計算 (ミリ秒精度の差分秒)
  public calculateSyncOffset(
    vidRecordedAt: Date,
    vidTz: string,
    gpsPoint0Timestamp: Date,
    gpsTz: string
  ): number {
    const vidUtcMs = vidRecordedAt.getTime() - getTimezoneOffsetMs(vidTz);
    const gpsUtcMs = gpsPoint0Timestamp.getTime() - getTimezoneOffsetMs(gpsTz);
    // GPSセッション開始に対して、動画が何秒後に始まったか
    return Number(((vidUtcMs - gpsUtcMs) / 1000).toFixed(3));
  }

  // タイムゾーンや指定セッションに基づく再同期 (Resync)
  public resyncTrack(
    trackId: string,
    sessions: Session[],
    vidTz?: string,
    gpsTz?: string,
    sessionId?: string
  ): VideoTrack | null {
    const track = this.videos.find(v => v.id === trackId);
    if (!track) return null;

    if (vidTz) track.videoTimezone = vidTz;
    if (gpsTz) track.gpsTimezone = gpsTz;
    if (sessionId) track.matchedSessionId = sessionId;

    if (!track.rawRecordedAt) {
      if (this.onTracksUpdated) this.onTracksUpdated(this.videos);
      return track;
    }

    const currentVidTz = track.videoTimezone || 'JST';
    const currentGpsTz = track.gpsTimezone || 'JST';

    // 対象セッションの決定
    let targetSession = sessions.find(s => s.id === track.matchedSessionId);

    const vidUtcMs = track.rawRecordedAt.getTime() - getTimezoneOffsetMs(currentVidTz);

    if (!targetSession && sessions.length > 0) {
      let minDiffMs = Infinity;
      for (const sess of sessions) {
        if (sess.points.length === 0 || !sess.points[0].timestamp) continue;
        const sessUtcMs = new Date(sess.points[0].timestamp).getTime() - getTimezoneOffsetMs(currentGpsTz);
        const diff = Math.abs(vidUtcMs - sessUtcMs);
        if (diff < minDiffMs) {
          minDiffMs = diff;
          targetSession = sess;
        }
      }
    }

    if (targetSession && targetSession.points.length > 0 && targetSession.points[0].timestamp) {
      const p0Date = new Date(targetSession.points[0].timestamp);
      const offset = this.calculateSyncOffset(track.rawRecordedAt, currentVidTz, p0Date, currentGpsTz);
      track.matchedSessionId = targetSession.id;
      track.syncOffsetSec = offset;
      track.isAutoMatched = true;
      console.log(`[VideoSync] 再同期完了: ${track.fileName} -> ${targetSession.sessionName} (オフセット: ${offset}s)`);
    }

    if (this.onTracksUpdated) this.onTracksUpdated(this.videos);
    return track;
  }

  // タイムスタンプによる全動画トラックのGPSセッション自動照合
  public autoMatchTracks(sessions: Session[]): void {
    if (sessions.length === 0 || this.videos.length === 0) return;

    for (const track of this.videos) {
      if (!track.rawRecordedAt) continue;

      const vidTz = track.videoTimezone || this.defaultVideoTimezone;
      const gpsTz = track.gpsTimezone || this.defaultGpsTimezone;
      const vidUtcMs = track.rawRecordedAt.getTime() - getTimezoneOffsetMs(vidTz);

      let bestSession: Session | null = null;
      let minDiffMs = Infinity;

      for (const sess of sessions) {
        if (sess.points.length === 0) continue;
        const p0 = sess.points[0];
        const p0Time = p0.timestamp ? new Date(p0.timestamp).getTime() : 0;
        if (p0Time === 0) continue;

        const sessUtcMs = p0Time - getTimezoneOffsetMs(gpsTz);
        const diffMs = Math.abs(vidUtcMs - sessUtcMs);

        // 同一セッション時間帯（±2時間以内、またはもっとも近いセッション）
        if (diffMs < minDiffMs && diffMs < 2 * 3600 * 1000) {
          minDiffMs = diffMs;
          bestSession = sess;
        }
      }

      if (bestSession && bestSession.points.length > 0 && bestSession.points[0].timestamp) {
        const p0Date = new Date(bestSession.points[0].timestamp);
        const offsetSec = this.calculateSyncOffset(track.rawRecordedAt, vidTz, p0Date, gpsTz);

        track.matchedSessionId = bestSession.id;
        track.syncOffsetSec = offsetSec;
        track.isAutoMatched = true;
        console.log(`[VideoSync] 自動同期マッチ: ${track.fileName} -> ${bestSession.fileName} (オフセット: ${offsetSec}秒)`);
      }
    }
  }

  // 手動時差シフト (例: ±9時間、±1時間のズレを一発補正)
  public shiftOffsetHours(trackId: string, deltaHours: number): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track) {
      track.syncOffsetSec = Number((track.syncOffsetSec + deltaHours * 3600).toFixed(3));
      track.isAutoMatched = false;
      if (this.onTracksUpdated) this.onTracksUpdated(this.videos);
    }
  }

  // 手動オフセット調整 (スピンボタン・フレーム微調整)
  public updateOffset(trackId: string, offsetSec: number): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track) {
      track.syncOffsetSec = Number(offsetSec.toFixed(3));
      track.isAutoMatched = false;
      if (this.onTracksUpdated) this.onTracksUpdated(this.videos);
    }
  }

  // ペアリングセッション変更
  public setMatchedSession(trackId: string, sessionId: string): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track) {
      track.matchedSessionId = sessionId;
      if (this.onTracksUpdated) this.onTracksUpdated(this.videos);
    }
  }

  // トラック削除
  public removeTrack(trackId: string): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track?.objectUrl) {
      URL.revokeObjectURL(track.objectUrl);
    }
    this.videos = this.videos.filter(v => v.id !== trackId);
    if (this.onTracksUpdated) this.onTracksUpdated(this.videos);
  }

  // 同期プロジェクト JSON エクスポート
  public exportProjectJson(sessions: Session[], circuitName: string): string {
    const data: SyncProjectData = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      circuitName,
      videos: this.videos.map(v => ({
        fileName: v.fileName,
        fileSize: v.fileSize,
        durationSec: v.durationSec,
        rawRecordedAt: v.rawRecordedAt ? v.rawRecordedAt.toISOString() : null,
        recordedAtJst: v.rawRecordedAt ? v.rawRecordedAt.toISOString() : null,
        videoTimezone: v.videoTimezone,
        gpsTimezone: v.gpsTimezone,
        matchedSessionId: v.matchedSessionId,
        syncOffsetSec: v.syncOffsetSec
      })),
      sessions: sessions.map(s => ({
        id: s.id,
        fileName: s.fileName,
        sessionName: s.sessionName,
        startDateJst: s.date,
        totalLaps: s.laps.length,
        samplingRate: s.samplingRate
      }))
    };

    return JSON.stringify(data, null, 2);
  }

  // 同期プロジェクト JSON インポート & 復元
  public importProjectJson(jsonText: string): SyncProjectData {
    const data: SyncProjectData = JSON.parse(jsonText);
    if (data.version !== '1.0' || !Array.isArray(data.videos)) {
      throw new Error('無効な同期プロジェクト JSON 形式です');
    }

    // 既存動画トラックのオフセットを上書き・復元
    for (const vData of data.videos) {
      const existing = this.videos.find(v => v.fileName === vData.fileName);
      if (existing) {
        existing.matchedSessionId = vData.matchedSessionId;
        existing.syncOffsetSec = vData.syncOffsetSec;
        if (vData.videoTimezone) existing.videoTimezone = vData.videoTimezone;
        if (vData.gpsTimezone) existing.gpsTimezone = vData.gpsTimezone;
        existing.isAutoMatched = false;
      } else {
        // ファイル未ロードのプレースホルダーとして登録
        const rawDate = vData.rawRecordedAt || vData.recordedAtJst;
        this.videos.push({
          id: `vid_imported_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          fileName: vData.fileName,
          fileSize: vData.fileSize,
          durationSec: vData.durationSec,
          rawRecordedAt: rawDate ? new Date(rawDate) : null,
          recordedAtJst: rawDate ? new Date(rawDate) : null,
          videoTimezone: vData.videoTimezone || this.defaultVideoTimezone,
          gpsTimezone: vData.gpsTimezone || this.defaultGpsTimezone,
          matchedSessionId: vData.matchedSessionId,
          syncOffsetSec: vData.syncOffsetSec,
          isAutoMatched: false,
          notes: '※ 動画ファイルを再選択してリンクしてください'
        });
      }
    }

    if (this.onTracksUpdated) this.onTracksUpdated(this.videos);
    return data;
  }
}

export const videoSyncManager = new VideoSyncManager();
