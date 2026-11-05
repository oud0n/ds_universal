import { fault, defaultText } from './errors';
/**
 * 複数車載動画 & GPS走行データ 自動同期・プロジェクト管理サービス
 */
import type { BinaryFile } from './ports';
import type { VideoTrack as CoreVideoTrack, PlacedTrack as CorePlacedTrack, RemoteVideo, SyncProjectData } from './videoTypes';
export { placeTrack, placeTracks, isClockManual } from './videoTypes';
import { Session } from '../types/telemetry';
import type { VideoMetadata } from './videoMetadataParser';
import { pinUtcMs, type SyncPin } from './videoSyncPinManager';
import { detectCircuitTimezone, scanBestTimezoneOffset } from './masterTimelineEngine';
import { groupVideoTracksByChapter, VideoChapterGroup, findChapterGroupForTrack } from './videoChapterManager';
import {
  VideoClock, ClockSource, NO_CLOCK, clockAtUtc, clockOnLog, shiftClock, clockOffsetIn, clockStartUtcMs, refreshClockUtc, sessionStartUtcMs
} from './mediaClock';

export { sessionStartUtcMs } from './mediaClock';


const isRemoteVideo = (file: BinaryFile | RemoteVideo): file is RemoteVideo => 'url' in file && 'path' in file;
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
function creationUtcMs(track: CoreVideoTrack): number | null {
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

export interface VideoSyncPorts<TFile extends BinaryFile> {
 remoteFile(remote: RemoteVideo): TFile;
 metadata(file: TFile): Promise<VideoMetadata>;
 gps(file: TFile, remote?: RemoteVideo): Promise<{videoStartUtcMs: number[]}>;
 open(file: { arrayBuffer(): Promise<ArrayBuffer> }): string;
 release(handle: string): void;
 nowMs(): number; random(): number;
}
export function createVideoSyncManager<TFile extends BinaryFile>(ports: VideoSyncPorts<TFile>) {
 type VideoTrack = CoreVideoTrack<TFile>;
 type PlacedTrack = CorePlacedTrack<TFile>;
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
    // 名前は拡張子を除いてくらべる (.bon4 で保存した同期を、.nmea で開いた同じ走行に戻すため。2026-10-21)
    const stem = (n: string) => n.replace(/\.(nmea|bon4|bnx4|bon|binx)$/i, '');
    const candidates = sessions.filter(s => s.fileName === saved.fileName || stem(s.fileName) === stem(saved.fileName));
    // 1 つのログが 2 つ以上の走行に分かれるとき (_1・_2) は、走行の名前で選ぶ
    const dated = candidates.filter(s => s.date === saved.startDateJst);
    const hit = (saved.filePart ? candidates.find(s => (s.sourceFile?.part ?? s.filePart) === saved.filePart) : undefined)
      ?? candidates.find(s => s.sessionName === saved.sessionName)
      ?? (dated.length === 1 ? dated[0] : undefined) ?? (candidates.length === 1 ? candidates[0] : undefined);
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

  public importedSessionIds(sessions: Session[]): Map<string, string> {
    const ids = new Map<string, string>();
    for (const saved of this.importedSessions) {
      const live = this.remapSessionId(saved.id, sessions);
      if (live && live !== saved.id && sessions.some(s => s.id === live)) ids.set(saved.id, live);
    }
    return ids;
  }

  private notify(): void {
    this.snapshot = [...this.videos];
    this.listeners.forEach(l => l());
  }

  // 元の動画より先に読み込んだ低画質のファイル (組にする名前 → ファイル)
  private pendingProxies = new Map<string, TFile>();

  private attachProxy(track: VideoTrack, file: TFile): void {
    if (track.proxyUrl) ports.release(track.proxyUrl);
    // .LRV はブラウザが種類を知らないファイルなので、MP4 として渡す (Safari は種類の分からない動画を再生しないことがある)
    track.proxyUrl = ports.open(file.slice(0, file.size, 'video/mp4'));
    track.proxyFileName = file.name;
  }

  // 複数動画ファイルの読み込み & 自動解析。GoPro の低画質のファイル (.LRV) は、元の動画に組にする (動画としては加えない)
  // readGps: false なら動画の GPS を読まない (呼ぶ側で読んで時刻を入れるとき。同じ動画を 2 回読まないため)
  public async addVideoFiles(files: ArrayLike<TFile | RemoteVideo>, sessions: Session[], readGps = true, isCurrent = () => true, beforePublish?: () => void): Promise<VideoTrack[]> {
    if (!isCurrent()) return this.videos;
    const inputs = Array.from(files);
    const prepared: Array<{ file: TFile; remote?: RemoteVideo; meta: VideoMetadata; gpsUtcMs?: number }> = [];
    const placeholderFor = (file: TFile) => this.videos.find(v => !v.objectUrl && v.fileName === file.name && (!v.fileSize || v.fileSize === file.size));
    // 全ファイルを読み終えてから、トラックと Blob URL を作る。途中で走行が替わったら何も残さない。
    for (const item of inputs.filter(f => !isProxyFileName(f.name))) {
      if (!isCurrent()) return this.videos;
      const remote = isRemoteVideo(item) ? item : undefined;
      const file = remote ? ports.remoteFile(remote) : item as TFile;
      const meta = await ports.metadata(file);
      if (!isCurrent()) return this.videos;
      let gpsUtcMs: number | undefined;
      if (readGps && !placeholderFor(file)) {
        try {
          const gps = await ports.gps(file, remote);
          gpsUtcMs = gps.videoStartUtcMs[0];
        } catch {
          // GoPro 以外の動画・測位できていない動画
        }
        if (!isCurrent()) return this.videos;
      }
      prepared.push({ file, remote, meta, gpsUtcMs });
    }
    if (!isCurrent()) return this.videos;
    beforePublish?.();
    if (!isCurrent()) return this.videos;
    const newTracks: VideoTrack[] = [];
    const gpsClocks = new Map<VideoTrack, number>();
    let relinked = false;

    for (const file of inputs.filter((f): f is TFile => !isRemoteVideo(f) && isProxyFileName(f.name))) {
      const key = proxyKey(file.name);
      if (!key) continue;
      const track = this.videos.find(v => proxyKey(v.fileName) === key);
      if (track) this.attachProxy(track, file); else this.pendingProxies.set(key, file);
    }
    for (const { file, remote, meta, gpsUtcMs } of prepared) {
      // 同期プロジェクトから戻した、ファイルのまだない動画と同じファイルなら、そこにつなぐ (保存した同期を引き継ぐ)
      const placeholder = placeholderFor(file);
      if (placeholder) {
        placeholder.file = remote ? undefined : file;
        placeholder.remote = remote;
        placeholder.objectUrl = remote ? remote.url : ports.open(file);
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
        id: `vid_${ports.nowMs()}_${ports.random().toString(36).substr(2, 5)}`,
        file: remote ? undefined : file,
        remote,
        objectUrl: remote ? remote.url : ports.open(file),
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
      if (gpsUtcMs !== undefined && Number.isFinite(gpsUtcMs)) gpsClocks.set(track, gpsUtcMs);
    }

    this.videos = [...this.videos, ...newTracks];

    // GPSセッションとの自動照合。追加した動画だけを照合し、手で合わせた既存の動画の同期は変えない
    this.autoMatchTracks(sessions, newTracks);
    // GoPro の動画は、動画自身の GPS の時刻で合わせる (撮影日時は ±1 秒ずれる)。GPS の記録がない動画は撮影日時のまま
    for (const [track, utcMs] of gpsClocks) track.clock = clockAtUtc('gps', utcMs);
    if (gpsClocks.size) this.updateChapterGroupOffsets();
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

  /** 同じ元partの再読込み。補正値と手動指定は保ち、参照するIDだけを更新する。 */
  public remapLiveSessionIds(ids: ReadonlyMap<string, string>): void {
    let changed = false;
    for (const track of this.videos) {
      if (track.matchedSessionId && ids.has(track.matchedSessionId)) { track.matchedSessionId = ids.get(track.matchedSessionId)!; changed = true; }
      if (track.clock.logId && ids.has(track.clock.logId)) { track.clock = { ...track.clock, logId: ids.get(track.clock.logId)! }; changed = true; }
    }
    if (changed) this.notify();
  }

  /**
   * 記録の細かいログへ自動で付け替える (LATER-12)。動画と時間の重なるログのうち、今のログと同じ走行 (同じ車) と確かめられた、
   * 記録のいちばん細かい (Hz の高い) ログに出す。時刻が重なるだけのログ (同じ走行枠のチームメイト) には付け替えない。
   * 利用者が選んだ動画は変えない。付け替えたものを [元のログ, 付け替えたログ] で返す
   */
  public async preferHighestRateSessions(sessions: Session[], sameRun: (a: Session, b: Session) => Promise<boolean>, context: {
    getSessions?: () => Session[];
    isCurrent?: () => boolean;
    onChanged?: (from: string, to: string) => void;
  } = {}): Promise<Array<[string, string]>> {
    const committed: Array<{ track: VideoTrack; from: string; to: string }> = [];
    const done = new Set<string>();
    const live = () => context.getSessions?.() ?? sessions;
    const currentRequest = () => context.isCurrent?.() ?? true;
    for (const track of [...this.videos]) {
      if (!currentRequest()) break;
      if (done.has(track.id) || track.isSessionChosenManually || !track.matchedSessionId) continue;
      const group = this.getChapterGroupForTrack(track.id);
      const targets = group ? group.tracks.map(ct => ct.track) : [track];
      targets.forEach(t => done.add(t.id));
      if (targets.some(t => t.isSessionChosenManually)) continue;
      const current = sessions.find(s => s.id === track.matchedSessionId);
      if (!current) continue;
      for (const candidate of overlappingSessions(track, sessions, this)) {
        if (candidate.id === current.id || (candidate.samplingRate || 0) <= (current.samplingRate || 0)) break;
        const same = await sameRun(current, candidate);
        if (!currentRequest()) break;
        const now = live();
        const nowGroup = this.getChapterGroupForTrack(track.id);
        const nowTargets = nowGroup ? nowGroup.tracks.map(ct => ct.track) : [track];
        const unchanged = targets.length === nowTargets.length && targets.every((t, i) => t === nowTargets[i]
          && this.videos.includes(t) && !t.isSessionChosenManually && t.matchedSessionId === current.id);
        const source = now.find(s => s.id === current.id), target = now.find(s => s.id === candidate.id);
        if (!unchanged || source?.points !== current.points || target?.points !== candidate.points
          || source?.clockOffsetSec !== current.clockOffsetSec || target?.clockOffsetSec !== candidate.clockOffsetSec) break;
        if (!same || !overlappingSessions(track, now, this).some(s => s.id === candidate.id)) continue;
        this.setMatchedSession(track.id, candidate.id);
        committed.push({ track, from: current.id, to: candidate.id });
        // 確定した同じ継続処理で通知する。別動画の照合待ちを挟んで Car を動かさない。
        context.onChanged?.(current.id, candidate.id);
        break;
      }
    }
    return currentRequest() ? committed.filter(c => this.videos.includes(c.track) && !c.track.isSessionChosenManually
      && c.track.matchedSessionId === c.to && live().some(s => s.id === c.to)).map(c => [c.from, c.to]) : [];
  }

  // トラック削除
  public removeTrack(trackId: string): void {
    const track = this.videos.find(v => v.id === trackId);
    if (track?.objectUrl) {
      ports.release(track.objectUrl);
    }
    if (track?.proxyUrl) ports.release(track.proxyUrl);
    this.videos = this.videos.filter(v => v.id !== trackId);
    this.notify();
  }

  // 同期プロジェクト JSON エクスポート
  /** onlyTracks: この動画だけ書く (走行の runs.json に、その走行の動画だけを書くとき。同じ名前のほかの走行の動画を混ぜない) */
  public exportProjectJson(sessions: Session[], circuitName: string, pins: SyncPin[] = [], onlyTracks?: Set<string>): string {
    const data: SyncProjectData = {
      version: '2.0',
      savedAt: new Date(ports.nowMs()).toISOString(),
      circuitName,
      videos: this.videos.filter(v => !onlyTracks || onlyTracks.has(v.id)).map(v => ({
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
        clockOffsetSec: s.clockOffsetSec ?? 0,
        filePart: s.sourceFile?.part ?? s.filePart
      })),
      pins: pins.map(p => ({
        name: p.name,
        sessionTimeSec: p.sessionTimeSec,
        videoTimeSec: p.videoTimeSec,
        calculatedOffsetSec: p.calculatedOffsetSec,
        trackFileName: this.videos.find(v => v.id === p.trackId)?.fileName ?? null,
        sessionId: p.sessionId ?? null,
        ...(pinUtcMs(p, sessions) !== null ? { utcMs: pinUtcMs(p, sessions)! } : {}),
        createdAt: p.createdAt
      }))
    };

    return JSON.stringify(data, null, 2);
  }

  /**
   * 同期プロジェクト JSON インポート & 復元。1.0 の形は 2.0 に読み替える。
   * clockOffsets: 保存したときの時計の補正 (今読み込んでいるログの分)。App で入れる
   */
  private applyVideoData(target: VideoTrack, vData: SyncProjectData['videos'][number], sessions: Session[]): void {
    target.matchedSessionId = vData.matchedSessionId;
    target.clock = { ...vData.clock };
    target.isSessionChosenManually = vData.sessionChosenManually || undefined;
    if (vData.videoTimezone) target.videoTimezone = vData.videoTimezone;
    if (vData.gpsTimezone) target.gpsTimezone = vData.gpsTimezone;
    target.isAutoMatched = false;
    this.remapTrack(target, sessions);
  }

  /**
   * 保存した同期を、名前でなく決まった 1 本の動画 (trackId) に戻す。
   * 比べる相手の走行の動画が、開いている動画と同じファイル名のとき (GoPro の GX010015.MP4 など) に使う。
   * 名前で戻す importProjectJson だと、開いている方の動画の同期を書き換えてしまうため (BUG-35 の (6))。
   * 先に importProjectJson で、その同期のログの一覧 (sessions) を覚えさせておくこと。値がおかしければ何もしない
   */
  public restoreTrackSync(trackId: string, vData: SyncProjectData['videos'][number], sessions: Session[]): boolean {
    return this.restoreTracksSync([{ trackId, vData }], sessions) > 0;
  }

  /**
   * いくつかの動画の同期を、まとめて戻す (restoreTrackSync の複数版)。全部を戻してから、チャプターの時刻をそろえる。
   * 1 本ずつそろえると、まだ戻していないチャプター (動画の GPS など、強い時刻) に、戻したチャプターの時刻が上書きされるため
   */
  public restoreTracksSync(list: Array<{ trackId: string; vData: SyncProjectData['videos'][number] }>, sessions: Session[]): number {
    let n = 0;
    for (const { trackId, vData } of list) {
      const target = this.videos.find(v => v.id === trackId);
      const c = vData?.clock;
      const ok = !!target && !!c && ['gps', 'manual', 'creation'].includes(c.source) && (c.logId === null || typeof c.logId === 'string') &&
        Number.isFinite(c.offsetSec) && Math.abs(c.offsetSec) <= 366 * 24 * 3600 && (c.utcMs === null || Number.isFinite(c.utcMs)) &&
        (vData.matchedSessionId === null || typeof vData.matchedSessionId === 'string');
      if (!ok || !target) continue;
      this.applyVideoData(target, vData, sessions);
      n++;
    }
    if (n) {
      this.updateChapterGroupOffsets();
      this.notify();
    }
    return n;
  }

  public importProjectJson(jsonText: string, sessions: Session[] = []): { data: SyncProjectData; clockOffsets: RestoredClockOffsets } {
    const parsed = JSON.parse(jsonText);
    if (!parsed || (parsed.version !== '1.0' && parsed.version !== '2.0') || !Array.isArray(parsed.videos)) {
      throw fault('videoSyncManager.1',{ja:'無効な同期プロジェクト JSON 形式です',en:'Invalid sync project JSON'});
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
      if (!ok) throw fault('videoSyncManager.2',{ja:`同期プロジェクト JSON の動画 ${v?.fileName ?? ''} の値が不正です`,en:`Invalid values for video ${v?.fileName ?? ''} in the sync project JSON`});
      const raw = v.rawRecordedAt || v.recordedAtJst;
      if (raw && Number.isNaN(new Date(raw).getTime())) throw fault('videoSyncManager.3',{ja:`同期プロジェクト JSON の動画 ${v.fileName} の記録日時が不正です`,en:`Invalid recording time for video ${v.fileName} in the sync project JSON`});
    }
    if (data.pins !== undefined) {
      if (!Array.isArray(data.pins)) throw fault('videoSyncManager.4',{ja:'同期プロジェクト JSON の同期ピンが不正です',en:'Invalid sync pins in the sync project JSON'});
      for (const p of data.pins) {
        const ok = p && typeof p.name === 'string' &&
          [p.sessionTimeSec, p.videoTimeSec, p.calculatedOffsetSec].every(x => Number.isFinite(x) && Math.abs(x) <= MAX_OFFSET_SEC) &&
          (p.trackFileName === null || typeof p.trackFileName === 'string') && (p.utcMs === undefined || Number.isFinite(p.utcMs));
        if (!ok) throw fault('videoSyncManager.5',{ja:`同期プロジェクト JSON の同期ピン ${p?.name ?? ''} の値が不正です`,en:`Invalid values for sync pin ${p?.name ?? ''} in the sync project JSON`});
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
          id: `vid_imported_${ports.nowMs()}_${ports.random().toString(36).substr(2, 4)}`,
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
      this.applyVideoData(target, vData, sessions);
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

return new VideoSyncManager();
}
export type VideoSyncManager<TFile extends BinaryFile = BinaryFile> = ReturnType<typeof createVideoSyncManager<TFile>>;


/** 動画の先頭のコマの本当の時刻 (UTC、ミリ秒)。決まらなければ null */
export function trackStartUtcMs(track: CoreVideoTrack, sessions: Session[]): number | null {
  return clockStartUtcMs(track.clock, sessions);
}

/**
 * 動画 (チャプターに分かれていれば全体) と時間の重なるログを、記録の細かい (Hz の高い) 順に並べる (同じなら重なりの長い順)。
 * 動画を出すログの候補 (LATER-12)
 */
export function overlappingSessions(track: CoreVideoTrack, sessions: Session[], manager: { getChapterGroupForTrack(id: string): VideoChapterGroup<CoreVideoTrack> | null }): Session[] {
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
