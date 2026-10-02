/**
 * 複数車載動画 & GPS走行データ 自動同期・プロジェクト管理サービス
 */
import { Session } from '../types/telemetry';
import { parseVideoMetadata, VideoMetadata } from './videoMetadataParser';

export interface VideoTrack {
  id: string;
  file?: File;
  objectUrl?: string;
  fileName: string;
  fileSize: number;
  durationSec: number;
  recordedAtJst: Date | null;
  matchedSessionId: string | null;
  syncOffsetSec: number; // GPSセッション t=0 に対する動画開始位置のオフセット (秒)
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
    recordedAtJst: string | null;
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
        recordedAtJst: meta.creationTime,
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

  // JSTタイムスタンプによるGPSセッションとの自動照合
  public autoMatchTracks(sessions: Session[]): void {
    if (sessions.length === 0 || this.videos.length === 0) return;

    for (const track of this.videos) {
      if (!track.recordedAtJst) continue;

      const vidStartMs = track.recordedAtJst.getTime();
      let bestSession: Session | null = null;
      let minDiffMs = Infinity;

      for (const sess of sessions) {
        if (sess.points.length === 0) continue;
        const p0 = sess.points[0];
        const sessStartMs = p0.timestamp ? new Date(p0.timestamp).getTime() : 0;
        if (sessStartMs === 0) continue;

        const pLast = sess.points[sess.points.length - 1];
        const sessEndMs = pLast.timestamp ? new Date(pLast.timestamp).getTime() : sessStartMs;

        // 動画の開始時刻がセッション時間帯（±10分）に含まれているか
        const diffMs = Math.abs(vidStartMs - sessStartMs);
        if (diffMs < minDiffMs && diffMs < 10 * 60 * 1000) {
          minDiffMs = diffMs;
          bestSession = sess;
        }
      }

      if (bestSession && bestSession.points.length > 0) {
        const p0 = bestSession.points[0];
        const sessStartMs = p0.timestamp ? new Date(p0.timestamp).getTime() : 0;
        const offsetSec = Number(((vidStartMs - sessStartMs) / 1000).toFixed(2));

        track.matchedSessionId = bestSession.id;
        track.syncOffsetSec = offsetSec;
        track.isAutoMatched = true;
        console.log(`[VideoSync] 自動同期マッチ: ${track.fileName} -> ${bestSession.fileName} (オフセット: ${offsetSec}秒)`);
      }
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
        recordedAtJst: v.recordedAtJst ? v.recordedAtJst.toISOString() : null,
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
        existing.isAutoMatched = false;
      } else {
        // ファイル未ロードのプレースホルダーとして登録
        this.videos.push({
          id: `vid_imported_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          fileName: vData.fileName,
          fileSize: vData.fileSize,
          durationSec: vData.durationSec,
          recordedAtJst: vData.recordedAtJst ? new Date(vData.recordedAtJst) : null,
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
