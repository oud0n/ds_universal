/**
 * 複数車載動画 & GPS走行データ 自動同期・プロジェクト管理サービス
 */
import { Session } from '../types/telemetry';
import { parseVideoMetadata, VideoMetadata } from './videoMetadataParser';
import type { SyncPin } from './videoSyncPinManager';
import { detectCircuitTimezone, scanBestTimezoneOffset } from './masterTimelineEngine';
import { 
  groupVideoTracksByChapter, 
  syncGroupOffsets, 
  VideoChapterGroup, 
  VideoChapterTrack,
  findChapterGroupForTrack
} from './videoChapterManager';
import { tr } from '../utils/i18n';

export type TimezoneMode = 'JST' | 'UTC' | 'LOCAL' | '+8' | '+1' | '-5' | '-8';

export const TIMEZONE_OPTIONS: { value: string; label: string; labelEn: string; offsetHours: number }[] = [
  { value: 'JST', label: 'JST (UTC+9: 日本標準時)', labelEn: 'JST (UTC+9: Japan)', offsetHours: 9 },
  { value: 'UTC', label: 'UTC (±0: 世界標準時 / GPS時刻)', labelEn: 'UTC (±0: GPS time)', offsetHours: 0 },
  { value: 'LOCAL', label: 'PCローカル時刻', labelEn: 'PC local time', offsetHours: -new Date().getTimezoneOffset() / 60 },
  { value: '+8', label: 'UTC+8 (アジア標準時)', labelEn: 'UTC+8 (Asia)', offsetHours: 8 },
  { value: '+1', label: 'UTC+1 (CET: 欧州中央時)', labelEn: 'UTC+1 (CET: Central Europe)', offsetHours: 1 },
  { value: '-5', label: 'UTC-5 (EST: 米東部標準時)', labelEn: 'UTC-5 (EST: US Eastern)', offsetHours: -5 },
  { value: '-8', label: 'UTC-8 (PST: 米太平洋標準時)', labelEn: 'UTC-8 (PST: US Pacific)', offsetHours: -8 }
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
  // 利用者がオフセットを手で合わせた (または同期プロジェクトから復元した) もの。自動の再同期では上書きしない
  isManuallyAdjusted?: boolean;
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
  // 同期ピン (古い同期プロジェクトにはない)。動画の ID は読み込むたびに変わるので、ファイル名で持つ
  pins?: Array<{
    name: string;
    sessionTimeSec: number;
    videoTimeSec: number;
    calculatedOffsetSec: number;
    trackFileName: string | null;
    createdAt?: string;
  }>;
}

class VideoSyncManager {
  private videos: VideoTrack[] = [];
  public defaultVideoTimezone: string = 'JST';
  public defaultGpsTimezone: string = 'JST';
  // 変更の通知先。動画のウインドウは同時にいくつも開けるので、全員に知らせる
  private listeners = new Set<() => void>();
  // useSyncExternalStore 用の、変更のたびに作り直す一覧 (トラックの中身は同じオブジェクトを書き換えるため)
  private snapshot: VideoTrack[] = [];

  public getTracks(): VideoTrack[] {
    return this.videos;
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  public getSnapshot = (): VideoTrack[] => this.snapshot;

  // 同期プロジェクトに保存されていたセッション。セッションの ID は読み込むたびに変わるので、ファイル名と開始日時で今のセッションに読み替える
  private importedSessions: SyncProjectData['sessions'] = [];

  private remapSessionId(savedId: string | null, sessions: Session[]): string | null {
    if (!savedId) return null;
    if (sessions.some(s => s.id === savedId)) return savedId;
    const saved = this.importedSessions.find(s => s.id === savedId);
    if (!saved) return savedId;
    const candidates = sessions.filter(s => s.fileName === saved.fileName);
    const hit = candidates.find(s => s.date === saved.startDateJst) ?? (candidates.length === 1 ? candidates[0] : undefined);
    return hit ? hit.id : savedId;
  }

  /** 同期プロジェクトから戻した動画の照合先を、今読み込んでいるセッションに読み替える (ログを後から読み込んだとき用) */
  public remapImportedSessions(sessions: Session[]): void {
    if (this.importedSessions.length === 0 || sessions.length === 0) return;
    let changed = false;
    for (const v of this.videos) {
      const id = this.remapSessionId(v.matchedSessionId, sessions);
      if (id !== v.matchedSessionId) { v.matchedSessionId = id; changed = true; }
    }
    if (changed) {
      this.updateChapterGroupOffsets();
      this.notify();
    }
  }

  private notify(): void {
    this.snapshot = [...this.videos];
    this.listeners.forEach(l => l());
  }

  // 複数動画ファイルの読み込み & 自動解析
  public async addVideoFiles(files: FileList | File[], sessions: Session[]): Promise<VideoTrack[]> {
    const newTracks: VideoTrack[] = [];
    let relinked = false;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const meta: VideoMetadata = await parseVideoMetadata(file);

      // 同期プロジェクトから戻した、ファイルのまだない動画と同じファイルなら、そこにつなぐ (保存したオフセットを引き継ぐ)
      const placeholder = this.videos.find(v =>
        !v.objectUrl && v.fileName === file.name && (!v.fileSize || v.fileSize === file.size));
      if (placeholder) {
        placeholder.file = file;
        placeholder.objectUrl = URL.createObjectURL(file);
        placeholder.fileSize = file.size;
        if (meta.durationSec > 0) placeholder.durationSec = meta.durationSec;
        if (!placeholder.rawRecordedAt && meta.creationTime) {
          placeholder.rawRecordedAt = meta.creationTime;
          placeholder.recordedAtJst = meta.creationTime;
        }
        placeholder.notes = undefined;
        placeholder.matchedSessionId = this.remapSessionId(placeholder.matchedSessionId, sessions);
        relinked = true;
        continue;
      }

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

    // GPSセッションとの自動照合。追加した動画だけを照合し、手で合わせた既存の動画の同期は変えない
    this.autoMatchTracks(sessions, newTracks);
    if (relinked && newTracks.length === 0) this.updateChapterGroupOffsets();

    this.notify();

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
      this.notify();
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
      // 利用者が再同期を指示した (または時差の設定を変えた) ので、手で合わせた状態は解除する
      this.setManuallyAdjusted(trackId, false);
      console.log(`[VideoSync] 再同期完了: ${track.fileName} -> ${targetSession.sessionName} (オフセット: ${offset}s)`);

      const group = this.getChapterGroupForTrack(trackId);
      if (group) {
        const cTrack = group.tracks.find(ct => ct.track.id === trackId);
        if (cTrack) {
          const newBase = offset - cTrack.groupOffsetSec;
          // グループのセッションは、先頭のチャプターの古い照合先でなく、今照合したセッションにそろえる
          group.matchedSessionId = targetSession.id;
          syncGroupOffsets(group, newBase);
        }
      }
    }

    this.updateChapterGroupOffsets();
    this.notify();
    return track;
  }

  // タイムスタンプによる全動画トラックのGPSセッション自動照合 (TZ完全自動判定 & 時差スキャン対応)
  public autoMatchTracks(sessions: Session[], targets: VideoTrack[] = this.videos): void {
    if (sessions.length === 0 || targets.length === 0) return;

    for (const track of targets) {
      if (!track.rawRecordedAt || track.isManuallyAdjusted) continue;

      let bestSession: Session | null = null;
      let minDiffSec = Infinity;
      let bestOffset = 0;
      let detectedCircuitTz = 'JST';
      let detectedShift = 0;

      for (const sess of sessions) {
        if (sess.points.length === 0) continue;
        const p0 = sess.points[0];
        if (!p0.timestamp) continue;
        const p0Date = new Date(p0.timestamp);

        // 1. サーキット現地タイムゾーンの自動判定 (日本ならJST)
        const circuitTz = detectCircuitTimezone(p0.latitude, p0.longitude);

        // 2. 時差スキャン (0h, ±9h, ±8h 等のズレを自動検出)
        const scan = scanBestTimezoneOffset(track.rawRecordedAt, p0Date, circuitTz);
        // どの時差でも近い時刻にならなかったセッションは候補にしない (照合の失敗を「差 0 秒で一致」と扱わない)
        // 時差をずらして初めて 30 分より近くなる程度の一致も使わない。切り出して書き出した動画は、撮影日時の欄に書き出した時刻が入っており、
        // 時差の候補のどれかで偶然 4 時間以内に収まってしまうため
        if (!scan.found || (scan.confidence === 'low' && scan.detectedShiftHours !== 0)) continue;
        const absDiff = Math.abs(scan.bestOffsetSec);

        if (absDiff < minDiffSec) {
          minDiffSec = absDiff;
          bestSession = sess;
          bestOffset = scan.bestOffsetSec;
          detectedCircuitTz = circuitTz;
          detectedShift = scan.detectedShiftHours;
        }
      }

      if (bestSession && bestSession.points.length > 0 && bestSession.points[0].timestamp) {
        track.matchedSessionId = bestSession.id;
        track.syncOffsetSec = bestOffset;
        track.gpsTimezone = detectedCircuitTz;
        // もし動画がUTCで記録されていた場合 (9時間ズレ検出)
        if (detectedShift === 9) {
          track.videoTimezone = 'UTC';
        } else if (detectedShift === -9) {
          track.videoTimezone = 'JST';
        } else {
          track.videoTimezone = detectedCircuitTz;
        }
        track.isAutoMatched = true;
        console.log(`[VideoSync] 自動TZ同期完了: ${track.fileName} -> ${bestSession.fileName} (オフセット: ${bestOffset}s, TZ: ${track.videoTimezone}/${track.gpsTimezone}, シフト: ${detectedShift}h)`);
      }
    }

    // チャプター分割ファイルが存在する場合、チャプターグループの連動オフセットを適用
    this.updateChapterGroupOffsets();
  }

  // チャプターグループの検出とオフセット連動更新
  public updateChapterGroupOffsets(): void {
    const { groups } = groupVideoTracksByChapter(this.videos);
    for (const group of groups) {
      if (group.tracks.length > 0) {
        // 手で合わせたチャプターがあればそれを、なければ先頭チャプターを基準に、offset / matchedSessionId をグループ全体に波及
        // (後から先頭チャプターを追加しても、手で合わせた値を自動照合の値で上書きしない)
        const ref = group.tracks.find(ct => ct.track.isManuallyAdjusted) ?? group.tracks[0];
        if (ref.track.matchedSessionId) {
          group.matchedSessionId = ref.track.matchedSessionId;
        }
        syncGroupOffsets(group, ref.track.syncOffsetSec - ref.groupOffsetSec);
        if (ref.track.isManuallyAdjusted) group.tracks.forEach(ct => { ct.track.isManuallyAdjusted = true; });
      }
    }
  }

  /** 手で合わせたかどうかを、同じチャプターグループの動画すべてにそろえる (オフセットはグループで連動するため) */
  private setManuallyAdjusted(trackId: string, value: boolean): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track) track.isManuallyAdjusted = value;
    const group = this.getChapterGroupForTrack(trackId);
    group?.tracks.forEach(ct => { ct.track.isManuallyAdjusted = value; });
  }

  // 全チャプターグループを取得
  public getChapterGroups(): VideoChapterGroup[] {
    return groupVideoTracksByChapter(this.videos).groups;
  }

  // 特定トラックが属するチャプターグループを取得
  public getChapterGroupForTrack(trackId: string): VideoChapterGroup | null {
    const { groups } = groupVideoTracksByChapter(this.videos);
    return findChapterGroupForTrack(groups, trackId);
  }

  // 手動時差シフト (例: ±9時間、±1時間のズレを一発補正)
  public shiftOffsetHours(trackId: string, deltaHours: number): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track) {
      track.syncOffsetSec = Number((track.syncOffsetSec + deltaHours * 3600).toFixed(3));
      track.isAutoMatched = false;
      this.setManuallyAdjusted(trackId, true);

      // チャプターグループ内の場合、連動して他のチャプターもシフト
      const group = this.getChapterGroupForTrack(trackId);
      if (group) {
        const cTrack = group.tracks.find(ct => ct.track.id === trackId);
        if (cTrack) {
          // cTrack.track.syncOffsetSec = baseSyncOffsetSec + cTrack.groupOffsetSec
          // 逆算して baseSyncOffsetSec を更新
          const newBase = track.syncOffsetSec - cTrack.groupOffsetSec;
          syncGroupOffsets(group, newBase);
        }
      }

      this.notify();
    }
  }

  // 手動オフセット調整 (スピンボタン・フレーム微調整)
  public updateOffset(trackId: string, offsetSec: number): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track) {
      track.syncOffsetSec = Number(offsetSec.toFixed(3));
      track.isAutoMatched = false;
      this.setManuallyAdjusted(trackId, true);

      // チャプターグループ内の場合、連動して他のチャプターもシフト
      const group = this.getChapterGroupForTrack(trackId);
      if (group) {
        const cTrack = group.tracks.find(ct => ct.track.id === trackId);
        if (cTrack) {
          const newBase = track.syncOffsetSec - cTrack.groupOffsetSec;
          syncGroupOffsets(group, newBase);
        }
      }

      this.notify();
    }
  }

  // ペアリングセッション変更
  public setMatchedSession(trackId: string, sessionId: string): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track) {
      track.matchedSessionId = sessionId;
      this.notify();
    }
  }

  // トラック削除
  public removeTrack(trackId: string): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track?.objectUrl) {
      URL.revokeObjectURL(track.objectUrl);
    }
    this.videos = this.videos.filter(v => v.id !== trackId);
    this.notify();
  }

  // 同期プロジェクト JSON エクスポート
  public exportProjectJson(sessions: Session[], circuitName: string, pins: SyncPin[] = []): string {
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
      })),
      pins: pins.map(p => ({
        name: p.name,
        sessionTimeSec: p.sessionTimeSec,
        videoTimeSec: p.videoTimeSec,
        calculatedOffsetSec: p.calculatedOffsetSec,
        trackFileName: this.videos.find(v => v.id === p.trackId)?.fileName ?? null,
        createdAt: p.createdAt
      }))
    };

    return JSON.stringify(data, null, 2);
  }

  // 同期プロジェクト JSON インポート & 復元
  public importProjectJson(jsonText: string, sessions: Session[] = []): SyncProjectData {
    const data: SyncProjectData = JSON.parse(jsonText);
    if (!data || data.version !== '1.0' || !Array.isArray(data.videos)) {
      throw new Error(tr('無効な同期プロジェクト JSON 形式です', 'Invalid sync project JSON'));
    }
    // 数値・文字列を検証する。NaN や極端な値のまま取り込むと、再生位置の計算が壊れて画面が固まる
    // 手で別の日のセッションに合わせた動画もあり得るので、オフセットの上限は 1 年とする (NaN・極端な値だけを断る)
    const MAX_OFFSET_SEC = 366 * 24 * 3600;
    for (const v of data.videos) {
      const ok = v && typeof v.fileName === 'string' &&
        Number.isFinite(v.syncOffsetSec) && Math.abs(v.syncOffsetSec) <= MAX_OFFSET_SEC &&
        Number.isFinite(v.durationSec) && v.durationSec >= 0 && v.durationSec <= 7 * 24 * 3600 &&
        Number.isFinite(v.fileSize) && v.fileSize >= 0 &&
        (v.matchedSessionId === null || typeof v.matchedSessionId === 'string');
      if (!ok) throw new Error(tr(`同期プロジェクト JSON の動画 ${v?.fileName ?? ''} の値が不正です`, `Invalid values for video ${v?.fileName ?? ''} in the sync project JSON`));
      const raw = v.rawRecordedAt || v.recordedAtJst;
      if (raw && Number.isNaN(new Date(raw).getTime())) throw new Error(tr(`同期プロジェクト JSON の動画 ${v.fileName} の記録日時が不正です`, `Invalid recording time for video ${v.fileName} in the sync project JSON`));
    }
    if (data.pins !== undefined) {
      if (!Array.isArray(data.pins)) throw new Error(tr('同期プロジェクト JSON の同期ピンが不正です', 'Invalid sync pins in the sync project JSON'));
      for (const p of data.pins) {
        const ok = p && typeof p.name === 'string' &&
          [p.sessionTimeSec, p.videoTimeSec, p.calculatedOffsetSec].every(x => Number.isFinite(x) && Math.abs(x) <= MAX_OFFSET_SEC) &&
          (p.trackFileName === null || typeof p.trackFileName === 'string');
        if (!ok) throw new Error(tr(`同期プロジェクト JSON の同期ピン ${p?.name ?? ''} の値が不正です`, `Invalid values for sync pin ${p?.name ?? ''} in the sync project JSON`));
      }
    }

    // 保存したときのセッションの一覧を覚えておく (ログを後から読み込んだときにも読み替えられるように)
    if (Array.isArray(data.sessions)) {
      for (const sd of data.sessions) {
        if (sd && typeof sd.id === 'string' && typeof sd.fileName === 'string' && !this.importedSessions.some(x => x.id === sd.id)) {
          this.importedSessions.push(sd);
        }
      }
    }

    // 既存動画トラックのオフセットを上書き・復元
    for (const vData of data.videos) {
      vData.matchedSessionId = this.remapSessionId(vData.matchedSessionId, sessions);
      const existing = this.videos.find(v => v.fileName === vData.fileName);
      if (existing) {
        existing.matchedSessionId = vData.matchedSessionId;
        existing.syncOffsetSec = vData.syncOffsetSec;
        if (vData.videoTimezone) existing.videoTimezone = vData.videoTimezone;
        if (vData.gpsTimezone) existing.gpsTimezone = vData.gpsTimezone;
        existing.isAutoMatched = false;
        existing.isManuallyAdjusted = true;
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
          isManuallyAdjusted: true,
          notes: '※ 動画ファイルを再選択してリンクしてください'
        });
      }
    }

    this.updateChapterGroupOffsets();
    this.notify();
    return data;
  }
}

export const videoSyncManager = new VideoSyncManager();
