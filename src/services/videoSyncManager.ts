/**
 * 複数車載動画 & GPS走行データ 自動同期・プロジェクト管理サービス
 */
import { Session } from '../types/telemetry';
import { parseVideoMetadata, VideoMetadata } from './videoMetadataParser';
import type { SyncPin } from './videoSyncPinManager';
import { detectCircuitTimezone, scanBestTimezoneOffset } from './masterTimelineEngine';
import { groupVideoTracksByChapter, VideoChapterGroup, findChapterGroupForTrack } from './videoChapterManager';
import {
  VideoClock, ClockSource, NO_CLOCK, clockAtUtc, clockOnLog, shiftClock, clockOffsetIn, clockStartUtcMs, refreshClockUtc, sessionStartUtcMs
} from './mediaClock';

export { sessionStartUtcMs } from './mediaClock';
import { tr } from '../utils/i18n';
import { blobByteSource, parseGoproGps } from './gpmfParser';

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
export interface PlacedTrack extends VideoTrack {
  syncOffsetSec: number;
  /** そのログの時刻に置けた (時刻が分かった) か。置けないときの syncOffsetSec は 0 */
  isPlaced: boolean;
}

export function placeTrack(track: VideoTrack, session: Session | null | undefined, sessions: Session[]): PlacedTrack {
  const offset = clockOffsetIn(track.clock, session, sessions);
  return { ...track, syncOffsetSec: offset ?? 0, isPlaced: offset !== null };
}

/**
 * 動画をまとめて置く。ログがないとき (動画だけを読み込んだとき) は、いちばん早く始まる動画の頭を 0 秒として、撮影の時刻の差で並べる
 * (時刻の分からない動画は 0 秒から)。動画だけでも再生できるように
 */
export function placeTracks(tracks: VideoTrack[], session: Session | null | undefined, sessions: Session[]): PlacedTrack[] {
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
  }>;
  // 同期ピン。動画の ID は読み込むたびに変わるので、ファイル名で持つ
  pins?: Array<{
    name: string;
    sessionTimeSec: number;
    videoTimeSec: number;
    calculatedOffsetSec: number;
    trackFileName: string | null;
    /** ピンを打ったときの基準のログ (sessionTimeSec はこのログの時刻) */
    sessionId?: string | null;
    createdAt?: string;
  }>;
}

/** 1.0 の動画の行 (ずれは照合したログの先頭からの秒) */
interface SyncProjectVideoV1 {
  fileName: string;
  fileSize: number;
  durationSec: number;
  rawRecordedAt?: string | null;
  recordedAtJst: string | null;
  videoTimezone?: string;
  gpsTimezone?: string;
  matchedSessionId: string | null;
  syncOffsetSec: number;
}

/** 読み込んだ同期プロジェクトの、今のログでの時計の補正 ([ログの ID, 秒])。ログの状態は App が持つので、App に返して入れてもらう */
export type RestoredClockOffsets = Array<[string, number]>;

/** 撮影日時からの時刻 (UTC、ミリ秒)。videoTz で撮影日時を読み、gpsTz の分だけ戻す (2 つが同じなら撮影日時をそのまま使う) */
function creationUtcMs(track: VideoTrack): number | null {
  if (!track.rawRecordedAt) return null;
  return track.rawRecordedAt.getTime() - getTimezoneOffsetMs(track.videoTimezone || 'JST') + getTimezoneOffsetMs(track.gpsTimezone || 'JST');
}

const SOURCE_RANK: Record<ClockSource, number> = { manual: 2, gps: 1, creation: 0 };

/** GoPro の動画 (GX010015.MP4・GH010015.MP4) と低画質のファイル (GL010015.LRV) を組にする名前。組にならないものは null */
export function proxyKey(fileName: string): string | null {
  const v = /^G[XH](\d{2})(\d{4})\.(mp4|mov)$/i.exec(fileName);
  if (v) return `GL${v[1]}${v[2]}`;
  const l = /^GL(\d{2})(\d{4})\.lrv$/i.exec(fileName);
  return l ? `GL${l[1]}${l[2]}` : null;
}

export const isProxyFileName = (name: string): boolean => /\.lrv$/i.test(name);

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

  /** 動画の、表示のログと時刻を付けたログの ID を、今読み込んでいるログに読み替える */
  private remapTrack(v: VideoTrack, sessions: Session[]): boolean {
    const matched = this.remapSessionId(v.matchedSessionId, sessions);
    const logId = this.remapSessionId(v.clock.logId, sessions);
    if (matched === v.matchedSessionId && logId === v.clock.logId) return false;
    v.matchedSessionId = matched;
    v.clock = { ...v.clock, logId };
    return true;
  }

  // 保存したときの時計の補正で、まだログに入れていないもの (保存したときのログの ID → 秒)。一度入れたら消す
  // (利用者が後で変えた値を、保存した値に戻さないため)
  private pendingClockOffsets = new Map<string, number>();

  /**
   * 同期プロジェクトから戻した動画の照合先を、今読み込んでいるセッションに読み替える (ログを後から読み込んだとき用)。
   * 保存したときの時計の補正を、今読み込んでいるログの ID で返す (まだ入れていない分だけ)
   */
  public remapImportedSessions(sessions: Session[]): RestoredClockOffsets {
    if (this.importedSessions.length === 0 || sessions.length === 0) return [];
    let changed = false;
    for (const v of this.videos) if (this.remapTrack(v, sessions)) changed = true;
    if (changed) this.notify();
    const out: RestoredClockOffsets = [];
    for (const [savedId, sec] of this.pendingClockOffsets) {
      const id = this.remapSessionId(savedId, sessions);
      const session = id ? sessions.find(s => s.id === id) : undefined;
      if (!session) continue;
      if ((session.clockOffsetSec ?? 0) !== sec) out.push([session.id, sec]);
      this.pendingClockOffsets.delete(savedId);
    }
    return out;
  }

  private notify(): void {
    this.snapshot = [...this.videos];
    this.listeners.forEach(l => l());
  }

  // 元の動画より先に読み込んだ低画質のファイル (組にする名前 → ファイル)
  private pendingProxies = new Map<string, File>();

  private attachProxy(track: VideoTrack, file: File): void {
    if (track.proxyUrl) URL.revokeObjectURL(track.proxyUrl);
    // .LRV はブラウザが種類を知らないファイルなので、MP4 として渡す (Safari は種類の分からない動画を再生しないことがある)
    track.proxyUrl = URL.createObjectURL(file.slice(0, file.size, 'video/mp4'));
    track.proxyFileName = file.name;
  }

  // 複数動画ファイルの読み込み & 自動解析。GoPro の低画質のファイル (.LRV) は、元の動画に組にする (動画としては加えない)
  // readGps: false なら動画の GPS を読まない (呼ぶ側で読んで時刻を入れるとき。同じ動画を 2 回読まないため)
  public async addVideoFiles(files: FileList | File[], sessions: Session[], readGps = true): Promise<VideoTrack[]> {
    const newTracks: VideoTrack[] = [];
    let relinked = false;

    for (const file of Array.from(files).filter(f => isProxyFileName(f.name))) {
      const key = proxyKey(file.name);
      if (!key) continue;
      const track = this.videos.find(v => proxyKey(v.fileName) === key);
      if (track) this.attachProxy(track, file); else this.pendingProxies.set(key, file);
    }
    const videoFiles = Array.from(files).filter(f => !isProxyFileName(f.name));

    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i];
      const meta: VideoMetadata = await parseVideoMetadata(file);

      // 同期プロジェクトから戻した、ファイルのまだない動画と同じファイルなら、そこにつなぐ (保存した同期を引き継ぐ)
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
        this.remapTrack(placeholder, sessions);
        const pKey = proxyKey(file.name);
        const pFile = pKey ? this.pendingProxies.get(pKey) : undefined;
        if (pKey && pFile) { this.attachProxy(placeholder, pFile); this.pendingProxies.delete(pKey); }
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
        clock: NO_CLOCK,
        isAutoMatched: false
      };
      const utc = creationUtcMs(track);
      if (utc !== null) track.clock = clockAtUtc('creation', utc);
      const key = proxyKey(file.name);
      const proxy = key ? this.pendingProxies.get(key) : undefined;
      if (key && proxy) { this.attachProxy(track, proxy); this.pendingProxies.delete(key); }

      newTracks.push(track);
    }

    this.videos = [...this.videos, ...newTracks];

    // GPSセッションとの自動照合。追加した動画だけを照合し、手で合わせた既存の動画の同期は変えない
    this.autoMatchTracks(sessions, newTracks);
    // GoPro の動画は、動画自身の GPS の時刻で合わせる (撮影日時は ±1 秒ずれる)。GPS の記録がない動画は撮影日時のまま
    for (const track of readGps ? newTracks : []) {
      if (!track.file) continue;
      try {
        const gps = await parseGoproGps([blobByteSource(track.file)]);
        const utcMs = gps.videoStartUtcMs[0];
        if (Number.isFinite(utcMs)) track.clock = clockAtUtc('gps', utcMs);
      } catch {
        // GoPro 以外の動画・測位できていない動画
      }
    }
    if (newTracks.some(t => t.clock.source === 'gps')) this.updateChapterGroupOffsets();
    if (relinked && newTracks.length === 0) this.updateChapterGroupOffsets();

    this.notify();

    return this.videos;
  }

  /**
   * 撮影日時と時差の設定から、動画の時刻を入れ直す (時差を変えたとき・再同期のボタン)。手で合わせた時刻も撮影日時に戻す。
   * sessionId を渡せば、そのログに出す。渡さなければ、時間の重なるログ (記録の細かい順) に出す
   */
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

    const utc = creationUtcMs(track);
    if (utc !== null) {
      this.setClock(trackId, clockAtUtc('creation', utc));
      track.isAutoMatched = true;
    }
    const display = sessionId ?? overlappingSessions(track, sessions, this)[0]?.id;
    if (display) this.setMatchedSession(trackId, display);
    this.notify();
    return track;
  }

  // タイムスタンプによる全動画トラックのGPSセッション自動照合 (TZ完全自動判定 & 時差スキャン対応)
  // 撮影日時で決めた時刻の動画だけを照合する (動画の GPS・手で合わせた時刻は変えない)
  public autoMatchTracks(sessions: Session[], targets: VideoTrack[] = this.videos): void {
    if (sessions.length === 0 || targets.length === 0) return;

    for (const track of targets) {
      if (!track.rawRecordedAt || track.clock.source !== 'creation') continue;

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

      // 撮影日時は、ログの時刻のまま (時計の補正を引く前) の先頭と比べて求めた差なので、ログの時刻のままの先頭に足す
      // (補正を引いた先頭に足すと、カメラの時刻にロガーの時計の補正が混ざる)
      const raw = bestSession?.points[0]?.timestamp ? Date.parse(bestSession.points[0].timestamp) : NaN;
      const start = Number.isFinite(raw) ? raw : null;
      if (bestSession && start !== null) {
        track.matchedSessionId = bestSession.id;
        track.clock = clockAtUtc('creation', start + bestOffset * 1000);
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

  /**
   * チャプターに分かれた動画の時刻と表示のログを、グループでそろえる。
   * いちばん強い時刻 (手で合わせた > GPS > 撮影日時、同じなら前のチャプター) を基準に、チャプターの長さずつずらす
   * (後から前のチャプターを加えても、手で合わせた時刻を撮影日時で上書きしない)
   */
  public updateChapterGroupOffsets(): void {
    const { groups } = groupVideoTracksByChapter(this.videos);
    for (const group of groups) {
      if (group.tracks.length === 0) continue;
      const ref = group.tracks.reduce((a, b) => (SOURCE_RANK[b.track.clock.source] > SOURCE_RANK[a.track.clock.source] ? b : a));
      const display = ref.track.matchedSessionId ?? group.tracks.find(ct => ct.track.matchedSessionId)?.track.matchedSessionId ?? null;
      for (const ct of group.tracks) {
        if (ct !== ref) ct.track.clock = shiftClock(ref.track.clock, ct.groupOffsetSec - ref.groupOffsetSec);
        if (display) ct.track.matchedSessionId = display;
      }
    }
  }

  // 全チャプターグループを取得
  public getChapterGroups(): VideoChapterGroup<VideoTrack>[] {
    return groupVideoTracksByChapter(this.videos).groups;
  }

  // 特定トラックが属するチャプターグループを取得
  public getChapterGroupForTrack(trackId: string): VideoChapterGroup<VideoTrack> | null {
    const { groups } = groupVideoTracksByChapter(this.videos);
    return findChapterGroupForTrack(groups, trackId);
  }

  /** 動画の時刻を入れる。チャプターに分かれていれば、ほかのチャプターもチャプターの長さずつずらして入れる */
  public setClock(trackId: string, clock: VideoClock): void {
    const track = this.videos.find(v => v.id === trackId);
    if (!track) return;
    const group = this.getChapterGroupForTrack(trackId);
    const me = group?.tracks.find(ct => ct.track.id === trackId);
    if (group && me) {
      for (const ct of group.tracks) ct.track.clock = shiftClock(clock, ct.groupOffsetSec - me.groupOffsetSec);
    } else {
      track.clock = clock;
    }
    this.notify();
  }

  /**
   * 手で合わせる (ずれの入力・微調整・同期ピン)。session のログの時刻で、動画の先頭が offsetSec 秒の位置になるようにし、
   * その時刻をそのログに付ける (そのログの時計の補正を変えても、そのログのデータに合ったまま)
   */
  public setOffsetIn(trackId: string, session: Session, offsetSec: number): void {
    const track = this.videos.find(v => v.id === trackId);
    if (!track) return;
    track.isAutoMatched = false;
    this.setClock(trackId, clockOnLog('manual', session, offsetSec));
  }

  /** 動画自身の GPS で時刻を入れる。GPS のログを加えたときはそのログに付け、加えないときは GPS の時刻 (UTC) で持つ */
  public setGpsClock(trackId: string, gps: { session: Session; offsetSec: number } | { utcMs: number }): void {
    this.setClock(trackId, 'session' in gps ? clockOnLog('gps', gps.session, gps.offsetSec) : clockAtUtc('gps', gps.utcMs));
  }

  // 手動時差シフト (例: ±9時間、±1時間のズレを一発補正)
  public shiftOffsetHours(trackId: string, deltaHours: number): void {
    const track = this.videos.find(v => v.id === trackId);
    if (!track) return;
    track.isAutoMatched = false;
    this.setClock(trackId, { ...shiftClock(track.clock, deltaHours * 3600), source: 'manual' });
  }

  /** 動画を出すログを変える (チャプターに分かれていれば全部)。動画の時刻は変えない。null で走行から外す (未割り当て) */
  public setMatchedSession(trackId: string, sessionId: string | null): void {
    const group = this.getChapterGroupForTrack(trackId);
    const targets = group ? group.tracks.map(ct => ct.track) : this.videos.filter(v => v.id === trackId);
    if (targets.length === 0) return;
    targets.forEach(t => { t.matchedSessionId = sessionId; });
    this.notify();
  }

  /**
   * 利用者が「動画に合わせるログ」を選んだ。以後、記録の細かいログへの自動の付け替えをしない。
   * 動画の時刻は変えない (時刻はどのログからでも本当の時刻で換算できる)
   */
  public chooseSession(trackId: string, sessionId: string): void {
    const group = this.getChapterGroupForTrack(trackId);
    (group ? group.tracks.map(ct => ct.track) : this.videos.filter(v => v.id === trackId)).forEach(t => { t.isSessionChosenManually = true; });
    this.setMatchedSession(trackId, sessionId);
  }

  /**
   * 記録の細かいログへ自動で付け替える (LATER-12)。動画と時間の重なるログのうち、今のログと同じ走行 (同じ車) と確かめられた、
   * 記録のいちばん細かい (Hz の高い) ログに出す。時刻が重なるだけのログ (同じ走行枠のチームメイト) には付け替えない。
   * 利用者が選んだ動画は変えない。付け替えたものを [元のログ, 付け替えたログ] で返す
   */
  public async preferHighestRateSessions(sessions: Session[], sameRun: (a: Session, b: Session) => Promise<boolean>): Promise<Array<[string, string]>> {
    const changed: Array<[string, string]> = [];
    const done = new Set<string>();
    for (const track of [...this.videos]) {
      if (done.has(track.id) || track.isSessionChosenManually || !track.matchedSessionId) continue;
      const group = this.getChapterGroupForTrack(track.id);
      (group ? group.tracks.map(ct => ct.track) : [track]).forEach(t => done.add(t.id));
      if (group && group.tracks.some(ct => ct.track.isSessionChosenManually)) continue;
      const current = sessions.find(s => s.id === track.matchedSessionId);
      if (!current) continue;
      for (const c of overlappingSessions(track, sessions, this)) {
        if (c.id === current.id || (c.samplingRate || 0) <= (current.samplingRate || 0)) break;
        if (!(await sameRun(current, c))) continue;
        changed.push([current.id, c.id]);
        this.setMatchedSession(track.id, c.id);
        break;
      }
    }
    return changed;
  }

  // トラック削除
  public removeTrack(trackId: string): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track?.objectUrl) {
      URL.revokeObjectURL(track.objectUrl);
    }
    if (track?.proxyUrl) URL.revokeObjectURL(track.proxyUrl);
    this.videos = this.videos.filter(v => v.id !== trackId);
    this.notify();
  }

  // 同期プロジェクト JSON エクスポート
  public exportProjectJson(sessions: Session[], circuitName: string, pins: SyncPin[] = []): string {
    const data: SyncProjectData = {
      version: '2.0',
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
        sessionChosenManually: v.isSessionChosenManually || undefined,
        // 控えの UTC を今のログの時刻で入れ直す (ログを読み込まずに開いても位置が分かるように)
        clock: refreshClockUtc(v.clock, sessions)
      })),
      sessions: sessions.map(s => ({
        id: s.id,
        fileName: s.fileName,
        sessionName: s.sessionName,
        startDateJst: s.date,
        totalLaps: s.laps.length,
        samplingRate: s.samplingRate,
        clockOffsetSec: s.clockOffsetSec ?? 0
      })),
      pins: pins.map(p => ({
        name: p.name,
        sessionTimeSec: p.sessionTimeSec,
        videoTimeSec: p.videoTimeSec,
        calculatedOffsetSec: p.calculatedOffsetSec,
        trackFileName: this.videos.find(v => v.id === p.trackId)?.fileName ?? null,
        sessionId: p.sessionId ?? null,
        createdAt: p.createdAt
      }))
    };

    return JSON.stringify(data, null, 2);
  }

  /**
   * 同期プロジェクト JSON インポート & 復元。1.0 の形は 2.0 に読み替える。
   * clockOffsets: 保存したときの時計の補正 (今読み込んでいるログの分)。App で入れる
   */
  public importProjectJson(jsonText: string, sessions: Session[] = []): { data: SyncProjectData; clockOffsets: RestoredClockOffsets } {
    const parsed = JSON.parse(jsonText);
    if (!parsed || (parsed.version !== '1.0' && parsed.version !== '2.0') || !Array.isArray(parsed.videos)) {
      throw new Error(tr('無効な同期プロジェクト JSON 形式です', 'Invalid sync project JSON'));
    }
    const data: SyncProjectData = parsed.version === '1.0' ? upgradeProjectV1(parsed) : parsed;
    // 数値・文字列を検証する。NaN や極端な値のまま取り込むと、再生位置の計算が壊れて画面が固まる
    // 手で別の日のセッションに合わせた動画もあり得るので、オフセットの上限は 1 年とする (NaN・極端な値だけを断る)
    const MAX_OFFSET_SEC = 366 * 24 * 3600;
    const SOURCES: ClockSource[] = ['gps', 'manual', 'creation'];
    for (const v of data.videos) {
      const c = v?.clock;
      const ok = v && typeof v.fileName === 'string' &&
        c && SOURCES.includes(c.source) && (c.logId === null || typeof c.logId === 'string') &&
        Number.isFinite(c.offsetSec) && Math.abs(c.offsetSec) <= MAX_OFFSET_SEC &&
        (c.utcMs === null || Number.isFinite(c.utcMs)) &&
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
        if (!sd || typeof sd.id !== 'string' || typeof sd.fileName !== 'string') continue;
        if (Number.isFinite(sd.clockOffsetSec) && Math.abs(sd.clockOffsetSec!) <= 3600) this.pendingClockOffsets.set(sd.id, sd.clockOffsetSec!);
        const i = this.importedSessions.findIndex(x => x.id === sd.id);
        if (i >= 0) this.importedSessions[i] = sd; else this.importedSessions.push(sd);
      }
    }

    // 既存動画トラックの同期を上書き・復元
    for (const vData of data.videos) {
      const existing = this.videos.find(v => v.fileName === vData.fileName);
      const target: VideoTrack = existing ?? (() => {
        // ファイル未ロードのプレースホルダーとして登録
        const rawDate = vData.rawRecordedAt || vData.recordedAtJst;
        const t: VideoTrack = {
          id: `vid_imported_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          fileName: vData.fileName,
          fileSize: vData.fileSize,
          durationSec: vData.durationSec,
          rawRecordedAt: rawDate ? new Date(rawDate) : null,
          recordedAtJst: rawDate ? new Date(rawDate) : null,
          videoTimezone: this.defaultVideoTimezone,
          gpsTimezone: this.defaultGpsTimezone,
          matchedSessionId: null,
          clock: NO_CLOCK,
          isAutoMatched: false,
          notes: '※ 動画ファイルを再選択してリンクしてください'
        };
        this.videos.push(t);
        return t;
      })();
      target.matchedSessionId = vData.matchedSessionId;
      target.clock = { ...vData.clock };
      target.isSessionChosenManually = vData.sessionChosenManually || undefined;
      if (vData.videoTimezone) target.videoTimezone = vData.videoTimezone;
      if (vData.gpsTimezone) target.gpsTimezone = vData.gpsTimezone;
      target.isAutoMatched = false;
      this.remapTrack(target, sessions);
    }

    this.updateChapterGroupOffsets();
    this.notify();
    return { data, clockOffsets: this.remapImportedSessions(sessions) };
  }
}

/**
 * 1.0 の同期プロジェクトを 2.0 に読み替える。1.0 のずれは「照合したログの先頭 (時計の補正なし) からの秒」で、
 * 1.0 のころは時計の補正がなかった (0 だった)。復元した同期は手で合わせたものとして扱っていたので、そのとおりにする
 */
function upgradeProjectV1(v1: { savedAt: string; circuitName: string; videos: SyncProjectVideoV1[]; sessions?: SyncProjectData['sessions']; pins?: SyncProjectData['pins'] }): SyncProjectData {
  return {
    version: '2.0',
    savedAt: v1.savedAt,
    circuitName: v1.circuitName,
    videos: v1.videos.map(v => {
      const offset = Number(v?.syncOffsetSec);
      return {
        ...v,
        clock: v?.matchedSessionId
          ? { source: 'manual' as const, logId: v.matchedSessionId, offsetSec: offset, utcMs: null }
          : { source: 'creation' as const, logId: null, offsetSec: 0, utcMs: null }
      };
    }),
    // 1.0 のころは時計の補正がなかった。今のログの補正は変えない
    sessions: Array.isArray(v1.sessions) ? v1.sessions : [],
    pins: v1.pins
  };
}

export const videoSyncManager = new VideoSyncManager();

/** 動画の先頭のコマの本当の時刻 (UTC、ミリ秒)。決まらなければ null */
export function trackStartUtcMs(track: VideoTrack, sessions: Session[]): number | null {
  return clockStartUtcMs(track.clock, sessions);
}

/**
 * 動画 (チャプターに分かれていれば全体) と時間の重なるログを、記録の細かい (Hz の高い) 順に並べる (同じなら重なりの長い順)。
 * 動画を出すログの候補 (LATER-12)
 */
export function overlappingSessions(track: VideoTrack, sessions: Session[], manager: VideoSyncManager = videoSyncManager): Session[] {
  // チャプターに分かれた動画は、最初のチャプターの頭から全部のチャプターの長さで見る (どのチャプターを渡されても同じ範囲)
  const group = manager.getChapterGroupForTrack(track.id);
  const multi = !!group && group.tracks.length > 1;
  const lead = multi ? group!.tracks[0].track : track;
  const start = trackStartUtcMs(lead, sessions);
  if (start === null) return [];
  const dur = multi ? group!.totalDurationSec : track.durationSec;
  const end = start + Math.max(0, dur || 0) * 1000;
  const scored: Array<{ s: Session; overlap: number }> = [];
  for (const s of sessions) {
    const a = sessionStartUtcMs(s);
    const last = s.points[s.points.length - 1];
    if (a === null || !last) continue;
    const b = a + last.time * 1000;
    const overlap = Math.min(end, b) - Math.max(start, a);
    if (overlap > 0) scored.push({ s, overlap });
  }
  scored.sort((x, y) => (y.s.samplingRate || 0) - (x.s.samplingRate || 0) || y.overlap - x.overlap);
  return scored.map(x => x.s);
}
