import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { 
  Play, Pause, SkipBack, SkipForward, Video, Upload, 
  Save, FolderOpen, RefreshCw, Sliders, Eye, EyeOff, 
  Clock, Gauge, Plus, Trash2, CheckCircle2, ChevronRight,
  Globe, AlertTriangle, Zap, Layers, ChevronLeft,
  Columns, PictureInPicture, MapPin, Download, X,
  ArrowLeftRight, VolumeX, Maximize2, ListChecks
} from 'lucide-react';
import { Session, TelemetryPoint, SelectedCarSlot, Lap } from '../types/telemetry';
import { getAddVideoGpsLog, setAddVideoGpsLog } from '../services/videoPrefs';
import { videoSyncManager, PlacedTrack, TIMEZONE_OPTIONS, getTimezoneOffsetMs, overlappingSessions, placeTracks } from '../services/videoSyncManager';
import { clockOffsetIn, sessionStartUtcMs } from '../services/mediaClock';
import { RunsInspector, syncBadgeOf, BADGE_CLASS } from './video/RunsInspector';
import { getNextChapter, getPreviousChapter, groupVideoTracksByChapter } from '../services/videoChapterManager';
import { 
  SyncPin, 
  createSyncPin, 
  formatPinTime
} from '../services/videoSyncPinManager';
import { videoViewStore, useVideoView, useVideoTracks, useSyncPins, useWindowView, PipPosition, MAX_CAMERAS, videoEndSessionSec } from '../services/videoViewStore';
import { PlaybackController, PlaybackTarget } from '../services/playbackController';
import { buildMedia, positionInMedia, positionAtMediaTime, mediaForLap, mediaStartIn, PlayableMedia, MediaPosition } from '../services/playableMedia';
import { VideoTile, TileOverlay } from './video/VideoTile';
import { VideoStage } from './video/VideoStage';
import { 
  exportBurnedInVideo, 
  recordCanvas,
  downloadBlob,
  VideoExportController 
} from '../services/telemetryVideoExporter';
import { MasterTimelineTrackBar } from './MasterTimelineTrackBar';
import { formatMinSec } from '../utils/timeFormat';
import { tr, useT } from '../utils/i18n';
import { fileAccept } from '../utils/device';
import { useCompactLayout, useLandscape } from '../hooks/useCompactLayout';

export type { PipPosition };

interface VideoSyncWindowProps {
  sessions: Session[];
  selectedCars: SelectedCarSlot[];
  currentTimeSec: number;
  currentDistanceKm: number;
  isPlaying: boolean;
  onSeekTime: (timeSec: number) => void;
  onTogglePlay: () => void;
  circuitName: string;
  targetSessionId?: string;  // 速度ウィンドウで選択中のセッションID
  targetLap?: any;           // 速度ウィンドウで選択中のラップ
  isGraphEmbedded?: boolean; // グラフ解析画面に埋め込まれているかどうか
  // 画面に見えているか。見えていないウインドウ (隠れている動画同期タブ・グラフ画面) では動画を再生しない
  isVisible?: boolean;
  playbackSpeed: number;
  onChangePlaybackSpeed: (speed: number) => void;
  // 動画に合わせるログを選んだとき (そのログを基準車 Car 1 にする)。LATER-12
  onChooseLog?: (sessionId: string) => void;
  // 走行比較で Car 2 がいないとき、Car 2 に入れる周 (同じログの別の周) を選ぶ
  onPickCompareLap?: (sessionId: string, lapNumber: number) => void;
  /** ファイルを読み込む (ヘッダーの「読込」と同じ。GoPro の動画は GPS を走行ログにしてから動画同期に登録する) */
  onLoadFiles?: (files: File[]) => Promise<void>;
  // ウインドウごとの表示の状態 (並べ方など) を覚えるときの名前
  viewKey: string;
  // ログの時計の補正を入れる (同期プロジェクトに保存した補正を戻すとき)
  onSetClockOffset?: (sessionId: string, sec: number) => void;
  // 比較の車 (距離の補正・1 周の長さの伸縮を反映した周)。サブの動画の「走行比較」に使う (LATER-11)
  compareCars?: { slot: SelectedCarSlot; lap: Lap }[];
}

/** 周の点 (周の始めからの時刻) で、時刻 t の距離 (km) を補間で求める */
function lapDistanceAtTime(points: TelemetryPoint[], t: number): number | null {
  if (points.length === 0 || t < points[0].time || t > points[points.length - 1].time) return null;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].time <= t) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi];
  const f = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time);
  return a.distance + (b.distance - a.distance) * f;
}

/** 枠の並びの書き出しの、枠ごとの四角 (VideoStage と同じ並べ方) */
function stageRects(count: number, layout: string, W: number, H: number, pip: PipPosition): { x: number; y: number; w: number; h: number }[] {
  if (count <= 1 || layout === 'single') return [{ x: 0, y: 0, w: W, h: H }];
  if (layout === 'pip') {
    const w = W * 0.28, h = H * 0.28, m = W * 0.02;
    const x = pip.endsWith('right') ? W - w - m : m, y = pip.startsWith('bottom') ? H - h - m : m;
    return [{ x: 0, y: 0, w: W, h: H }, { x, y, w, h }];
  }
  if (count === 2) return [{ x: 0, y: H / 4, w: W / 2, h: H / 2 }, { x: W / 2, y: H / 4, w: W / 2, h: H / 2 }];
  return [0, 1, 2, 3].slice(0, count).map(i => ({ x: (i % 2) * W / 2, y: Math.floor(i / 2) * H / 2, w: W / 2, h: H / 2 }));
}

/** 動画のコマを四角に収めて描く (縦横の比は変えない) */
function drawContain(ctx: CanvasRenderingContext2D, el: HTMLVideoElement, r: { x: number; y: number; w: number; h: number }): void {
  const vw = el.videoWidth || 16, vh = el.videoHeight || 9;
  const s = Math.min(r.w / vw, r.h / vh);
  const w = vw * s, h = vh * s;
  ctx.drawImage(el, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
}

/** ログの点 (ログの先頭からの時刻) で、時刻 t の位置 [緯度, 経度] を補間で求める。範囲の外は null */
function positionAtTime(points: TelemetryPoint[], t: number): [number, number] | null {
  if (points.length < 2 || t < points[0].time || t > points[points.length - 1].time) return null;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].time <= t) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi];
  const f = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time);
  return [a.latitude + (b.latitude - a.latitude) * f, a.longitude + (b.longitude - a.longitude) * f];
}

/**
 * 走行比較: 比較の車が、距離 d (基準車の周の中の距離) を走った時刻を、その車のログの時刻で返す。
 * aligned は距離の補正などを反映した周、original は同じ周の補正前のもの (点の並びは同じ)
 */
function compareSessionTimeAtDistance(aligned: Lap, original: Lap, d: number): number | null {
  const ap = aligned.points, op = original.points;
  if (ap.length < 2 || ap.length !== op.length || d < ap[0].distance || d > ap[ap.length - 1].distance) return null;
  let lo = 0, hi = ap.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ap[mid].distance <= d) lo = mid; else hi = mid; }
  const f = ap[hi].distance === ap[lo].distance ? 0 : (d - ap[lo].distance) / (ap[hi].distance - ap[lo].distance);
  return original.startTime + op[lo].time + (op[hi].time - op[lo].time) * f;
}

/**
 * テレメトリオーバーレイを Canvas に描画する共通関数 (リアルタイム表示 & 動画エクスポートで共用)
 */
export function drawTelemetryOverlayOnCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  effectiveTime: number,
  baseSession: Session | undefined,
  baseLap: any,
  showGForce: boolean = true,
  // PinP の小窓がある隅と、小窓がメインの映像に重なる幅 (canvas の座標)。その隅のメーターを小窓の横へずらす (BUG-23)
  avoidCorner: PipPosition | null = null,
  pipOverlapW = 0
) {
  const pipInset = Math.round(pipOverlapW) + 24;
  if (pipOverlapW <= 0) avoidCorner = null;
  const pts = baseSession?.points || baseLap?.points || [];
  if (pts.length === 0) return;

  // 二分探索で effectiveTime に最も近いポイントを高速検索 (O(log N))
  let low = 0;
  let high = pts.length - 1;
  while (low < high - 1) {
    const mid = Math.floor((low + high) / 2);
    if (pts[mid].time < effectiveTime) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const curPt: TelemetryPoint = Math.abs(pts[low].time - effectiveTime) <= Math.abs(pts[high].time - effectiveTime)
    ? pts[low]
    : pts[high];

  // 1. デジタルスピードメーター (左下 - フラットデザイン)
  ctx.save();
  ctx.translate(avoidCorner === 'bottom-left' ? pipInset : 32, h - 96);

  // フラット背景プレート
  ctx.fillStyle = 'rgba(15, 20, 30, 0.85)';
  ctx.beginPath();
  ctx.roundRect(0, 0, 160, 72, 4);
  ctx.fill();
  ctx.strokeStyle = '#2d3852';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 速度数値
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${curPt.speed.toFixed(0)}`, 14, 44);

  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('km/h', 105, 42);

  // 速度カラーバー (フラット)
  const maxScaleSpd = 200;
  const spdRatio = Math.min(1, curPt.speed / maxScaleSpd);
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(14, 54, 132, 6);
  ctx.fillStyle = spdRatio > 0.8 ? '#ef4444' : spdRatio > 0.5 ? '#f59e0b' : '#3b82f6';
  ctx.fillRect(14, 54, 132 * spdRatio, 6);

  ctx.restore();

  // 2. Gフォースメーター (右下 - フラットデザイン)
  if (showGForce) {
    ctx.save();
    ctx.translate(avoidCorner === 'bottom-right' ? w - pipInset - 96 : w - 128, h - 96);

    // フラット背景プレート
    ctx.fillStyle = 'rgba(15, 20, 30, 0.85)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 96, 72, 4);
    ctx.fill();
    ctx.strokeStyle = '#2d3852';
    ctx.lineWidth = 1;
    ctx.stroke();

    // フリクションサークル
    const cX = 48;
    const cY = 34;
    const r = 22;

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cX, cY, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cX, cY, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // 十字線
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(cX - r, cY); ctx.lineTo(cX + r, cY);
    ctx.moveTo(cX, cY - r); ctx.lineTo(cX, cY + r);
    ctx.stroke();

    // 現在Gプロット (フラットソリッドレッド)
    const scaleG = r / 1.5;
    const gX = cX - (curPt.corneringG || 0) * scaleG;
    const gY = cY + (curPt.accelG || 0) * scaleG;

    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(gX, gY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = 'bold 8px monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.fillText(`${(curPt.combinedG || 0).toFixed(2)}G`, cX, 66);

    ctx.restore();
  }

  // 3. ラップタイム情報 (右上 - フラットデザイン)
  ctx.save();
  ctx.translate(avoidCorner === 'top-right' ? w - pipInset - 150 : w - 170, 20);

  ctx.fillStyle = 'rgba(15, 20, 30, 0.85)';
  ctx.beginPath();
  ctx.roundRect(0, 0, 150, 52, 4);
  ctx.fill();
  ctx.strokeStyle = '#2d3852';
  ctx.lineWidth = 1;
  ctx.stroke();

  const currentLap = baseSession?.laps.find(l => effectiveTime >= l.startTime && effectiveTime <= l.endTime);
  const lapLabel = currentLap ? `Lap ${currentLap.lapNumber}` : (baseLap ? `Lap ${baseLap.lapNumber}` : 'Out / In Lap');
  const lapDisplayTime = currentLap ? (effectiveTime - currentLap.startTime) : (baseLap ? (effectiveTime - baseLap.startTime) : effectiveTime);

  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(lapLabel, 12, 18);

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 18px monospace';
  ctx.fillText(formatMinSec(lapDisplayTime, 2), 12, 42);

  ctx.restore();
}

export const VideoSyncWindow: React.FC<VideoSyncWindowProps> = ({
  sessions,
  selectedCars,
  currentTimeSec,
  currentDistanceKm,
  isPlaying,
  onSeekTime,
  onTogglePlay,
  circuitName,
  targetSessionId,
  targetLap,
  isGraphEmbedded = false,
  isVisible = true,
  playbackSpeed,
  onChangePlaybackSpeed,
  onChooseLog,
  onPickCompareLap,
  onLoadFiles,
  viewKey,
  onSetClockOffset,
  compareCars
}) => {
  const t = useT();
  // 動画の一覧と出すカメラは、どのウインドウでも同じにする (videoViewStore に 1 つだけ持つ)。
  // モード・並べ方・大きく出す枠・メーターは、ウインドウごとに持つ
  const storedTracks = useVideoTracks();
  const view = useVideoView();
  const { cameraIds } = view;
  const isAnyExporting = view.isExporting;
  const [win, setWin] = useWindowView(viewKey);
  // スマートフォン向けの配置 (枠は 1 つずつ・走行比較は縦に 2 つ。VideoStage)
  const isCompactLayout = useCompactLayout();
  const isLandscape = useLandscape();
  const { pipPosition, showOverlay, showGForce } = win;
  const setShowOverlay = (v: boolean) => setWin({ showOverlay: v });
  // 全部の <video> を、1 か所で App の時刻に合わせる
  const playback = useRef(new PlaybackController()).current;
  const mainVideo = () => playback.element('tile-0');

  // シークバースコープ ('lap': 速度ウィンドウ選択中ラップ時間, 'session': セッション全体時間)
  // 動画同期タブはセッション全体の時刻で再生するので、はじめはセッション全体にする (周の表示は周の外に出ると端に止まる)
  const [seekbarScope, setSeekbarScope] = useState<'lap' | 'session'>(isGraphEmbedded ? 'lap' : 'session');

  const [isDragging, setIsDragging] = useState<boolean>(false);
  // 動画の移動 (seek) が終わった回数。移動中に来た時刻に合わせ直すため、変わったら動画をもう一度合わせる
  const [, setSeekTick] = useState(0);
  const handleSeeked = () => setSeekTick(n => n + 1);

  // 手動キーフレーム同期（ピン留め）。コースごとに保存し、どのウインドウでも同じものを出す
  const pinKey = circuitName || 'default';
  const pins = useSyncPins(pinKey);
  const setPins = (updated: SyncPin[]) => videoViewStore.setPins(pinKey, updated);
  const [showPinModal, setShowPinModal] = useState<boolean>(false);
  const [newPinName, setNewPinName] = useState<string>('');

  // 動画テレメトリ焼き込みエクスポートステート
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [exportRange, setExportRange] = useState<'lap' | 'all'>('lap');
  const [exportResolution, setExportResolution] = useState<'1080p' | '720p'>('1080p');
  const [exportFps, setExportFps] = useState<number>(30);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  // 枠の並びの書き出しで、低画質のファイル (.LRV) を使う (下書き)
  const [draftExport, setDraftExport] = useState(false);
  // 書き出しの設定: 枠の並びで書き出すか、下書きにするか
  const [exportStage, setExportStage] = useState(true);
  const [exportDraft, setExportDraft] = useState(false);
  // 枠の並びを録っている間 (ふだんの再生で動画を動かす)
  const stageRecordingRef = useRef(false);
  const stageStartTimerRef = useRef<number | null>(null);
  const togglePlayRef = useRef(onTogglePlay);
  const [exportProgress, setExportProgress] = useState<{ currentSec: number; totalSec: number; percent: number } | null>(null);
  const exportControllerRef = useRef<VideoExportController | null>(null);
  // 書き出し中にウインドウが閉じられたら (たたむ・表示の切り替え)、書き出しをやめる (動画の要素がなくなるため)
  // 枠の並びの書き出しで、録り始めるのを待っている間に閉じられたときも、録り始めない
  useEffect(() => () => {
    exportControllerRef.current?.cancel();
    stageRecordingRef.current = false;
    if (stageStartTimerRef.current !== null) clearTimeout(stageStartTimerRef.current);
  }, []);

  const pipRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const jsonInputRef = useRef<HTMLInputElement | null>(null);

  // 速度ウィンドウの選択状態 (Car 1) を最優先で参照
  const baseSelected = selectedCars.find(c => c.slot === 0);
  const speedSessionId = targetSessionId || baseSelected?.sessionId;
  const baseSession = sessions.find(s => s.id === speedSessionId) || sessions[0];
  const baseLap = targetLap || baseSession?.laps.find(l => l.lapNumber === baseSelected?.lapNumber) || baseSession?.laps[0];
  // グラフ画面の動画では、App の時刻は選んだ周の時刻 (0〜周のタイム)。周の外へは動かさない
  // (周の外の時刻にすると、次のコマで周の始めに戻ってしまう)
  const seekTo = (t: number) => onSeekTime(isGraphEmbedded && baseLap ? Math.min(Math.max(0, t), baseLap.lapTime) : t);

  // 動画は、基準のログ (Car 1) の時刻に置いて扱う (mediaClock.ts)。どのログに時刻を付けた動画も、撮影の本当の時刻で換算するので、
  // 別のログに付いた動画・撮影時刻の違うサブの動画も、基準のログの時刻のまま正しく出る (BUG-21)。
  // 画面・書き出し・タイムライン・チャプターの移動は、すべてこの置いた位置 (syncOffsetSec) を使う
  const tracks: PlacedTrack[] = useMemo(
    () => placeTracks(storedTracks, baseSession, sessions),
    [storedTracks, baseSession, sessions]
  );
  // カメラ (チャプターに分かれた動画はまとめて 1 つ)。出すのは cameraIds の順。1 つ目がメイン
  const media = useMemo(() => buildMedia(tracks), [tracks]);
  const cameras = cameraIds.map(id => media.find(m => m.id === id)).filter((m): m is PlayableMedia => !!m);
  const mainMedia = cameras[0];
  const renderSessionTime = isGraphEmbedded && baseLap ? baseLap.startTime + currentTimeSec : currentTimeSec;
  // 走行比較は周がないと何も映せないので、周がないとき (GPS のない動画だけを読み込んだときなど) はマルチカメラで出す。
  // 選んだ表示 (win.mode) は変えないので、周のあるログを読み込めば走行比較に戻る
  const isCompare = win.mode === 'compare' && !!baseLap;
  // Car 2 がいないときに走行比較を押したら、Car 1 と同じログの、Car 1 の周以外でいちばん速い周を Car 2 に入れる
  // (動画 1 本・ログ 1 つでも、同じ動画の別の周どうしを比べられるように)
  const autoCompareLap = baseSession && baseLap
    ? baseSession.laps
        .filter(l => !l.isWholeSession && !l.isPartialLap && l.lapNumber !== baseLap.lapNumber)
        .reduce<Lap | undefined>((a, l) => (!a || l.lapTime < a.lapTime ? l : a), undefined)
    : undefined;
  const hasCompareCar = (compareCars ?? []).length >= 2;
  const canCompare = !!baseLap && (hasCompareCar || (!!autoCompareLap && !!onPickCompareLap));

  /**
   * 枠 1 つ分。マルチカメラ: 出すカメラごと (時刻は Car 1 の時刻のまま、メーターはメインだけ)。
   * 走行比較: Car 1〜4 ごと (docs/video_sets_design.md の 6)。Car 1 の時刻 → Car 1 の周の中の距離 (グラフと同じ合わせ方) →
   * Car k がその距離に来た時刻 → その動画の中の位置。動画は、その車のログの時刻で周を映しているもの (選べる)
   */
  interface Tile {
    media?: PlayableMedia;
    position: MediaPosition | null;
    /** 再生の速さの倍率 (走行比較: 距離の対応の傾き) */
    rate?: number;
    /** メーターに出す車のログ・周・時刻 */
    gauge?: { session: Session | undefined; lap: Lap | undefined; time: number };
    slot?: number;
    color?: string;
    /** Car 1 とのタイム差 (秒、+ なら遅い) */
    delta?: number | null;
    /** 選んだ動画か (false: 自動) */
    chosen?: boolean;
  }
  const noFootage = (m: PlayableMedia): MediaPosition => ({ track: m.tracks[0], localTime: -1, durationSec: m.tracks[0].durationSec, outOfRange: true });
  const compareTiles = (sessionTime: number): Tile[] => {
    const cars = [...(compareCars ?? [])].sort((a, b) => a.slot.slot - b.slot.slot);
    if (!baseLap) return [];
    const baseElapsed = sessionTime - baseLap.startTime;
    // 周の外の時刻は周の始め・終わりにそろえる (周の終わりでは、比べる車も周の終わりのコマで止める)
    const pts = baseLap.points;
    const clampLap = (t: number) => pts.length ? Math.max(pts[0].time, Math.min(pts[pts.length - 1].time, t)) : t;
    const d = lapDistanceAtTime(pts, clampLap(baseElapsed));
    const byTime = win.compareAlign === 'time';
    return cars.map(car => {
      const session = sessions.find(s => s.id === car.slot.sessionId);
      const lap = session?.laps.find(l => l.lapNumber === car.slot.lapNumber);
      const chosenId = view.compareCameras[car.slot.slot];
      const m = (chosenId ? media.find(x => x.id === chosenId) : undefined) ?? (session && lap ? mediaForLap(media, session, lap, sessions) : undefined);
      const isBase = car.slot.slot === 0;
      // その車の、その距離での時刻 (ログの時刻)。Car 1 は今の時刻そのもの
      const timeAt = (t: number): number | null => {
        if (isBase) return t;
        if (!lap) return null;
        const dd = lapDistanceAtTime(pts, clampLap(t - baseLap.startTime));
        return dd === null ? null : compareSessionTimeAtDistance(car.lap, lap, dd);
      };
      // Car 1 と同じ地点にいたときの、その車の時刻 (タイム差はいつもこれで出す)
      const atDistance = isBase ? sessionTime : d === null || !lap ? null : compareSessionTimeAtDistance(car.lap, lap, d);
      // 映す時刻: 地点で合わせるときは同じ地点の時刻、時間で合わせるときは周の始めから同じ経過時間 (その車の周の長さまで)
      const ct = isBase || !byTime ? atDistance : !lap ? null : lap.startTime + Math.max(0, Math.min(lap.endTime - lap.startTime, baseElapsed));
      const start = m && session ? mediaStartIn(m, session, sessions) : null;
      const position = !m ? null : ct === null || start === null ? noFootage(m) : positionAtMediaTime(m, ct - start);
      // 速さの倍率: 約 0.5 秒先までの、距離の対応の傾き (遅い車の動画ほど速く回す)
      // 周の終わり 0.5 秒は先の時刻が周の終わりにそろって傾きが 0 になるので、後ろの 0.5 秒で求める
      let rate: number | undefined;
      if (!isBase && ct !== null && !byTime) {
        const nearEnd = pts.length > 0 && baseElapsed + 0.5 > pts[pts.length - 1].time;
        const ahead = nearEnd ? null : timeAt(sessionTime + 0.5), behind = timeAt(sessionTime - 0.5);
        rate = ahead !== null && ahead > ct ? (ahead - ct) / 0.5 : behind !== null && ct > behind ? (ct - behind) / 0.5 : 1;
      }
      return {
        media: m, position, rate, slot: car.slot.slot, color: car.slot.colorHex, chosen: !!chosenId,
        gauge: { session, lap, time: ct ?? sessionTime },
        delta: isBase || atDistance === null || !lap ? null : (atDistance - lap.startTime) - baseElapsed
      };
    });
  };
  const tiles: Tile[] = isCompare
    ? compareTiles(renderSessionTime)
    : cameras.map((m, i) => ({ media: m, position: positionInMedia(m, renderSessionTime), gauge: i === 0 ? { session: baseSession, lap: baseLap, time: renderSessionTime } : undefined }));
  const tileCount = tiles.length;
  const positions = tiles.map(x => x.position);
  // 同期の調整・書き出しの対象は、メインのカメラの今のチャプター
  const activeTrack: PlacedTrack | undefined = positions[0]?.track ?? mainMedia?.tracks[0];
  // 走行比較で動画のない枠も出す (メーターだけ)。マルチカメラでカメラがないときは、動画を読み込む案内を出す
  const hasStage = isCompare ? tileCount > 0 : !!(activeTrack && activeTrack.objectUrl);
  // グラフ解析に埋め込んだときは、タイムゾーン・再同期の段とタイムラインを、ボタンで開くまで隠す。
  // 狭い枠ではこれらの段が場所を使い切り、動画の映る部分の高さが 0 になっていた (BUG-19)。同期の調整は動画同期の画面でもできる
  const [showSyncTools, setShowSyncTools] = useState(!isGraphEmbedded && !isCompactLayout);
  // 走行の確認 (RunsInspector) を開いているか
  const [showRuns, setShowRuns] = useState(false);
  // GoPro の動画の GPS も走行ログとして加えるか (次に読み込む動画から効く) LATER-12
  const [addVideoGpsLog, setAddVideoGpsLogState] = useState(getAddVideoGpsLog);

  // メインのカメラのチャプター (チャプターに分かれた動画のとき)
  const currentGroup = useMemo(
    () => (mainMedia && mainMedia.tracks.length > 1 ? groupVideoTracksByChapter(mainMedia.tracks).groups[0] ?? null : null),
    [mainMedia]
  );

  // タイムスタンプフォーマット関数
  const formatTzDate = (d: Date | null | undefined, tz: string): string => {
    if (!d) return '--:--:--';
    const offsetMs = getTimezoneOffsetMs(tz);
    const adjusted = new Date(d.getTime() + offsetMs);
    const m = String(adjusted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(adjusted.getUTCDate()).padStart(2, '0');
    const hh = String(adjusted.getUTCHours()).padStart(2, '0');
    const mm = String(adjusted.getUTCMinutes()).padStart(2, '0');
    const ss = String(adjusted.getUTCSeconds()).padStart(2, '0');
    return `${m}/${day} ${hh}:${mm}:${ss}`;
  };

  // 動画再生時間フォーマット (MM:SS)
  const formatDuration = (sec: number): string => {
    const sClamped = Math.max(0, sec);
    const m = Math.floor(sClamped / 60);
    const s = Math.floor(sClamped % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const gpsStartTime = baseSession?.points[0]?.timestamp ? new Date(baseSession.points[0].timestamp) : null;
  const isLargeOffset = activeTrack ? Math.abs(activeTrack.syncOffsetSec) > 3600 : false;


  // 速度ウィンドウのセッション (Car 1) に対応する動画トラックを自動選択
  // 選ぶのは基準のセッションが変わったとき (と、そのセッションの動画を初めて読み込んだとき) だけ。手で選び直した動画はそのままにする
  useEffect(() => {
    if (!isVisible || isAnyExporting || !baseSession || tracks.length === 0) return;
    if (videoViewStore.autoSelectedSessionId === baseSession.id) return;
    const matchingTrack = tracks.find(t => t.matchedSessionId === baseSession.id);
    if (!matchingTrack) {
      // 動画のないセッションに切り替えたら、前のセッションに戻ったときに選び直せるよう、覚えている印を消す
      videoViewStore.autoSelectedSessionId = null;
      return;
    }
    videoViewStore.autoSelectedSessionId = baseSession.id;
    if (!mainMedia?.tracks.some(t => t.id === matchingTrack.id)) videoViewStore.selectMain(matchingTrack.id);
  }, [baseSession?.id, tracks, isVisible, isAnyExporting]);

  // 出している枠の数 (1 画面ならメインだけ、PinP なら 2 つまで)
  // スマートフォンでは、どの枠を出していても合わせられるよう、全部の枠を数える (出していない枠は <video> がないので何もしない)
  const shownCount = isCompactLayout ? tileCount : win.layout === 'single' ? Math.min(1, tileCount) : win.layout === 'pip' ? Math.min(2, tileCount) : tileCount;

  // 走行比較で、Car 1 が周の終わりに来たら周の始めに戻す (動画同期のタブはセッション全体の時刻で進むため。グラフ画面は App が戻す)
  useEffect(() => {
    if (!isCompare || isGraphEmbedded || !baseLap || !isVisible || isAnyExporting) return;
    if (isPlaying && renderSessionTime > baseLap.endTime) seekTo(baseLap.startTime);
    else if (renderSessionTime < baseLap.startTime - 0.5 || renderSessionTime > baseLap.endTime + 0.5) seekTo(baseLap.startTime);
  }, [isCompare, renderSessionTime, baseLap?.startTime, baseLap?.endTime, isPlaying, isVisible]);

  // 動画を App の時刻に合わせる (PlaybackController)。見えていないウインドウ・書き出し中は合わせない (書き出しは動画を自分で動かす)
  useEffect(() => {
    // 枠の並びの書き出しは、ふだんの再生のまま録るので、合わせ続ける
    const recordingStage = stageRecordingRef.current;
    if (isExporting && !recordingStage) return;
    if (!isVisible || (isAnyExporting && !recordingStage)) { playback.pauseAll(); return; }
    const targets = new Map<string, PlaybackTarget>();
    tiles.slice(0, shownCount).forEach((x, i) => { if (x.position) targets.set(`tile-${i}`, { ...x.position, rate: x.rate }); });
    playback.sync(targets, isPlaying, playbackSpeed);
  });

  // 手で合わせる (ずれの入力・微調整・ワンクリック同期・同期ピン)。基準のログの時刻でのずれで入れ、その時刻を基準のログに付ける
  const setOffset = (trackId: string, offsetSec: number) => {
    if (baseSession) videoSyncManager.setOffsetIn(trackId, baseSession, offsetSec);
  };

  // ワンクリック同期: 現在の動画フレームを GPS の現在選択タイムに合わせる
  const handleSyncCurrentFrame = () => {
    const el = mainVideo();
    if (!el || !activeTrack) return;
    const currentVideoTime = el.currentTime;
    const effectiveSessionTime = isGraphEmbedded && baseLap
      ? (baseLap.startTime + currentTimeSec)
      : currentTimeSec;
    setOffset(activeTrack.id, effectiveSessionTime - currentVideoTime);
  };

  // 微調整 (+/- 0.05秒: 1フレーム単位)
  const handleNudgeOffset = (deltaSec: number, targetId: string = activeTrack?.id || '') => {
    const track = tracks.find(t => t.id === targetId);
    if (!track) return;
    setOffset(track.id, track.syncOffsetSec + deltaSec);
  };

  // 手動キーフレーム同期 (ピン作成)
  const handleAddPin = () => {
    const el = mainVideo();
    if (!el || !activeTrack) return;
    const effectiveSessionTime = isGraphEmbedded && baseLap
      ? (baseLap.startTime + currentTimeSec)
      : currentTimeSec;
    const currentVideoTime = el.currentTime;
    
    const pin = createSyncPin(
      newPinName || `${tr('ピン', 'Pin')} ${pins.length + 1}`,
      effectiveSessionTime,
      currentVideoTime,
      activeTrack.id
    );
    pin.sessionId = baseSession?.id;
    // ピンの位置でずれを合わせる
    setOffset(pin.trackId, pin.calculatedOffsetSec);

    const updated = [...pins, pin];
    setPins(updated);
    setNewPinName('');
    setShowPinModal(false);
  };

  // ピン位置へジャンプ (シーク)
  const handleJumpToPin = (pin: SyncPin) => {
    if (isGraphEmbedded && baseLap) {
      seekTo(Math.max(0, pin.sessionTimeSec - baseLap.startTime));
    } else {
      seekTo(pin.sessionTimeSec);
    }
  };

  // ピン削除
  const handleDeletePin = (pinId: string) => {
    const updated = pins.filter(p => p.id !== pinId);
    setPins(updated);
  };

  // メインカメラとサブカメラの入れ替え (Swap)

  // 枠の並びの書き出しが、コマごとに読む今の状態 (描くたびに入れ直す)
  const stageRef = useRef<{ time: number; tiles: Tile[]; count: number; isPlaying: boolean }>({ time: 0, tiles: [], count: 0, isPlaying: false });

  /**
   * 枠の並びで書き出す (docs/video_sets_design.md の 9)。開始の位置へ移ってから、ふだんの再生で動画を動かし、
   * 見えている枠とメーターを 1 つの絵に描いて実時間で録る。下書きは .LRV の低画質のファイルで録る (軽い)
   */
  const handleStartStageExport = () => {
    if (isAnyExporting || shownCount === 0) return;
    // 走行比較は周の中で比べるので、いつも周の範囲で書き出す (動画全体にすると、周の終わりで比べる車が止まったままになる)
    const range: [number, number] | null = (exportRange === 'lap' || isCompare) && baseLap
      ? [baseLap.startTime, baseLap.endTime]
      : mainMedia ? [Math.max(0, mainMedia.startSec), mainMedia.endSec] : null;
    if (!range) return;
    const [start, end] = range;
    const W = exportResolution === '1080p' ? 1920 : 1280, H = exportResolution === '1080p' ? 1080 : 720;
    const layout = isCompactLayout ? (isCompare && !isLandscape ? 'grid' : 'single') : win.layout;
    const count = layout === 'single' ? 1 : layout === 'pip' ? Math.min(2, shownCount) : Math.min(4, shownCount);
    const rects = stageRects(count, layout, W, H, pipPosition);
    const firstTile = isCompactLayout && layout === 'single' ? bigTile : 0;
    if (isPlaying) onTogglePlay();
    setShowExportModal(false);
    setDraftExport(exportDraft);
    setIsExporting(true);
    videoViewStore.set({ isExporting: true });
    stageRecordingRef.current = true;
    seekTo(isGraphEmbedded && baseLap ? start - baseLap.startTime : start);
    const stopPlayback = () => { if (stageRef.current.isPlaying) togglePlayRef.current(); };
    const finish = () => {
      stageRecordingRef.current = false;
      exportControllerRef.current = null;
      stopPlayback();
      setDraftExport(false);
      setIsExporting(false);
      setExportProgress(null);
      videoViewStore.set({ isExporting: false });
    };
    // 枠の動画が開始の位置へ移るのを待ってから、再生して録り始める
    stageStartTimerRef.current = window.setTimeout(() => {
      stageStartTimerRef.current = null;
      if (!stageRecordingRef.current) return;
      if (!stageRef.current.isPlaying) togglePlayRef.current();
      // 周の終わりで周の始めに戻ったら (グラフ画面の周の再生)、そこで終える
      let lastTime = start;
      const controller = recordCanvas({
        width: W,
        height: H,
        fps: exportFps,
        outputFileName: `${circuitName || 'race'}_${isCompare ? 'compare' : 'cameras'}${exportDraft ? '_draft' : ''}.mp4`,
        onProgress: p => setExportProgress(p),
        // 音はメインの枠の動画から (走行比較では Car 1)
        audioFrom: playback.element(`tile-${firstTile}`),
        draw: ctx => {
          const st = stageRef.current;
          rects.forEach((r, k) => {
            const i = k === 0 ? firstTile : k;
            const tile = st.tiles[i];
            const el = playback.element(`tile-${i}`);
            if (tile && el && el.readyState >= 2 && !tile.position?.outOfRange) drawContain(ctx, el, r);
            const ov = tile ? overlayFor(tile, i) : null;
            if (ov) {
              ctx.save();
              ctx.translate(r.x, r.y);
              ctx.scale(r.w / 1280, r.h / 720);
              ov.draw(ctx, 1280, 720, 0);
              ctx.restore();
            }
            if (isCompare && tile) {
              const label = `Car ${(tile.slot ?? 0) + 1}${tile.delta !== undefined && tile.delta !== null ? `  ${tile.delta >= 0 ? '+' : '−'}${Math.abs(tile.delta).toFixed(2)}` : ''}`;
              ctx.font = `bold ${Math.round(r.h / 22)}px sans-serif`;
              ctx.fillStyle = 'rgba(0,0,0,0.6)';
              ctx.fillRect(r.x + 8, r.y + 8, ctx.measureText(label).width + 16, r.h / 16);
              ctx.fillStyle = tile.color ?? '#fff';
              ctx.fillText(label, r.x + 16, r.y + 8 + r.h / 22);
            }
          });
          const wrapped = st.time < lastTime - 1;
          lastTime = st.time;
          return { currentSec: st.time - start, totalSec: end - start, done: wrapped || st.time >= end - 0.02 || (!st.isPlaying && st.time > start + 0.5) };
        }
      });
      exportControllerRef.current = controller;
      controller.promise.then(finish).catch(err => { console.warn('Export finished or cancelled:', err); finish(); });
    }, 1200);
  };

  // テレメトリ動画エクスポート開始
  const handleStartExport = () => {
    if (exportStage && tileCount > 1) { handleStartStageExport(); return; }
    const el = mainVideo();
    if (!el || !activeTrack || isAnyExporting) return;
    // 書き出しは動画を自分で再生する。ふだんの再生 (App の時刻) は止めておく
    if (isPlaying) onTogglePlay();
    playback.pauseAll();

    let startSec = 0;
    let endSec = activeTrack.durationSec;

    if (exportRange === 'lap' && baseLap) {
      startSec = baseLap.startTime;
      endSec = baseLap.endTime;
    } else {
      startSec = activeTrack.syncOffsetSec;
      endSec = activeTrack.syncOffsetSec + (activeTrack.durationSec || 60);
    }

    const exportW = exportResolution === '1080p' ? 1920 : 1280;
    const exportH = exportResolution === '1080p' ? 1080 : 720;
    const filename = `${circuitName || 'race'}_${exportRange === 'lap' && baseLap ? `Lap${baseLap.lapNumber}` : 'session'}_telemetry.mp4`;

    setIsExporting(true);
    videoViewStore.set({ isExporting: true });
    setShowExportModal(false);

    const controller = exportBurnedInVideo({
      videoElement: el,
      startTimeSec: startSec,
      endTimeSec: endSec,
      syncOffsetSec: activeTrack.syncOffsetSec,
      drawOverlay: (ctx, w, h, curTime) => {
        drawTelemetryOverlayOnCanvas(ctx, w, h, curTime, baseSession, baseLap, showGForce);
      },
      outputFileName: filename,
      width: exportW,
      height: exportH,
      fps: exportFps,
      onProgress: (p) => {
        setExportProgress(p);
      }
    });

    exportControllerRef.current = controller;

    const finish = () => {
      exportControllerRef.current = null;
      setIsExporting(false);
      setExportProgress(null);
      videoViewStore.set({ isExporting: false });
    };
    controller.promise
      .then(finish)
      .catch((err) => {
        console.warn('Export finished or cancelled:', err);
        finish();
      });
  };

  // 動画ファイル一括処理。ヘッダーの「読込」と同じ道を通す (GoPro の動画は、GPS を走行ログにしてから登録する。
  // 動画同期だけに登録すると、ログがないときに周が出ない)。選んでいる動画は videoViewStore が選び直す
  const processFiles = async (fileList: FileList | File[]) => {
    if (onLoadFiles) await onLoadFiles(Array.from(fileList));
    else await videoSyncManager.addVideoFiles(fileList, sessions);
  };

  const handleAddVideos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // 読み込みの間に選び直せるよう、先に一覧を写してから入力を空にする
    const list = Array.from(files);
    e.target.value = '';
    await processFiles(list);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      await processFiles(files);
    }
  };

  // プロジェクト保存 / 読込
  const handleExportProject = () => {
    const jsonStr = videoSyncManager.exportProjectJson(sessions, circuitName, pins);
    // 保存が終わる前に URL を消すと、Safari では空のファイルになるので、少し後に消す (downloadBlob)
    downloadBlob(new Blob([jsonStr], { type: 'application/json' }), `${circuitName || 'telemetry'}_sync_project.dssync.json`);
  };

  const handleImportProject = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const text = ev.target?.result as string;
        const { data, clockOffsets } = videoSyncManager.importProjectJson(text, sessions);
        for (const [id, sec] of clockOffsets) onSetClockOffset?.(id, sec);
        // 同期ピンも戻す。動画はファイル名で今の動画に読み替える (同じ時刻・名前のピンは足さない)
        if (data.pins && data.pins.length > 0) {
          // ピンは、書き出したときのコースに戻す (ログを読み込む前に戻しても、そのコースを開けば出る)
          const importKey = data.circuitName || 'default';
          const current = videoViewStore.getPins(importKey);
          const all = videoSyncManager.getTracks();
          const restored = data.pins
            .filter(p => !current.some(c => c.name === p.name && Math.abs(c.sessionTimeSec - p.sessionTimeSec) < 0.001))
            .map(p => ({
              ...createSyncPin(p.name, p.sessionTimeSec, p.videoTimeSec, all.find(t => t.fileName === p.trackFileName)?.id ?? ''),
              ...(p.sessionId ? { sessionId: p.sessionId } : {}),
              ...(p.createdAt ? { createdAt: p.createdAt } : {})
            }));
          if (restored.length > 0) videoViewStore.setPins(importKey, [...current, ...restored]);
        }
      } catch (err: any) {
        alert(tr('プロジェクト復元エラー: ', 'Could not restore the project: ') + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // メインの枠に重ねるメーター。PinP の小窓がある隅のメーターは、小窓の横へずらす (BUG-23)
  // 元の画質で出すのは大きく出している枠 (なければメイン) だけ。ほかの枠・スマートフォン・下書きの書き出しは、
  // GoPro の低画質のファイル (.LRV) があればそれを出す (4K の動画をいくつも読むと、引っかかるため)
  const bigTile = win.focus ?? 0;
  const proxyFor = (i: number) => isCompactLayout || draftExport || (tileCount > 1 && i !== bigTile);
  // 4K の元の動画を 3 つ以上同時に出しているとき (.LRV がない)、知らせる
  const heavyCount = Array.from({ length: shownCount }, (_, i) => i).filter(i => {
    const el = playback.element(`tile-${i}`);
    return el && el.videoWidth >= 3800 && !(proxyFor(i) && positions[i]?.track.proxyUrl);
  }).length;

  // メインの動画自身の GPS のログ (GoPro の GPS をログとして加えたとき) と、基準車のログの位置が、2 秒続けて 10 m より離れていたら知らせる。
  // 動画を別の車のログに付けている (取り違え) か、時刻が大きくずれている
  const gpsMismatchM = (() => {
    if (isCompare || !mainMedia || !baseSession) return null;
    const gpsLog = sessions.find(s => s.fileName === mainMedia.tracks[0].fileName && s.id !== baseSession.id);
    const b0 = sessionStartUtcMs(baseSession), g0 = sessionStartUtcMs(gpsLog);
    if (!gpsLog || b0 === null || g0 === null) return null;
    let min = Infinity;
    for (const dt of [0, 1, 2]) {
      const t = renderSessionTime - dt;
      const a = positionAtTime(baseSession.points, t), g = positionAtTime(gpsLog.points, t + (b0 - g0) / 1000);
      if (!a || !g) return null;
      const dx = (a[1] - g[1]) * 111320 * Math.cos(a[0] * Math.PI / 180), dy = (a[0] - g[0]) * 111320;
      min = Math.min(min, Math.hypot(dx, dy));
    }
    return min > 10 ? Math.round(min) : null;
  })();

  stageRef.current = { time: renderSessionTime, tiles, count: shownCount, isPlaying };
  // 書き出しの終わりで再生を止めるときは、その時の再生の状態で切り替える (書き出しを始めたときの関数は古い状態を持つため)
  togglePlayRef.current = onTogglePlay;

  // 枠に重ねるメーター (その枠の車のログ・時刻)。マルチカメラではメインの枠だけ
  const overlayFor = (x: Tile, i: number): TileOverlay | null => {
    const g = x.gauge;
    if (!g || !showOverlay || !isVisible) return null;
    return {
      tick: g.time,
      draw: (ctx, w, h, avoidW) => drawTelemetryOverlayOnCanvas(ctx, w, h, g.time, g.session, g.lap, showGForce, i === 0 && win.layout === 'pip' && tileCount > 1 ? pipPosition : null, avoidW)
    };
  };

  return (
    // 枠が狭くて全部の段が入らないときは、動画を潰さずにウインドウの中をスクロールさせる
    <div className={`relative flex flex-col h-full bg-surface-0 text-slate-200 select-none font-sans ${isGraphEmbedded ? 'overflow-y-auto overflow-x-hidden' : 'overflow-hidden'}`}>
      {showRuns && (
        <RunsInspector sessions={sessions} media={media} onChooseLog={onChooseLog} onClose={() => setShowRuns(false)} />
      )}
      {/* 1. 上部コントロールバー (フラットデザイン) */}
      {/* グラフ解析に埋め込んだ狭い枠では、右側のボタンが切れないよう横にスクロールできるようにする */}
      {/* ボタンの文字は折り返さない。入りきらないときは横にスクロールし、広い画面でだけ文字を出すボタンもある */}
      <div className="h-11 bg-surface-1 border-b border-line-1 px-3 flex items-center justify-between gap-2 shrink-0 overflow-x-auto overflow-y-hidden [&_button]:whitespace-nowrap [&_button]:shrink-0">
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="text-xs font-bold text-slate-100 flex items-center gap-1.5 shrink-0 whitespace-nowrap" title={t('車載動画同期', 'Onboard video sync')}>
            <Video size={15} className="text-red-500" />
            <span className="hidden 2xl:inline">{t('車載動画同期', 'Onboard video sync')}</span>
          </span>

          {/* グラフ解析に埋め込んだときだけ: タイムゾーン・再同期の段とタイムラインを開く / 閉じる。
              狭い枠で右側が切れても押せるよう、いちばん左に置く */}
          {(isGraphEmbedded || isCompactLayout) && activeTrack && (
            <button
              onClick={() => setShowSyncTools(v => !v)}
              aria-pressed={showSyncTools}
              title={t('動画のタイムゾーン・再同期の段とタイムラインを出す / 隠す', 'Show / hide the time zone and resync row and the timeline')}
              className={`flex items-center gap-1 shrink-0 whitespace-nowrap px-2 py-1 rounded text-xs border transition-colors cursor-pointer ${
                showSyncTools ? 'bg-slate-700 border-slate-500 text-slate-100' : 'bg-surface-3 hover:bg-surface-5 border-line-3 text-slate-300'
              }`}
            >
              {t('同期の調整', 'Sync settings')}
            </button>
          )}

          {/* 速度ウィンドウ連携バッジ (フラット) */}
          {baseSession && (
            <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/80 border border-emerald-800 px-2 py-0.5 rounded flex items-center gap-1 shrink-0" title={t('速度ウィンドウ同期中', 'Synced with the speed window')}>
              <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
              <span className="max-w-[120px] truncate font-bold">{baseSession.sessionName}</span>
              {baseLap && <span className="text-emerald-300 font-bold">L{baseLap.lapNumber}</span>}
            </span>
          )}

          {/* モード: マルチカメラ (同じ時刻のカメラを並べる) / 走行比較 (比較の車が同じ地点を走った時刻) */}
          {media.length > 0 && (
            <div className="flex items-center rounded border border-line-3 bg-surface-3 overflow-hidden shrink-0">
              <button
                onClick={() => setWin({ mode: 'cameras' })}
                className={`px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer ${!isCompare ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                title={t('1 台の車の走行を、いくつかのカメラで同じ時刻に見ます', 'Watch one car\'s run from several cameras at the same time')}
              >
                {t('マルチカメラ', 'Cameras')}
              </button>
              <button
                onClick={() => {
                  if (!hasCompareCar && autoCompareLap && baseSession) onPickCompareLap?.(baseSession.id, autoCompareLap.lapNumber);
                  setWin({ mode: 'compare', focus: null });
                }}
                disabled={!canCompare}
                className={`px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-40 ${isCompare ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                title={t('走行比較: Car 1〜4 の周の動画を、Car 1 と同じ地点を走ったときの映像で並べます。Car 2 がいなければ、同じログの別の周 (Car 1 の周以外でいちばん速い周) を Car 2 にします', 'Run comparison: shows the videos of the Car 1-4 laps at the moment each car was at the same point as Car 1. Without a Car 2, the fastest other lap of the same log becomes Car 2')}
              >
                {t('走行比較', 'Compare')}
              </button>
            </div>
          )}

          {/* 走行比較の合わせ方: 同じ地点 (比べる車の動画は速さを変えて回す) / 同じ経過時間 (1 倍で回す) */}
          {isCompare && (
            <div className="flex items-center rounded border border-line-3 bg-surface-3 overflow-hidden shrink-0" role="radiogroup" aria-label={t('走行比較の合わせ方', 'Comparison alignment')}>
              {([
                ['distance', t('地点', 'Place'), t('Car 1 と同じ地点を走ったときの映像を並べます (比べる車の動画は速さを変えて回します)', 'Show each car at the same point as Car 1 (the other videos run at adjusted speed)')],
                ['time', t('時間', 'Time'), t('周の始めから同じ経過時間の映像を並べます (どの動画も 1 倍で回るので、差が開くと映る場所がずれます)', 'Show each car at the same time since the lap start (every video runs at 1x, so the views drift apart as the gap grows)')]
              ] as const).map(([value, label, title]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={win.compareAlign === value}
                  onClick={() => setWin({ compareAlign: value })}
                  title={title}
                  className={`px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer ${win.compareAlign === value ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* 走行比較: Car ごとの動画 (既定は、その車のログの時刻で周を映している動画) */}
          {isCompare && media.length > 0 && (
            <div className="flex items-center gap-1 pl-2 border-l border-line-2 shrink-0">
              {tiles.map(x => (
                <div key={x.slot} className="flex items-center shrink-0 whitespace-nowrap">
                  <span className="text-[10px] font-bold mr-0.5" style={{ color: x.color }}>Car {(x.slot ?? 0) + 1}</span>
                  <select
                    value={x.chosen && x.media ? x.media.id : ''}
                    onChange={e => videoViewStore.setCompareCamera(x.slot ?? 0, e.target.value || null)}
                    className="bg-surface-3 border border-line-3 text-xs text-slate-200 rounded px-1 py-1 outline-none max-w-[120px] truncate cursor-pointer"
                    title={t('この車の枠に出す動画。自動: この車のログの時刻で、周を映している動画', 'Video for this car. Auto: the video that covers the lap in this car\'s log time')}
                  >
                    <option value="">{t('自動', 'Auto')}{!x.chosen ? `: ${x.media?.label ?? t('なし', 'none')}` : ''}</option>
                    {media.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}

          {/* カメラの選択。1 つ目がメイン */}
          {!isCompare && media.length > 0 && (
            <div className="flex items-center gap-1 pl-2 border-l border-line-2 shrink-0">
              {cameras.map((m, i) => (
                <div key={i} className="flex items-center shrink-0 whitespace-nowrap">
                  <span className="text-[10px] text-slate-400 font-medium mr-0.5">
                    {i === 0 ? t('メイン', 'Main') : `${i + 1}`}
                  </span>
                  <select
                    value={m.id}
                    onChange={e => videoViewStore.setCamera(i, e.target.value)}
                    className="bg-surface-3 border border-line-3 text-xs text-slate-200 rounded px-1 py-1 outline-none max-w-[130px] truncate cursor-pointer"
                  >
                    {media.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                  {i > 0 && (
                    <button
                      onClick={() => videoViewStore.setCamera(i, null)}
                      className="p-0.5 text-slate-500 hover:text-slate-200 cursor-pointer"
                      title={t('この枠を外す', 'Remove this view')}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              ))}
              {cameras.length < Math.min(MAX_CAMERAS, media.length) && (
                <button
                  onClick={() => videoViewStore.setCamera(cameras.length, media.find(x => !cameraIds.includes(x.id))?.id ?? null)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded bg-surface-3 hover:bg-surface-5 text-[10px] text-slate-300 border border-line-3 cursor-pointer"
                  title={t('カメラの枠を足す', 'Add a camera view')}
                >
                  <Plus size={11} />{t('カメラ', 'Camera')}
                </button>
              )}
              {mainMedia && (
                <button
                  onClick={() => mainMedia.tracks.forEach(x => videoSyncManager.removeTrack(x.id))}
                  disabled={isAnyExporting}
                  title={t('メインの動画を一覧から消す', 'Remove the main video from the list')}
                  className="p-1 hover:bg-red-950/60 text-slate-400 hover:text-red-400 rounded transition-colors cursor-pointer"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}

          {/* 並べ方 (枠が 2 つ以上のとき) */}
          {tileCount > 1 && (
            <div className="flex items-center rounded border border-line-3 bg-surface-3 overflow-hidden">
              {([
                ['single', t('単一', 'Single'), t('メインだけを出す', 'Main only'), null],
                ['grid', t('並べる', 'Grid'), t('2 つなら左右、3〜4 つなら 2×2 に並べる。枠を押すと大きく出す', 'Side by side for 2, 2×2 for 3-4. Click a view to enlarge it'), <Columns size={11} key="c" />],
                ['pip', 'PinP', t('メインの上に 2 つ目を小窓で重ねる', 'Show the second view as a small window over the main one'), <PictureInPicture size={11} key="p" />]
              ] as const).map(([value, label, title, icon]) => (
                <button
                  key={value}
                  onClick={() => setWin({ layout: value, focus: null })}
                  className={`px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer flex items-center gap-1 ${win.layout === value ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  title={title}
                >
                  {icon}{label}
                </button>
              ))}
            </div>
          )}

          {/* 動画追加ボタン */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 px-2 py-1 rounded bg-surface-3 hover:bg-surface-5 text-xs text-slate-300 border border-line-3 transition-colors cursor-pointer"
            title={t('動画追加', 'Add video')}
          >
            <Plus size={12} />
            <span className="hidden xl:inline">{t('動画追加', 'Add video')}</span>
          </button>

          {/* 走行の確認 (ログと動画の組み合わせ・時刻の出どころ・地図) */}
          {media.length > 0 && (
            <button
              onClick={() => setShowRuns(true)}
              className="flex items-center gap-1 px-2 py-1 rounded bg-surface-3 hover:bg-surface-5 text-xs text-slate-300 border border-line-3 transition-colors cursor-pointer"
              title={t('走行の確認: 同じ走行のログと動画、動画の時刻の出どころ、地図', 'Runs: logs and videos of each run, how each video is timed, and a map')}
            >
              <ListChecks size={12} />
              <span className="hidden xl:inline">{t('走行の確認', 'Runs')}</span>
            </button>
          )}
        </div>

        {/* 右側アクション群 (ピン留め・MP4エクスポート・プロジェクト保存) */}
        <div className="flex items-center gap-1.5">
          {/* 手動キーフレーム同期 (ピン留め) ボタン */}
          {activeTrack && (
            <button
              onClick={() => setShowPinModal(true)}
              className="flex items-center gap-1 px-2 py-1 rounded bg-surface-3 hover:bg-surface-4 text-xs text-amber-300 border border-amber-500/40 transition-colors cursor-pointer"
              title={t('現在の動画フレームとGPS時刻を同期ピンとして固定', 'Pin the current video frame and GPS time as a sync point')}
            >
              <MapPin size={12} className="text-amber-400" />
              <span className="hidden xl:inline">{t('ピン留め同期', 'Pin sync')}</span> ({pins.length})
            </button>
          )}

          {/* テレメトリ動画書き出し (MP4 Burn-in) ボタン */}
          {activeTrack && (
            <button
              onClick={() => setShowExportModal(true)}
              className="flex items-center gap-1 px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-xs font-bold text-white transition-colors cursor-pointer"
              title={t('メーターオーバーレイ付きの動画をMP4形式で書き出し', 'Export the video with the gauge overlay as MP4')}
            >
              <Download size={12} />
              <span className="hidden xl:inline">{t('動画書き出し', 'Export video')}</span>
            </button>
          )}

          {/* 同期プロジェクト保存 / 読込 */}
          <button
            onClick={handleExportProject}
            className="flex items-center gap-1 px-2 py-1 rounded bg-surface-3 hover:bg-surface-4 text-xs text-slate-300 border border-line-3 transition-colors cursor-pointer"
            title={t('同期プロジェクト保存 (.dssync.json)', 'Save sync project (.dssync.json)')}
          >
            <Save size={12} />
          </button>
          <button
            onClick={() => jsonInputRef.current?.click()}
            className="flex items-center gap-1 px-2 py-1 rounded bg-surface-3 hover:bg-surface-4 text-xs text-slate-300 border border-line-3 transition-colors cursor-pointer"
            title={t('プロジェクト読込 (.dssync.json)', 'Load sync project (.dssync.json)')}
          >
            <FolderOpen size={12} />
          </button>

          {/* オーバーレイON/OFF */}
          <button
            onClick={() => setShowOverlay(!showOverlay)}
            className={`p-1 rounded border transition-colors cursor-pointer ${
              showOverlay ? 'bg-red-600/20 text-red-400 border-red-500/50' : 'bg-slate-800 text-slate-500 border-slate-700'
            }`}
            title={t('テレメトリ計器表示切替', 'Show or hide the telemetry gauges')}
          >
            {showOverlay ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        </div>
      </div>

      {/* 2. タイムゾーン設定 & 再同期専用バー (フラットデザイン) */}
      {/* 動画の時刻が大きくずれている (タイムゾーンの違いなど) ときは、直すボタンが見えるよう閉じていても出す */}
      {activeTrack && (showSyncTools || isLargeOffset) && (
        <div className="bg-surface-1 border-b border-line-1 px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0 select-none">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* 動画に合わせるログ (動画と時間の重なるログが 2 つ以上のとき。記録の細かい順) LATER-12 */}
            {(() => {
              const logs = overlappingSessions(activeTrack, sessions);
              if (logs.length < 2) return null;
              return (
                <div className="flex items-center gap-1 bg-surface-3 px-2 py-0.5 rounded border border-line-3" title={t('同じ時間に記録したログが複数あるとき、動画に合わせて表示するログを選びます (基準車 Car 1 になります)。既定は記録の細かいログ', 'When several logs were recorded at the same time, choose the log shown with the video (it becomes Car 1). By default the log with the highest rate')}>
                  <span className="text-slate-400 text-[10px] font-medium">{t('動画に合わせるログ:', 'Log for this video:')}</span>
                  <select
                    value={logs.some(l => l.id === activeTrack.matchedSessionId) ? activeTrack.matchedSessionId ?? '' : ''}
                    onChange={e => {
                      videoSyncManager.chooseSession(activeTrack.id, e.target.value);
                      onChooseLog?.(e.target.value);
                    }}
                    className="bg-transparent text-slate-100 font-bold text-xs outline-none cursor-pointer max-w-[220px] truncate"
                  >
                    {logs.map(l => (
                      <option key={l.id} value={l.id} className="bg-surface-3 text-slate-200">
                        {l.sessionName} ({l.samplingRate} Hz)
                      </option>
                    ))}
                  </select>
                </div>
              );
            })()}
            <label
              className="flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer"
              title={t('切ると、同じ時間に記録の細かいログ (デジスパイスなど) があるとき、GoPro の動画の GPS を走行ログとして加えず、動画の時刻合わせだけに使います。次に読み込む動画から効きます', 'When off, if a log with a higher rate (e.g. DigSpice) covers the same time, the GPS in GoPro videos is not added as a driving log and is only used to time the video. Applies to videos loaded next')}
            >
              <input
                type="checkbox"
                checked={addVideoGpsLog}
                onChange={e => { setAddVideoGpsLog(e.target.checked); setAddVideoGpsLogState(e.target.checked); }}
              />
              {t('動画の GPS もログとして加える', 'Add video GPS as a log')}
            </label>
            {/* 動画タイムゾーン選択 */}
            <div className="flex items-center gap-1 bg-surface-3 px-2 py-0.5 rounded border border-line-3">
              <span className="text-slate-400 text-[10px] font-medium">{t('動画TZ:', 'Video TZ:')}</span>
              <select
                value={activeTrack.videoTimezone || 'JST'}
                onChange={e => videoSyncManager.resyncTrack(activeTrack.id, sessions, e.target.value, undefined, baseSession?.id)}
                className="bg-transparent text-slate-100 font-bold text-xs outline-none cursor-pointer"
              >
                {TIMEZONE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value} className="bg-surface-3 text-slate-200">
                    {t(opt.label, opt.labelEn)}
                  </option>
                ))}
              </select>
            </div>

            {/* GPSタイムゾーン選択 */}
            <div className="flex items-center gap-1 bg-surface-3 px-2 py-0.5 rounded border border-line-3">
              <span className="text-slate-400 text-[10px] font-medium">GPS TZ:</span>
              <select
                value={activeTrack.gpsTimezone || 'JST'}
                onChange={e => videoSyncManager.resyncTrack(activeTrack.id, sessions, undefined, e.target.value, baseSession?.id)}
                className="bg-transparent text-slate-100 font-bold text-xs outline-none cursor-pointer"
              >
                {TIMEZONE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value} className="bg-surface-3 text-slate-200">
                    {t(opt.label, opt.labelEn)}
                  </option>
                ))}
              </select>
            </div>

            {/* 再同期ボタン */}
            <button
              onClick={() => videoSyncManager.resyncTrack(activeTrack.id, sessions, activeTrack.videoTimezone, activeTrack.gpsTimezone, baseSession?.id)}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-bold text-[11px] transition-colors cursor-pointer"
              title={t('タイムゾーンに基づきオフセット再計算', 'Recalculate the offset from the time zones')}
            >
              <RefreshCw size={11} />
              {t('再同期', 'Resync')}
            </button>
          </div>

          {/* 時刻診断 & 時差ズレ即時補正 */}
          <div className="flex items-center gap-2 text-[11px]">
            {isLargeOffset && (
              <div className="flex items-center gap-1.5 bg-amber-950/80 border border-amber-600 text-amber-300 px-2 py-0.5 rounded">
                <AlertTriangle size={12} className="text-amber-400 shrink-0" />
                <span>{t(`約${Math.round(Math.abs(activeTrack.syncOffsetSec) / 3600)}hズレ`, `About ${Math.round(Math.abs(activeTrack.syncOffsetSec) / 3600)} h off`)}</span>
                <button
                  onClick={() => videoSyncManager.shiftOffsetHours(activeTrack.id, activeTrack.syncOffsetSec > 0 ? -9 : 9)}
                  className="px-1.5 py-0.2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded text-[10px] cursor-pointer"
                  title={t('9時間時差を打ち消し', 'Cancel a 9-hour time zone difference')}
                >
                  {t('±9h補正', '±9 h fix')}
                </button>
              </div>
            )}

            <div className="hidden lg:flex items-center gap-2 bg-surface-1 px-2.5 py-0.5 rounded border border-line-2 text-slate-400 font-mono text-[11px]">
              <span>{t('動画', 'Video')}: <strong className="text-slate-200">{formatTzDate(activeTrack.rawRecordedAt, activeTrack.videoTimezone || 'JST')}</strong></span>
              <span className="text-slate-600">|</span>
              <span>GPS: <strong className="text-slate-200">{formatTzDate(gpsStartTime, activeTrack.gpsTimezone || 'JST')}</strong></span>
            </div>
          </div>
        </div>
      )}

      {/* 3. メイン動画プレイヤーエリア (Single / Split / PinP 対応) */}
      <div 
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex-1 relative flex overflow-hidden ${isGraphEmbedded ? 'min-h-[150px]' : ''} ${
          // 動画を表示しているときは、映像に重ねる表示が読めるよう、ライトモードでも暗い配色にする
          activeTrack && activeTrack.objectUrl ? 'bg-black keep-dark' : 'bg-surface-1'
        } ${
          isDragging ? 'border-2 border-dashed border-red-500 bg-red-950/20' : ''
        }`}
      >
        {/* ドラッグ中オーバーレイ */}
        {isDragging && (
          <div className="absolute inset-0 bg-red-950/80 flex flex-col items-center justify-center z-40 pointer-events-none space-y-1">
            <Video size={40} className="text-red-400 animate-bounce" />
            <p className="text-sm font-bold text-fg">{t('ここに動画ファイル（.mp4, .mov）をドロップ', 'Drop video files (.mp4, .mov) here')}</p>
          </div>
        )}

        {hasStage ? (
          <>
            {/* カメラの枠 (VideoStage が並べ、VideoTile が 1 つずつ出す)。メーターはメインの枠に重ねる */}
            <VideoStage
              count={tileCount}
              layout={win.layout}
              focus={win.focus}
              pipPosition={pipPosition}
              pipRef={pipRef}
              compact={isCompactLayout ? { stackTwo: isCompare && !isLandscape } : undefined}
              onFocus={i => setWin({ focus: i })}
              renderTile={(i, size) => {
                const x = tiles[i];
                const isMain = i === 0;
                // 音を出すのは、大きく出している枠 (なければメイン) だけ
                const sound = win.focus !== null ? i === win.focus : isMain;
                return (
                  <VideoTile
                    key={`tile-${i}`}
                    tileKey={`tile-${i}`}
                    controller={playback}
                    position={positions[i] ?? null}
                    muted={!sound}
                    useProxy={proxyFor(i)}
                    active={isVisible}
                    onSeeked={handleSeeked}
                    overlay={overlayFor(x, i)}
                    avoidRef={isMain && win.layout === 'pip' ? pipRef : undefined}
                    accent={isCompare ? x.color : undefined}
                    emptyText={isCompare ? t('この周を映している動画がありません', 'No video covers this lap') : undefined}
                    onClick={win.layout === 'grid' && tileCount > 1 && size !== 'pip' ? () => setWin({ focus: win.focus === i ? null : i }) : undefined}
                    className="flex-1 w-full h-full"
                    children={isMain && gpsMismatchM !== null ? (
                      <button
                        onClick={e => { e.stopPropagation(); setShowRuns(true); }}
                        className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 bg-red-950/90 border border-red-600 text-red-200 px-2 py-1 rounded text-[11px] cursor-pointer"
                        title={t('押すと走行の確認を開きます', 'Click to open the run inspector')}
                      >
                        <AlertTriangle size={12} className="text-red-400 shrink-0" />
                        {t(`動画の GPS と ${baseSession?.sessionName ?? ''} の位置が ${gpsMismatchM} m 離れています (別の車のログか、時刻のずれ)`, `The video's GPS is ${gpsMismatchM} m from ${baseSession?.sessionName ?? ''} (another car's log, or a time offset)`)}
                      </button>
                    ) : undefined}
                    badge={(

                      <>
                        {isCompare ? (
                          <>
                            <span className="font-bold" style={{ color: x.color }}>Car {(x.slot ?? 0) + 1}</span>
                            {x.delta !== undefined && x.delta !== null && (
                              <span className={x.delta > 0 ? 'text-red-300' : 'text-emerald-300'}>{x.delta >= 0 ? '+' : '−'}{Math.abs(x.delta).toFixed(2)}</span>
                            )}
                            {x.media && <span className="truncate text-slate-400 font-normal">{x.media.label}</span>}
                          </>
                        ) : (
                          <span className={`truncate ${isMain ? 'text-red-400' : 'text-blue-400'}`}>{x.media?.label}</span>
                        )}
                        {!isMain && !isCompare && (
                          <button
                            onClick={e => { e.stopPropagation(); videoViewStore.makeMain(i); }}
                            className="text-slate-400 hover:text-amber-300 cursor-pointer"
                            title={t('この動画をメインにする (メーター・同期の調整の対象)', 'Make this the main video (gauges and sync settings)')}
                          >
                            <ArrowLeftRight size={10} />
                          </button>
                        )}
                        {size === 'pip' && (
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              const next: PipPosition = pipPosition === 'bottom-right' ? 'bottom-left' : pipPosition === 'bottom-left' ? 'top-left' : pipPosition === 'top-left' ? 'top-right' : 'bottom-right';
                              setWin({ pipPosition: next });
                            }}
                            className="text-slate-400 hover:text-blue-300 cursor-pointer"
                            title={t('PinPの四隅表示位置を切り替え', 'Move the PiP window to another corner')}
                          >
                            <Maximize2 size={10} />
                          </button>
                        )}
                        {!sound && <VolumeX size={10} className="text-slate-500" />}
                        {x.media && (() => {
                          const b = syncBadgeOf(x.position?.track ?? x.media.tracks[0], t);
                          return (
                            <button
                              onClick={e => { e.stopPropagation(); setShowRuns(true); }}
                              className={`px-1 rounded border text-[9px] font-normal cursor-pointer ${BADGE_CLASS[b.level]}`}
                              title={`${b.title} (${t('押すと走行の確認を開きます', 'click to open the run inspector')})`}
                            >
                              {b.label}
                            </button>
                          );
                        })()}
                      </>
                    )}
                  />
                );
              }}
            />

            {heavyCount >= 3 && (
              <div className="absolute top-2 right-2 z-30 bg-amber-950/90 border border-amber-600 text-amber-200 px-2 py-1 rounded text-[11px] max-w-xs">
                {t('4K の動画を 3 つ以上同時に再生しています。引っかかるときは、GoPro の .LRV ファイルも一緒に読み込むと、小さな枠は低画質で軽く出せます', 'Three or more 4K videos are playing at once. If playback stutters, also load the GoPro .LRV files so the small views use the light low-res copies')}
              </div>
            )}

            {/* 録画開始前インジケーター */}
            {!isCompare && activeTrack && renderSessionTime < activeTrack.syncOffsetSec && (
              <div className="absolute top-3 bg-amber-950/90 border border-amber-600 text-amber-200 px-3 py-1.5 rounded flex items-center gap-2 text-xs font-medium z-20">
                <Clock size={14} className="text-amber-400 animate-pulse shrink-0" />
                <span>{t('動画開始まであと', 'Video starts in')} <strong className="font-mono text-amber-300">{(activeTrack.syncOffsetSec - (isGraphEmbedded && baseLap ? baseLap.startTime + currentTimeSec : currentTimeSec)).toFixed(1)}s</strong></span>
                <button
                  onClick={() => seekTo(isGraphEmbedded && baseLap ? Math.max(0, activeTrack.syncOffsetSec - baseLap.startTime) : activeTrack.syncOffsetSec)}
                  className="px-1.5 py-0.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded text-[10px] cursor-pointer ml-1"
                >
                  {t('開始点へジャンプ', 'Jump to start')}
                </button>
              </div>
            )}
          </>
        ) : (
          // 動画がないときの案内。狭いウインドウでも切れないよう、大きなアイコンは出さず、はみ出したらスクロールする
          // (中央に寄せるのは m-auto で行う。justify-center だと、収まらないときに上が切れてスクロールでも見えないため)
          <div className="flex flex-col w-full h-full p-3 overflow-y-auto">
            <div className="m-auto flex flex-col items-center text-center space-y-2">
              <h3 className="text-sm font-bold text-slate-200">{t('車載動画（オンボード映像）を読み込む', 'Load onboard video')}</h3>
              <p className="text-xs text-slate-400 max-w-sm leading-relaxed">
                {t('GoPro（H.265 / HEVC 4GBチャプター分割対応）や複数カメラの MP4 / MOV 動画をここにドラッグ＆ドロップしてください。', 'Drag and drop GoPro (H.265 / HEVC, 4 GB chapters supported) or other MP4 / MOV videos from one or more cameras here.')}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-bold text-xs transition-colors cursor-pointer"
                >
                  <Upload size={13} />
                  {t('動画ファイルを選択', 'Choose video files')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 4. チャプター分割動画 (GoPro/DJI) ナビゲーションバー */}
      {currentGroup && currentGroup.tracks.length > 1 && (
        <div className="bg-surface-1 border-t border-line-1 px-3 py-1 flex flex-wrap items-center justify-between gap-2 shrink-0 select-none text-xs">
          <div className="flex items-center gap-1.5">
            <span className="flex items-center gap-1 text-[11px] font-bold text-slate-200">
              <Layers size={12} className="text-red-400 shrink-0" />
              {currentGroup.brand === 'gopro' ? 'GoPro' : currentGroup.brand.toUpperCase()} {currentGroup.sessionId}
              <span className="text-slate-400 font-normal">{t(`(${currentGroup.tracks.length}チャプター連動, 計 ${formatDuration(currentGroup.totalDurationSec)})`, `(${currentGroup.tracks.length} chapters linked, ${formatDuration(currentGroup.totalDurationSec)} total)`)}</span>
            </span>

            <button
              onClick={() => {
                const prev = getPreviousChapter(currentGroup, activeTrack?.id || '');
                if (prev) {
                  const newSessionTime = prev.track.syncOffsetSec;
                  if (isGraphEmbedded && baseLap) {
                    seekTo(Math.max(0, newSessionTime - baseLap.startTime));
                  } else {
                    seekTo(newSessionTime);
                  }
                }
              }}
              disabled={!getPreviousChapter(currentGroup, activeTrack?.id || '')}
              className="p-1 rounded bg-surface-3 hover:bg-surface-4 disabled:opacity-30 text-slate-300 transition-colors cursor-pointer"
              title={t('前のチャプターへ', 'Previous chapter')}
            >
              <ChevronLeft size={12} />
            </button>

            <div className="flex items-center gap-1">
              {currentGroup.tracks.map((ct) => {
                const isCurrent = ct.track.id === activeTrack?.id;
                return (
                  <button
                    key={ct.track.id}
                    onClick={() => {
                      const targetSessionTime = ct.track.syncOffsetSec;
                      if (isGraphEmbedded && baseLap) {
                        seekTo(Math.max(0, targetSessionTime - baseLap.startTime));
                      } else {
                        seekTo(targetSessionTime);
                      }
                    }}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                      isCurrent
                        ? 'bg-red-600 text-white font-bold'
                        : 'bg-surface-3 text-slate-400 hover:text-slate-200 border border-line-2'
                    }`}
                  >
                    Ch {ct.chapterIndex} ({formatDuration(ct.durationSec)})
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => {
                const next = getNextChapter(currentGroup, activeTrack?.id || '');
                if (next) {
                  const targetSessionTime = next.track.syncOffsetSec;
                  if (isGraphEmbedded && baseLap) {
                    seekTo(Math.max(0, targetSessionTime - baseLap.startTime));
                  } else {
                    seekTo(targetSessionTime);
                  }
                }
              }}
              disabled={!getNextChapter(currentGroup, activeTrack?.id || '')}
              className="p-1 rounded bg-surface-3 hover:bg-surface-4 disabled:opacity-30 text-slate-300 transition-colors cursor-pointer"
              title={t('次のチャプターへ', 'Next chapter')}
            >
              <ChevronRight size={12} />
            </button>
          </div>

          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/70 border border-emerald-800/80 px-1.5 py-0.2 rounded">
            {t('シームレス連続再生: 有効', 'Seamless playback: on')}
          </span>
        </div>
      )}

      {/* 5. マスタータイムライン マルチトラックインスペクター (NLE風) */}
      {showSyncTools && (() => {
        const effectiveSessionTime = isGraphEmbedded && baseLap ? (baseLap.startTime + currentTimeSec) : currentTimeSec;
        return (
          <MasterTimelineTrackBar
            session={baseSession}
            baseLap={baseLap}
            activeTrack={activeTrack}
            subTrack={!isCompare && shownCount > 1 ? positions[1]?.track : undefined}
            chapterGroup={currentGroup}
            pins={pins}
            currentSessionTimeSec={effectiveSessionTime}
            onSeekSessionTime={(targetSessionTime) => {
              if (isGraphEmbedded && baseLap) {
                seekTo(Math.max(0, targetSessionTime - baseLap.startTime));
              } else {
                seekTo(targetSessionTime);
              }
            }}
            formatDuration={formatDuration}
          />
        );
      })()}

      {/* 6. 速度ウィンドウ完全同期 シークバー (Lap/Session切替対応) */}
      {(() => {
        // グラフ解析に埋め込んだときは、グラフ解析の下の段 (PlayBar) でシーク・再生するので出さない (二重にしない)
        if (isGraphEmbedded && baseLap) return null;
        const effectiveSessionTime = isGraphEmbedded && baseLap ? (baseLap.startTime + currentTimeSec) : currentTimeSec;
        // グラフ画面の動画は選んだ周の中だけで再生する (App の時刻が周の時刻なので、周の外へは動かせない)。
        // ログ全体を見るのは動画同期タブ
        // 走行比較は周の中で比べるので、いつも周の時刻にする
        const isLapMode = (seekbarScope === 'lap' || isGraphEmbedded || isCompare) && baseLap;
        
        // セッション全体は、ログの終わりか動画の終わりの遅いほうまで
        const logEnd = baseSession && baseSession.points.length > 0 ? baseSession.points[baseSession.points.length - 1].time : 0;
        // App の再生の終わりと同じ (表示しているメインとサブの動画。チャプターに分かれた動画は最後のチャプターまで)
        // サブの動画は、ログの記録と時間が重なるときだけ範囲に入れる (撮影日の違う動画で、範囲が何日にも伸びないように)
        const subEnds = isCompare ? [] : cameras.slice(1, shownCount).map(m => m.tracks[0]).filter(x => x.syncOffsetSec < logEnd).map(videoEndSessionSec);
        const subEnd = Math.max(0, ...subEnds);
        const sessionMax = Math.max(logEnd, videoEndSessionSec(activeTrack), subEnd) || 60;

        // 周の時刻は、周の始めからの時刻 (動画同期タブでは App の時刻がセッション全体の時刻なので、周の始めを引く)
        const maxVal = isLapMode ? (baseLap.lapTime || 60) : sessionMax;
        const curVal = isLapMode ? effectiveSessionTime - baseLap.startTime : effectiveSessionTime;

        return (
          <div className="bg-surface-1 border-t border-line-1 px-3 py-1 flex items-center justify-between gap-2.5 shrink-0 select-none">
            {/* スコープ切替スイッチ (Lap / Session)。グラフ画面では周だけ */}
            {baseLap && !isGraphEmbedded && (
              <div className="flex items-center rounded border border-line-2 bg-surface-2 text-[10px] overflow-hidden shrink-0">
                <button
                  onClick={() => setSeekbarScope('lap')}
                  className={`px-2 py-0.5 font-bold transition-colors cursor-pointer ${
                    isLapMode ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title={t('速度ウィンドウで選択中のラップ時間 (0〜lapTime) に同期', 'Sync to the lap selected in the speed window (0 to lap time)')}
                >
                  L{baseLap.lapNumber}
                </button>
                <button
                  onClick={() => setSeekbarScope('session')}
                  className={`px-2 py-0.5 font-bold transition-colors cursor-pointer ${
                    !isLapMode ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title={t('セッション全体の絶対時間に同期', 'Sync to the absolute time of the whole session')}
                >
                  {t('全体', 'All')}
                </button>
              </div>
            )}

            {/* 現在時刻表示 */}
            <span className="text-[11px] font-mono text-emerald-400 min-w-[50px] font-bold">
              {formatDuration(curVal)}
            </span>

            {/* スライダー本体 (速度ウィンドウと完全同期) */}
            <input
              type="range"
              min={0}
              max={maxVal}
              step={0.05}
              value={Math.max(0, Math.min(maxVal, curVal))}
              onChange={e => {
                const val = parseFloat(e.target.value);
                if (isLapMode) {
                  seekTo(isGraphEmbedded ? val : baseLap.startTime + val);
                } else {
                  if (isGraphEmbedded && baseLap) {
                    seekTo(Math.max(0, val - baseLap.startTime));
                  } else {
                    seekTo(val);
                  }
                }
              }}
              className="flex-1 h-1 bg-slate-700 rounded appearance-none cursor-pointer accent-red-500"
            />

            {/* 終了時刻表示 */}
            <span className="text-[11px] font-mono text-slate-400 min-w-[50px] text-right font-medium">
              {formatDuration(maxVal)}
            </span>
          </div>
        );
      })()}

      {/* 6. 下部同期調整 ＆ 再生コントロールバー (フラットデザイン)。グラフ解析に埋め込んだときは、再生のボタンはグラフ解析の下の段に任せ、
          同期の調整を出すときだけこの段を出す */}
      {(!isGraphEmbedded || !baseLap || (activeTrack && (!isCompactLayout || showSyncTools))) && (
      <div className="min-h-12 py-1 bg-surface-1 border-t border-line-1 px-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 shrink-0">
        {/* 再生ボタン群 */}
        {/* グラフ解析で周を選んでいるときは、グラフ解析の下の段に任せる (周がないときは、その段が出ないのでここに出す) */}
        {!(isGraphEmbedded && baseLap) && (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => seekTo(Math.max(0, currentTimeSec - 1.0))}
            className="p-1.5 rounded bg-surface-3 hover:bg-surface-4 border border-line-2 text-slate-300 transition-colors cursor-pointer"
            title={t('1秒戻る', 'Back 1 s')}
          >
            <SkipBack size={14} />
          </button>
          <button
            onClick={onTogglePlay}
            className="p-2 rounded bg-red-600 hover:bg-red-500 text-white font-bold transition-colors cursor-pointer"
            title={isPlaying ? t('一時停止', 'Pause') : t('再生', 'Play')}
          >
            {isPlaying ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button
            onClick={() => seekTo(currentTimeSec + 1.0)}
            className="p-1.5 rounded bg-surface-3 hover:bg-surface-4 border border-line-2 text-slate-300 transition-colors cursor-pointer"
            title={t('1秒進む', 'Forward 1 s')}
          >
            <SkipForward size={14} />
          </button>

          {/* 再生速度 */}
          <select
            value={String(playbackSpeed)}
            onChange={e => onChangePlaybackSpeed(parseFloat(e.target.value))}
            className="bg-surface-3 border border-line-3 text-[11px] font-mono text-slate-300 rounded px-1.5 py-0.5 outline-none ml-1.5 cursor-pointer"
          >
            {/* ヘッダーの再生速度と同じ値を共有するので、選べる値もヘッダーと同じ (0.5 / 1 / 2 / 4 倍) にする */}
            {[0.5, 1, 2, 4].map(v => (
              <option key={v} value={String(v)}>{v}x</option>
            ))}
          </select>
        </div>
        )}

        {/* 同期オフセット微調整 & ピン選択。スマートフォンでは「同期の調整」を開いたときだけ出す (場所を取るため) */}
        {activeTrack && (!isCompactLayout || showSyncTools) && (
          <div className="flex flex-wrap items-center gap-2 text-xs bg-surface-3 px-3 py-1 rounded border border-line-2">
            {/* 登録済みピンのクイックジャンプドロップダウン */}
            {pins.length > 0 && (
              <div className="flex items-center gap-1 border-r border-line-3 pr-2">
                <MapPin size={12} className="text-amber-400 shrink-0" />
                <select
                  onChange={e => {
                    const pin = pins.find(p => p.id === e.target.value);
                    if (pin) handleJumpToPin(pin);
                  }}
                  className="bg-transparent text-amber-300 font-bold text-[11px] outline-none cursor-pointer max-w-[110px] truncate"
                  defaultValue=""
                >
                  <option value="" disabled className="bg-surface-3 text-slate-400">{t('ピン一覧', 'Pins')} ({pins.length})</option>
                  {pins.map(p => (
                    <option key={p.id} value={p.id} className="bg-surface-3 text-slate-200">
                      {p.name} ({formatPinTime(p.sessionTimeSec)})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <span className="text-slate-400 flex items-center gap-1 text-[11px]">
              <Sliders size={12} className="text-amber-400" />
              {t('オフセット:', 'Offset:')}
              <input
                type="number"
                step="0.05"
                value={activeTrack.syncOffsetSec}
                onChange={e => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) setOffset(activeTrack.id, val);
                }}
                className="w-20 bg-surface-1 border border-line-3 text-amber-400 font-mono font-bold px-1 py-0.5 rounded text-right outline-none focus:border-amber-400"
              />
              s
            </span>

            {/* 微調整ボタン群 */}
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => handleNudgeOffset(-1.0)}
                className="px-1.5 py-0.5 rounded bg-surface-4 hover:bg-surface-5 text-[10px] font-mono text-slate-300 cursor-pointer"
              >
                -1s
              </button>
              <button
                onClick={() => handleNudgeOffset(-0.05)}
                className="px-1.5 py-0.5 rounded bg-surface-4 hover:bg-surface-5 text-[10px] font-mono text-slate-200 cursor-pointer"
              >
                -0.05s
              </button>
              <button
                onClick={() => handleNudgeOffset(0.05)}
                className="px-1.5 py-0.5 rounded bg-surface-4 hover:bg-surface-5 text-[10px] font-mono text-slate-200 cursor-pointer"
              >
                +0.05s
              </button>
              <button
                onClick={() => handleNudgeOffset(1.0)}
                className="px-1.5 py-0.5 rounded bg-surface-4 hover:bg-surface-5 text-[10px] font-mono text-slate-300 cursor-pointer"
              >
                +1s
              </button>
            </div>

            <button
              onClick={handleSyncCurrentFrame}
              className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-[11px] font-bold text-white transition-colors cursor-pointer ml-1"
              title={t('現在フレームでGPSと同期', 'Sync the GPS to the current frame')}
            >
              {t('現フレームで同期', 'Sync to this frame')}
            </button>
          </div>
        )}
      </div>
      )}

      {/* 7. 手動キーフレーム同期 (ピン留め) モーダル */}
      {showPinModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-surface-2 border border-line-3 rounded p-4 w-full max-w-sm text-slate-200 space-y-3 font-sans">
            <div className="flex items-center justify-between border-b border-line-3 pb-2">
              <span className="text-sm font-bold flex items-center gap-1.5 text-amber-400">
                <MapPin size={15} />
                {t('キーフレーム同期ピンの追加', 'Add a keyframe sync pin')}
              </span>
              <button
                onClick={() => setShowPinModal(false)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              {t('現在の一時停止位置（GPS時刻と動画フレーム）をキーフレームとしてピン留めし、オフセットを固定します。', 'Pins the current paused position (GPS time and video frame) as a keyframe and locks the offset.')}
            </p>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-300">{t('ピン名 (地点名):', 'Pin name (place):')}</label>
              <input
                type="text"
                placeholder={t('例: 1コーナーAPEX, コントロールライン', 'e.g. Turn 1 apex, timing line')}
                value={newPinName}
                onChange={e => setNewPinName(e.target.value)}
                className="w-full bg-surface-1 border border-line-3 text-xs px-2.5 py-1.5 rounded outline-none focus:border-amber-400 text-slate-100"
                autoFocus
              />
            </div>

            {/* 登録済みピン一覧 */}
            {pins.length > 0 && (
              <div className="space-y-1 pt-1">
                <span className="text-[10px] font-medium text-slate-400">{t(`登録済みピン (${pins.length}件):`, `Saved pins (${pins.length}):`)}</span>
                <div className="max-h-28 overflow-y-auto space-y-1 bg-surface-1 p-1.5 rounded border border-line-1">
                  {pins.map(p => (
                    <div key={p.id} className="flex items-center justify-between text-[11px] text-slate-300 py-0.5 px-1 hover:bg-surface-3 rounded">
                      <span className="truncate max-w-[180px] font-medium text-amber-300">{p.name}</span>
                      <div className="flex items-center gap-1.5 font-mono text-[10px] text-slate-400">
                        <span>{formatPinTime(p.sessionTimeSec)}</span>
                        <button
                          onClick={() => handleDeletePin(p.id)}
                          className="hover:text-red-400 text-slate-500 cursor-pointer"
                          title={t('削除', 'Delete')}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-line-3">
              <button
                onClick={() => setShowPinModal(false)}
                className="px-3 py-1 rounded bg-surface-4 hover:bg-surface-5 text-xs text-slate-300 cursor-pointer"
              >
                {t('閉じる', 'Close')}
              </button>
              <button
                onClick={handleAddPin}
                className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs transition-colors cursor-pointer"
              >
                {t('現在位置でピン留め', 'Pin here')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. テレメトリ動画焼き込みエクスポート設定モーダル */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-surface-2 border border-line-3 rounded p-4 w-full max-w-sm text-slate-200 space-y-3 font-sans">
            <div className="flex items-center justify-between border-b border-line-3 pb-2">
              <span className="text-sm font-bold flex items-center gap-1.5 text-red-400">
                <Download size={15} />
                {t('テレメトリ動画書き出し設定', 'Telemetry video export')}
              </span>
              <button
                onClick={() => setShowExportModal(false)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              {t('車載動画にメーター（速度・Gフォース・ラップタイム）を合成し、MP4動画としてエクスポートします。', 'Composites gauges (speed, G-force, lap time) onto the onboard video and exports it as MP4.')}
            </p>

            {/* 書き出し範囲選択 */}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-300">{t('書き出し範囲:', 'Range:')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setExportRange('lap')}
                  className={`px-2 py-1.5 rounded border text-xs font-bold transition-colors cursor-pointer ${
                    exportRange === 'lap'
                      ? 'bg-red-600 text-white border-red-500'
                      : 'bg-surface-1 text-slate-400 border-line-3 hover:text-slate-200'
                  }`}
                >
                  {baseLap ? `Lap ${baseLap.lapNumber} ${t('(ラップ区間)', '(lap)')}` : t('選択ラップ', 'Selected lap')}
                </button>
                <button
                  onClick={() => setExportRange('all')}
                  className={`px-2 py-1.5 rounded border text-xs font-bold transition-colors cursor-pointer ${
                    exportRange === 'all'
                      ? 'bg-red-600 text-white border-red-500'
                      : 'bg-surface-1 text-slate-400 border-line-3 hover:text-slate-200'
                  }`}
                >
                  {t('動画全体', 'Whole video')}
                </button>
              </div>
            </div>

            {/* 枠の並びで書き出す (枠が 2 つ以上のとき) */}
            {tileCount > 1 && (
              <div className="space-y-1.5 text-[11px]">
                <label className="flex items-start gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={exportStage} onChange={e => setExportStage(e.target.checked)} className="mt-0.5" />
                  <span>{t('今の枠の並びで書き出す (メーター・Car の札も入れます。再生しながら実時間で録ります)', 'Export the current layout of views (with gauges and car labels; recorded in real time while playing)')}</span>
                </label>
                {exportStage && (
                  <label className={`flex items-start gap-1.5 ${tiles.some(x => x.media?.tracks.some(tr => tr.proxyUrl)) ? 'cursor-pointer' : 'opacity-50'}`}>
                    <input
                      type="checkbox"
                      checked={exportDraft}
                      disabled={!tiles.some(x => x.media?.tracks.some(tr => tr.proxyUrl))}
                      onChange={e => setExportDraft(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>{t('下書き: GoPro の .LRV (低画質のファイル) で軽く録る。.LRV を読み込んだ動画だけ', 'Draft: record with the GoPro .LRV low-res copies (lighter). Only for videos whose .LRV is loaded')}</span>
                  </label>
                )}
              </div>
            )}

            {/* 解像度 & フレームレート選択 */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-slate-400">{t('解像度:', 'Resolution:')}</label>
                <select
                  value={exportResolution}
                  onChange={e => setExportResolution(e.target.value as any)}
                  className="w-full bg-surface-1 border border-line-3 text-xs px-2 py-1 rounded outline-none text-slate-200 cursor-pointer"
                >
                  <option value="1080p">1080p (Full HD)</option>
                  <option value="720p">720p (HD)</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-slate-400">{t('フレームレート:', 'Frame rate:')}</label>
                <select
                  value={exportFps}
                  onChange={e => setExportFps(parseInt(e.target.value, 10))}
                  className="w-full bg-surface-1 border border-line-3 text-xs px-2 py-1 rounded outline-none text-slate-200 cursor-pointer"
                >
                  <option value="30">{t('30 fps (推奨)', '30 fps (recommended)')}</option>
                  <option value="60">{t('60 fps (高品質)', '60 fps (high quality)')}</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-line-3">
              <button
                onClick={() => setShowExportModal(false)}
                className="px-3 py-1 rounded bg-surface-4 hover:bg-surface-5 text-xs text-slate-300 cursor-pointer"
              >
                {t('キャンセル', 'Cancel')}
              </button>
              <button
                onClick={handleStartExport}
                className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-bold text-xs transition-colors cursor-pointer"
              >
                {t('書き出し開始', 'Start export')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 9. エクスポート進行状況モーダル */}
      {/* 開始位置への移動中 (進み具合がまだ来ていないとき) も出して、キャンセルできるようにする */}
      {/* 画面のいちばん上に出す (このウインドウを隠しても、進み具合が見えてキャンセルできるように) */}
      {isExporting && createPortal(
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-surface-2 border border-line-3 rounded p-5 w-full max-w-sm text-slate-200 space-y-4 font-sans text-center">
            <h4 className="text-sm font-bold text-red-400 flex items-center justify-center gap-2">
              <Download size={16} className="animate-bounce" />
              {t('テレメトリ動画をレンダリング・書き出し中...', 'Rendering and exporting the telemetry video...')}
            </h4>

            {/* プログレスバー */}
            <div className="space-y-1">
              <div className="w-full h-2.5 bg-surface-1 rounded border border-line-3 overflow-hidden">
                <div
                  className="h-full bg-red-600 transition-all duration-200"
                  style={{ width: `${exportProgress?.percent ?? 0}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>{exportProgress ? `${exportProgress.percent}%` : t('準備中', 'Preparing')}</span>
                {exportProgress && (
                  <span>{t('残り約', 'About')} {Math.max(0, Math.round(exportProgress.totalSec * (100 - exportProgress.percent) / 100))}s{t('', ' left')}</span>
                )}
              </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              {t('完了するとブラウザのダウンロードフォルダに MP4 動画が保存されます。', 'When finished, the MP4 video is saved to your browser\'s download folder.')}
            </p>

            <button
              onClick={() => {
                if (exportControllerRef.current) {
                  exportControllerRef.current.cancel();
                }
              }}
              className="px-4 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-300 cursor-pointer transition-colors"
            >
              {t('キャンセル', 'Cancel')}
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* 隠しインプット */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleAddVideos}
        multiple
        // iPhone では動画の種類を指定すると「写真」から選ぶ画面になり、iOS が変換して GoPro の GPS が消えることがあるので、指定しない
        accept={fileAccept('video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.lrv')}
        className="hidden"
      />
      <input
        type="file"
        ref={jsonInputRef}
        onChange={handleImportProject}
        accept={fileAccept('.json,.dssync.json')}
        className="hidden"
      />
    </div>
  );
};
