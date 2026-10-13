import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Play, Pause, SkipBack, SkipForward, Video, Upload, 
  Save, FolderOpen, RefreshCw, Sliders, Eye, EyeOff, 
  Clock, Gauge, Plus, Trash2, CheckCircle2, ChevronRight,
  Globe, AlertTriangle, Zap, Layers, ChevronLeft,
  Columns, PictureInPicture, MapPin, Download, X,
  ArrowLeftRight, Volume2, VolumeX, Maximize2
} from 'lucide-react';
import { Session, TelemetryPoint, SelectedCarSlot } from '../types/telemetry';
import { videoSyncManager, VideoTrack, TIMEZONE_OPTIONS, getTimezoneOffsetMs } from '../services/videoSyncManager';
import { 
  resolveChapterPlayback, 
  getNextChapter, 
  getPreviousChapter, 
  VideoChapterGroup 
} from '../services/videoChapterManager';
import { 
  SyncPin, 
  createSyncPin, 
  applyPinToTrack, 
  formatPinTime, 
  savePinsToStorage, 
  loadPinsFromStorage 
} from '../services/videoSyncPinManager';
import { 
  exportBurnedInVideo, 
  VideoExportController 
} from '../services/telemetryVideoExporter';
import { MasterTimelineTrackBar } from './MasterTimelineTrackBar';

export type VideoViewMode = 'single' | 'split' | 'pip';
export type PipPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

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
  showGForce: boolean = true
) {
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
  ctx.translate(32, h - 96);

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
    ctx.translate(w - 128, h - 96);

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
  ctx.translate(w - 170, 20);

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

  const m = Math.floor(Math.max(0, lapDisplayTime) / 60);
  const s = (Math.max(0, lapDisplayTime) % 60).toFixed(2).padStart(5, '0');
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 18px monospace';
  ctx.fillText(`${m}:${s}`, 12, 42);

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
  isGraphEmbedded = false
}) => {
  const [tracks, setTracks] = useState<VideoTrack[]>(() => videoSyncManager.getTracks());
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(tracks[0]?.id || null);
  const [subTrackId, setSubTrackId] = useState<string | null>(tracks[1]?.id || null);
  
  // 2画面 / PinP 表示モード
  const [viewMode, setViewMode] = useState<VideoViewMode>('single');
  const [pipPosition, setPipPosition] = useState<PipPosition>('bottom-right');
  const [isSubMuted, setIsSubMuted] = useState<boolean>(true);

  // シークバースコープ ('lap': 速度ウィンドウ選択中ラップ時間, 'session': セッション全体時間)
  const [seekbarScope, setSeekbarScope] = useState<'lap' | 'session'>('lap');

  // 表示切替
  const [showOverlay, setShowOverlay] = useState<boolean>(true);
  const [showGForce, setShowGForce] = useState<boolean>(true);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // 手動キーフレーム同期（ピン留め）ステート
  const [pins, setPins] = useState<SyncPin[]>(() => loadPinsFromStorage(circuitName || 'default'));
  const [showPinModal, setShowPinModal] = useState<boolean>(false);
  const [newPinName, setNewPinName] = useState<string>('');

  // 動画テレメトリ焼き込みエクスポートステート
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [exportRange, setExportRange] = useState<'lap' | 'all'>('lap');
  const [exportResolution, setExportResolution] = useState<'1080p' | '720p'>('1080p');
  const [exportFps, setExportFps] = useState<number>(30);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<{ currentSec: number; totalSec: number; percent: number } | null>(null);
  const exportControllerRef = useRef<VideoExportController | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const subVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const jsonInputRef = useRef<HTMLInputElement | null>(null);

  // 速度ウィンドウの選択状態 (Car 1) を最優先で参照
  const baseSelected = selectedCars.find(c => c.slot === 0);
  const speedSessionId = targetSessionId || baseSelected?.sessionId;
  const baseSession = sessions.find(s => s.id === speedSessionId) || sessions[0];
  const baseLap = targetLap || baseSession?.laps.find(l => l.lapNumber === baseSelected?.lapNumber) || baseSession?.laps[0];

  const activeTrack = tracks.find(t => t.id === selectedTrackId);
  const subTrack = tracks.find(t => t.id === subTrackId);

  // 現在選択中の動画トラックが属するチャプターグループ
  const currentGroup = selectedTrackId ? videoSyncManager.getChapterGroupForTrack(selectedTrackId) : null;

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

  useEffect(() => {
    videoSyncManager.onTracksUpdated = updated => {
      setTracks([...updated]);
      if (!selectedTrackId && updated.length > 0) {
        setSelectedTrackId(updated[0].id);
      }
      if (updated.length > 1 && !subTrackId) {
        setSubTrackId(updated[1].id);
      }
    };
  }, [selectedTrackId, subTrackId]);

  // 速度ウィンドウのセッション (Car 1) に対応する動画トラックを自動選択
  useEffect(() => {
    if (!baseSession || tracks.length === 0) return;
    const matchingTrack = tracks.find(t => t.matchedSessionId === baseSession.id);
    if (matchingTrack && matchingTrack.id !== selectedTrackId) {
      setSelectedTrackId(matchingTrack.id);
    }
  }, [baseSession?.id, tracks]);

  // 速度ウィンドウで選択されたセッションに合わせて動画のオフセットを自動追従・再同期
  useEffect(() => {
    if (!activeTrack || !baseSession) return;
    if (activeTrack.matchedSessionId !== baseSession.id) {
      videoSyncManager.resyncTrack(
        activeTrack.id,
        sessions,
        activeTrack.videoTimezone || 'JST',
        activeTrack.gpsTimezone || 'JST',
        baseSession.id
      );
    }
  }, [baseSession?.id, activeTrack?.id]);

  // GPS タイムライン変化に合わせてメイン動画・サブ動画の再生位置 & チャプター自動切り替えを追従
  useEffect(() => {
    if (!activeTrack) return;
    const effectiveSessionTime = isGraphEmbedded && baseLap
      ? (baseLap.startTime + currentTimeSec)
      : currentTimeSec;

    // 1. メイン動画 (チャプターグループ対応)
    if (currentGroup && currentGroup.tracks.length > 1) {
      const resolution = resolveChapterPlayback(currentGroup, effectiveSessionTime);
      if (resolution) {
        if (resolution.activeTrack.track.id !== selectedTrackId) {
          setSelectedTrackId(resolution.activeTrack.track.id);
          if (videoRef.current) {
            videoRef.current.currentTime = resolution.localVideoTimeSec;
            if (isPlaying) videoRef.current.play().catch(console.warn);
          }
        } else {
          if (videoRef.current && Math.abs(videoRef.current.currentTime - resolution.localVideoTimeSec) > 0.15) {
            videoRef.current.currentTime = resolution.localVideoTimeSec;
          }
        }
      }
    } else if (videoRef.current) {
      const targetVideoTime = effectiveSessionTime - activeTrack.syncOffsetSec;
      if (targetVideoTime >= 0 && targetVideoTime <= (activeTrack.durationSec || 9999)) {
        if (Math.abs(videoRef.current.currentTime - targetVideoTime) > 0.15) {
          videoRef.current.currentTime = targetVideoTime;
        }
      }
    }

    // 2. サブ動画 (2画面 / PinP 時)
    if (subVideoRef.current && subTrack && viewMode !== 'single') {
      const targetSubTime = effectiveSessionTime - subTrack.syncOffsetSec;
      if (targetSubTime >= 0 && targetSubTime <= (subTrack.durationSec || 9999)) {
        if (Math.abs(subVideoRef.current.currentTime - targetSubTime) > 0.15) {
          subVideoRef.current.currentTime = targetSubTime;
        }
      }
    }
  }, [currentTimeSec, activeTrack?.id, subTrack?.id, currentGroup, isGraphEmbedded, baseLap, isPlaying, viewMode]);

  // 再生/一時停止同期 (メイン & サブ両方に適用)
  useEffect(() => {
    const v1 = videoRef.current;
    const v2 = subVideoRef.current;

    if (isPlaying) {
      if (v1 && v1.paused) v1.play().catch(console.warn);
      if (v2 && v2.paused && viewMode !== 'single') v2.play().catch(console.warn);
    } else {
      if (v1 && !v1.paused) v1.pause();
      if (v2 && !v2.paused) v2.pause();
    }
  }, [isPlaying, viewMode]);

  // 再生速度同期
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackSpeed;
    if (subVideoRef.current) subVideoRef.current.playbackRate = playbackSpeed;
  }, [playbackSpeed]);

  // 動画側の再生時間更新イベント -> 速度ウィンドウ・GPS タイムラインへ同期伝達
  const handleTimeUpdate = () => {
    if (!videoRef.current || !activeTrack || !isPlaying) return;
    const vTime = videoRef.current.currentTime;
    const sessionTime = vTime + activeTrack.syncOffsetSec;

    if (isGraphEmbedded && baseLap) {
      const lapTime = Math.max(0, sessionTime - baseLap.startTime);
      onSeekTime(lapTime);
    } else {
      onSeekTime(Math.max(0, sessionTime));
    }
  };

  // ワンクリック同期: 現在の動画フレームを GPS の現在選択タイムに合わせる
  const handleSyncCurrentFrame = () => {
    if (!videoRef.current || !activeTrack) return;
    const currentVideoTime = videoRef.current.currentTime;
    const effectiveSessionTime = isGraphEmbedded && baseLap
      ? (baseLap.startTime + currentTimeSec)
      : currentTimeSec;
    const newOffset = effectiveSessionTime - currentVideoTime;
    videoSyncManager.updateOffset(activeTrack.id, newOffset);
  };

  // 微調整 (+/- 0.05秒: 1フレーム単位)
  const handleNudgeOffset = (deltaSec: number, targetId: string = activeTrack?.id || '') => {
    const track = tracks.find(t => t.id === targetId);
    if (!track) return;
    videoSyncManager.updateOffset(track.id, track.syncOffsetSec + deltaSec);
  };

  // 手動キーフレーム同期 (ピン作成)
  const handleAddPin = () => {
    if (!videoRef.current || !activeTrack) return;
    const effectiveSessionTime = isGraphEmbedded && baseLap
      ? (baseLap.startTime + currentTimeSec)
      : currentTimeSec;
    const currentVideoTime = videoRef.current.currentTime;
    
    const pin = createSyncPin(
      newPinName || `ピン ${pins.length + 1}`,
      effectiveSessionTime,
      currentVideoTime,
      activeTrack.id
    );

    // ピンを適用してオフセットを更新
    applyPinToTrack(pin, (id, newOffset) => {
      videoSyncManager.updateOffset(id, newOffset);
    });

    const updated = [...pins, pin];
    setPins(updated);
    savePinsToStorage(circuitName || 'default', updated);
    setNewPinName('');
    setShowPinModal(false);
  };

  // ピン位置へジャンプ (シーク)
  const handleJumpToPin = (pin: SyncPin) => {
    if (isGraphEmbedded && baseLap) {
      onSeekTime(Math.max(0, pin.sessionTimeSec - baseLap.startTime));
    } else {
      onSeekTime(pin.sessionTimeSec);
    }
  };

  // ピン削除
  const handleDeletePin = (pinId: string) => {
    const updated = pins.filter(p => p.id !== pinId);
    setPins(updated);
    savePinsToStorage(circuitName || 'default', updated);
  };

  // メインカメラとサブカメラの入れ替え (Swap)
  const handleSwapCameras = () => {
    if (!selectedTrackId || !subTrackId) return;
    const temp = selectedTrackId;
    setSelectedTrackId(subTrackId);
    setSubTrackId(temp);
  };

  // テレメトリ動画エクスポート開始
  const handleStartExport = () => {
    if (!videoRef.current || !activeTrack) return;

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
    setShowExportModal(false);

    const controller = exportBurnedInVideo({
      videoElement: videoRef.current,
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

    controller.promise
      .then(() => {
        setIsExporting(false);
        setExportProgress(null);
      })
      .catch((err) => {
        console.warn('Export finished or cancelled:', err);
        setIsExporting(false);
        setExportProgress(null);
      });
  };

  // 動画ファイル一括処理
  const processFiles = async (fileList: FileList | File[]) => {
    const updated = await videoSyncManager.addVideoFiles(fileList, sessions);
    if (updated.length > 0 && !selectedTrackId) {
      setSelectedTrackId(updated[0].id);
    }
    if (updated.length > 1 && !subTrackId) {
      setSubTrackId(updated[1].id);
    }
  };

  const handleAddVideos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await processFiles(files);
    e.target.value = '';
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
    const jsonStr = videoSyncManager.exportProjectJson(sessions, circuitName);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${circuitName || 'telemetry'}_sync_project.dssync.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportProject = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const text = ev.target?.result as string;
        videoSyncManager.importProjectJson(text);
      } catch (err: any) {
        alert('プロジェクト復元エラー: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // リアルタイム・テレメトリオーバーレイ描画 (Canvas)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !showOverlay) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const effectiveTime = isGraphEmbedded && baseLap
      ? (baseLap.startTime + currentTimeSec)
      : currentTimeSec;

    drawTelemetryOverlayOnCanvas(ctx, canvas.width, canvas.height, effectiveTime, baseSession, baseLap, showGForce);
  }, [currentTimeSec, baseLap, baseSession, showOverlay, showGForce, isGraphEmbedded]);

  // PinP 位置クラス
  const getPipPosClass = (pos: PipPosition) => {
    switch (pos) {
      case 'bottom-right': return 'bottom-4 right-4';
      case 'bottom-left': return 'bottom-4 left-4';
      case 'top-right': return 'top-4 right-4';
      case 'top-left': return 'top-4 left-4';
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0d14] text-slate-200 select-none overflow-hidden font-sans">
      {/* 1. 上部コントロールバー (フラットデザイン) */}
      <div className="h-11 bg-[#121622] border-b border-[#22293a] px-3 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-bold text-slate-100 flex items-center gap-1.5 shrink-0">
            <Video size={15} className="text-red-500" />
            車載動画同期
          </span>

          {/* 速度ウィンドウ連携バッジ (フラット) */}
          {baseSession && (
            <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/80 border border-emerald-800 px-2 py-0.5 rounded flex items-center gap-1 shrink-0" title="速度ウィンドウ同期中">
              <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
              <span className="max-w-[120px] truncate font-bold">{baseSession.sessionName}</span>
              {baseLap && <span className="text-emerald-300 font-bold">L{baseLap.lapNumber}</span>}
            </span>
          )}

          {/* メイン動画トラック選択 */}
          {tracks.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400 font-medium">Main:</span>
              <select
                value={selectedTrackId || ''}
                onChange={e => setSelectedTrackId(e.target.value)}
                className="bg-[#182030] border border-[#2d3852] text-xs text-slate-200 rounded px-2 py-1 outline-none max-w-[160px] truncate cursor-pointer"
              >
                {tracks.map(t => {
                  const grp = videoSyncManager.getChapterGroupForTrack(t.id);
                  const cTrack = grp?.tracks.find(ct => ct.track.id === t.id);
                  const chapterLabel = cTrack && grp && grp.tracks.length > 1
                    ? `[Ch ${cTrack.chapterIndex}/${grp.tracks.length}] `
                    : '';
                  return (
                    <option key={t.id} value={t.id}>
                      {chapterLabel}{t.fileName}
                    </option>
                  );
                })}
              </select>
              {selectedTrackId && (
                <button
                  onClick={() => {
                    videoSyncManager.removeTrack(selectedTrackId);
                    const remaining = videoSyncManager.getTracks();
                    setSelectedTrackId(remaining[0]?.id || null);
                  }}
                  title="動画トラック削除"
                  className="p-1 hover:bg-red-950/60 text-slate-400 hover:text-red-400 rounded transition-colors cursor-pointer"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}

          {/* 2カメラ / PinP モード切替 & サブ動画選択 */}
          {tracks.length > 1 && (
            <div className="flex items-center gap-1 pl-2 border-l border-[#242c3f]">
              <span className="text-[10px] text-slate-400 font-medium">Sub:</span>
              <select
                value={subTrackId || ''}
                onChange={e => setSubTrackId(e.target.value)}
                className="bg-[#182030] border border-[#2d3852] text-xs text-slate-200 rounded px-2 py-1 outline-none max-w-[130px] truncate cursor-pointer"
              >
                {tracks.filter(t => t.id !== selectedTrackId).map(t => (
                  <option key={t.id} value={t.id}>
                    {t.fileName}
                  </option>
                ))}
              </select>

              {/* ビューモードトグル (Single / Split / PinP) */}
              <div className="flex items-center rounded border border-[#2d3852] bg-[#182030] overflow-hidden ml-1">
                <button
                  onClick={() => setViewMode('single')}
                  className={`px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer ${
                    viewMode === 'single' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="単一カメラ表示"
                >
                  単一
                </button>
                <button
                  onClick={() => setViewMode('split')}
                  className={`px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer flex items-center gap-1 ${
                    viewMode === 'split' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="左右2画面並列表示 (1:1)"
                >
                  <Columns size={11} />
                  2画面
                </button>
                <button
                  onClick={() => setViewMode('pip')}
                  className={`px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer flex items-center gap-1 ${
                    viewMode === 'pip' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="ピクチャー・イン・ピクチャー (PinP)"
                >
                  <PictureInPicture size={11} />
                  PinP
                </button>
              </div>

              {/* メイン/サブ入替ボタン */}
              <button
                onClick={handleSwapCameras}
                className="p-1 rounded bg-[#182030] hover:bg-[#222c42] border border-[#2d3852] text-slate-300 transition-colors cursor-pointer"
                title="メインカメラとサブカメラを瞬時に入れ替え"
              >
                <ArrowLeftRight size={12} />
              </button>
            </div>
          )}

          {/* 動画追加ボタン */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[#1b2233] hover:bg-[#242f47] text-xs text-slate-300 border border-[#2d3852] transition-colors cursor-pointer"
          >
            <Plus size={12} />
            動画追加
          </button>
        </div>

        {/* 右側アクション群 (ピン留め・MP4エクスポート・プロジェクト保存) */}
        <div className="flex items-center gap-1.5">
          {/* 手動キーフレーム同期 (ピン留め) ボタン */}
          {activeTrack && (
            <button
              onClick={() => setShowPinModal(true)}
              className="flex items-center gap-1 px-2 py-1 rounded bg-[#182030] hover:bg-[#232c42] text-xs text-amber-300 border border-amber-500/40 transition-colors cursor-pointer"
              title="現在の動画フレームとGPS時刻を同期ピンとして固定"
            >
              <MapPin size={12} className="text-amber-400" />
              ピン留め同期 ({pins.length})
            </button>
          )}

          {/* テレメトリ動画書き出し (MP4 Burn-in) ボタン */}
          {activeTrack && (
            <button
              onClick={() => setShowExportModal(true)}
              className="flex items-center gap-1 px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-xs font-bold text-white transition-colors cursor-pointer"
              title="メーターオーバーレイ付きの動画をMP4形式で書き出し"
            >
              <Download size={12} />
              動画書き出し
            </button>
          )}

          {/* 同期プロジェクト保存 / 読込 */}
          <button
            onClick={handleExportProject}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[#182030] hover:bg-[#222c42] text-xs text-slate-300 border border-[#2d3852] transition-colors cursor-pointer"
            title="同期プロジェクト保存 (.dssync.json)"
          >
            <Save size={12} />
          </button>
          <button
            onClick={() => jsonInputRef.current?.click()}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[#182030] hover:bg-[#222c42] text-xs text-slate-300 border border-[#2d3852] transition-colors cursor-pointer"
            title="プロジェクト読込 (.dssync.json)"
          >
            <FolderOpen size={12} />
          </button>

          {/* オーバーレイON/OFF */}
          <button
            onClick={() => setShowOverlay(!showOverlay)}
            className={`p-1 rounded border transition-colors cursor-pointer ${
              showOverlay ? 'bg-red-600/20 text-red-400 border-red-500/50' : 'bg-slate-800 text-slate-500 border-slate-700'
            }`}
            title="テレメトリ計器表示切替"
          >
            {showOverlay ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        </div>
      </div>

      {/* 2. タイムゾーン設定 & 再同期専用バー (フラットデザイン) */}
      {activeTrack && (
        <div className="bg-[#141824] border-b border-[#22293a] px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0 select-none">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* 動画タイムゾーン選択 */}
            <div className="flex items-center gap-1 bg-[#1a2030] px-2 py-0.5 rounded border border-[#2d3852]">
              <span className="text-slate-400 text-[10px] font-medium">動画TZ:</span>
              <select
                value={activeTrack.videoTimezone || 'JST'}
                onChange={e => videoSyncManager.resyncTrack(activeTrack.id, sessions, e.target.value, undefined, baseSession?.id)}
                className="bg-transparent text-slate-100 font-bold text-xs outline-none cursor-pointer"
              >
                {TIMEZONE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value} className="bg-[#182030] text-slate-200">
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* GPSタイムゾーン選択 */}
            <div className="flex items-center gap-1 bg-[#1a2030] px-2 py-0.5 rounded border border-[#2d3852]">
              <span className="text-slate-400 text-[10px] font-medium">GPS TZ:</span>
              <select
                value={activeTrack.gpsTimezone || 'JST'}
                onChange={e => videoSyncManager.resyncTrack(activeTrack.id, sessions, undefined, e.target.value, baseSession?.id)}
                className="bg-transparent text-slate-100 font-bold text-xs outline-none cursor-pointer"
              >
                {TIMEZONE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value} className="bg-[#182030] text-slate-200">
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 再同期ボタン */}
            <button
              onClick={() => videoSyncManager.resyncTrack(activeTrack.id, sessions, activeTrack.videoTimezone, activeTrack.gpsTimezone, baseSession?.id)}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-bold text-[11px] transition-colors cursor-pointer"
              title="タイムゾーンに基づきオフセット再計算"
            >
              <RefreshCw size={11} />
              再同期
            </button>
          </div>

          {/* 時刻診断 & 時差ズレ即時補正 */}
          <div className="flex items-center gap-2 text-[11px]">
            {isLargeOffset && (
              <div className="flex items-center gap-1.5 bg-amber-950/80 border border-amber-600 text-amber-300 px-2 py-0.5 rounded">
                <AlertTriangle size={12} className="text-amber-400 shrink-0" />
                <span>約{Math.round(Math.abs(activeTrack.syncOffsetSec) / 3600)}hズレ</span>
                <button
                  onClick={() => videoSyncManager.shiftOffsetHours(activeTrack.id, activeTrack.syncOffsetSec > 0 ? -9 : 9)}
                  className="px-1.5 py-0.2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded text-[10px] cursor-pointer"
                  title="9時間時差を打ち消し"
                >
                  ±9h補正
                </button>
              </div>
            )}

            <div className="hidden lg:flex items-center gap-2 bg-[#121622] px-2.5 py-0.5 rounded border border-[#232b3d] text-slate-400 font-mono text-[11px]">
              <span>動画: <strong className="text-slate-200">{formatTzDate(activeTrack.rawRecordedAt, activeTrack.videoTimezone || 'JST')}</strong></span>
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
        className={`flex-1 relative bg-black flex overflow-hidden ${
          isDragging ? 'border-2 border-dashed border-red-500 bg-red-950/20' : ''
        }`}
      >
        {/* ドラッグ中オーバーレイ */}
        {isDragging && (
          <div className="absolute inset-0 bg-red-950/80 flex flex-col items-center justify-center z-40 pointer-events-none space-y-1">
            <Video size={40} className="text-red-400 animate-bounce" />
            <p className="text-sm font-bold text-white">ここに動画ファイル（.mp4, .mov）をドロップ</p>
          </div>
        )}

        {activeTrack && activeTrack.objectUrl ? (
          <>
            {/* ビューポート: Single モード */}
            {viewMode === 'single' && (
              <div className="w-full h-full relative flex items-center justify-center bg-black">
                <video
                  ref={videoRef}
                  src={activeTrack.objectUrl}
                  onTimeUpdate={handleTimeUpdate}
                  onEnded={() => {
                    if (currentGroup && currentGroup.tracks.length > 1) {
                      const nextChapter = getNextChapter(currentGroup, activeTrack.id);
                      if (nextChapter) {
                        setSelectedTrackId(nextChapter.track.id);
                        setTimeout(() => {
                          if (videoRef.current) {
                            videoRef.current.currentTime = 0;
                            if (isPlaying) videoRef.current.play().catch(console.warn);
                          }
                        }, 50);
                        return;
                      }
                    }
                    if (isPlaying) onTogglePlay();
                  }}
                  playsInline
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            )}

            {/* ビューポート: Split (左右2画面 1:1) モード */}
            {viewMode === 'split' && (
              <div className="w-full h-full flex flex-row overflow-hidden relative">
                {/* 左側: メイン動画 */}
                <div className="flex-1 relative flex items-center justify-center bg-black border-r border-[#22293a]">
                  <span className="absolute top-2 left-2 z-10 text-[10px] font-mono font-bold bg-black/70 border border-slate-700 px-1.5 py-0.5 rounded text-red-400">
                    Main: {activeTrack.fileName}
                  </span>
                  <video
                    ref={videoRef}
                    src={activeTrack.objectUrl}
                    onTimeUpdate={handleTimeUpdate}
                    playsInline
                    className="max-h-full max-w-full object-contain"
                  />
                </div>

                {/* 右側: サブ動画 */}
                <div className="flex-1 relative flex items-center justify-center bg-black">
                  <span className="absolute top-2 left-2 z-10 text-[10px] font-mono font-bold bg-black/70 border border-slate-700 px-1.5 py-0.5 rounded text-blue-400 flex items-center gap-1">
                    Sub: {subTrack?.fileName || '未選択'}
                    <button
                      onClick={() => setIsSubMuted(!isSubMuted)}
                      className="ml-1 text-slate-400 hover:text-slate-200 cursor-pointer"
                      title={isSubMuted ? 'サブ音声ミュート解除' : 'サブ音声をミュート'}
                    >
                      {isSubMuted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                    </button>
                  </span>
                  {subTrack && subTrack.objectUrl ? (
                    <video
                      ref={subVideoRef}
                      src={subTrack.objectUrl}
                      muted={isSubMuted}
                      playsInline
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <div className="text-slate-500 text-xs text-center p-4">
                      上部バーでサブ動画トラックを選択してください
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ビューポート: PinP (ピクチャー・イン・ピクチャー) モード */}
            {viewMode === 'pip' && (
              <div className="w-full h-full relative flex items-center justify-center bg-black">
                {/* メイン動画 */}
                <video
                  ref={videoRef}
                  src={activeTrack.objectUrl}
                  onTimeUpdate={handleTimeUpdate}
                  playsInline
                  className="max-h-full max-w-full object-contain"
                />

                {/* フローティング サブ動画 (PinP) */}
                {subTrack && subTrack.objectUrl && (
                  <div className={`absolute z-20 w-1/4 min-w-[220px] max-w-[340px] aspect-video border border-blue-500/80 bg-black rounded overflow-hidden ${getPipPosClass(pipPosition)}`}>
                    <video
                      ref={subVideoRef}
                      src={subTrack.objectUrl}
                      muted={isSubMuted}
                      playsInline
                      className="w-full h-full object-contain"
                    />
                    {/* PinP コントロールバー */}
                    <div className="absolute top-1 left-1 right-1 flex items-center justify-between pointer-events-auto bg-black/70 px-1.5 py-0.5 rounded text-[9px] font-mono text-slate-200">
                      <span className="truncate max-w-[120px] text-blue-400 font-bold">{subTrack.fileName}</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={handleSwapCameras}
                          className="hover:text-amber-300 cursor-pointer"
                          title="メインと入れ替え"
                        >
                          <ArrowLeftRight size={10} />
                        </button>
                        <button
                          onClick={() => {
                            const nextPos: PipPosition = 
                              pipPosition === 'bottom-right' ? 'bottom-left' :
                              pipPosition === 'bottom-left' ? 'top-left' :
                              pipPosition === 'top-left' ? 'top-right' : 'bottom-right';
                            setPipPosition(nextPos);
                          }}
                          className="hover:text-blue-300 cursor-pointer"
                          title="PinPの四隅表示位置を切り替え"
                        >
                          <Maximize2 size={10} />
                        </button>
                        <button
                          onClick={() => setIsSubMuted(!isSubMuted)}
                          className="hover:text-slate-100 cursor-pointer"
                        >
                          {isSubMuted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* テレメトリオーバーレイ Canvas */}
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              className={`absolute inset-0 w-full h-full object-contain pointer-events-none z-15 ${
                showOverlay ? 'opacity-100' : 'opacity-0'
              } transition-opacity duration-150`}
            />

            {/* 録画開始前インジケーター */}
            {currentTimeSec < activeTrack.syncOffsetSec && (
              <div className="absolute top-3 bg-amber-950/90 border border-amber-600 text-amber-200 px-3 py-1.5 rounded flex items-center gap-2 text-xs font-medium z-20">
                <Clock size={14} className="text-amber-400 animate-pulse shrink-0" />
                <span>動画開始まであと <strong className="font-mono text-amber-300">{(activeTrack.syncOffsetSec - currentTimeSec).toFixed(1)}s</strong></span>
                <button
                  onClick={() => onSeekTime(activeTrack.syncOffsetSec)}
                  className="px-1.5 py-0.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded text-[10px] cursor-pointer ml-1"
                >
                  開始点へジャンプ
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center w-full h-full p-8 text-center space-y-3">
            <div className="p-4 rounded bg-[#151a28] text-slate-400 border border-[#252f46]">
              <Video size={40} className="text-red-500" />
            </div>
            <h3 className="text-sm font-bold text-slate-200">車載動画（オンボード映像）を読み込む</h3>
            <p className="text-xs text-slate-400 max-w-sm leading-relaxed">
              GoPro（H.265 / HEVC 4GBチャプター分割対応）や複数カメラの MP4 / MOV 動画をここにドラッグ＆ドロップしてください。
            </p>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-bold text-xs transition-colors cursor-pointer"
              >
                <Upload size={13} />
                動画ファイルを選択
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 4. チャプター分割動画 (GoPro/DJI) ナビゲーションバー */}
      {currentGroup && currentGroup.tracks.length > 1 && (
        <div className="bg-[#121622] border-t border-[#1e2638] px-3 py-1 flex flex-wrap items-center justify-between gap-2 shrink-0 select-none text-xs">
          <div className="flex items-center gap-1.5">
            <span className="flex items-center gap-1 text-[11px] font-bold text-slate-200">
              <Layers size={12} className="text-red-400 shrink-0" />
              {currentGroup.brand === 'gopro' ? 'GoPro' : currentGroup.brand.toUpperCase()} {currentGroup.sessionId}
              <span className="text-slate-400 font-normal">({currentGroup.tracks.length}チャプター連動, 計 {formatDuration(currentGroup.totalDurationSec)})</span>
            </span>

            <button
              onClick={() => {
                const prev = getPreviousChapter(currentGroup, activeTrack?.id || '');
                if (prev) {
                  setSelectedTrackId(prev.track.id);
                  const newSessionTime = prev.track.syncOffsetSec;
                  if (isGraphEmbedded && baseLap) {
                    onSeekTime(Math.max(0, newSessionTime - baseLap.startTime));
                  } else {
                    onSeekTime(newSessionTime);
                  }
                }
              }}
              disabled={!getPreviousChapter(currentGroup, activeTrack?.id || '')}
              className="p-1 rounded bg-[#182030] hover:bg-[#222c42] disabled:opacity-30 text-slate-300 transition-colors cursor-pointer"
              title="前のチャプターへ"
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
                      setSelectedTrackId(ct.track.id);
                      const targetSessionTime = ct.track.syncOffsetSec;
                      if (isGraphEmbedded && baseLap) {
                        onSeekTime(Math.max(0, targetSessionTime - baseLap.startTime));
                      } else {
                        onSeekTime(targetSessionTime);
                      }
                    }}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                      isCurrent
                        ? 'bg-red-600 text-white font-bold'
                        : 'bg-[#1a2030] text-slate-400 hover:text-slate-200 border border-[#263147]'
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
                  setSelectedTrackId(next.track.id);
                  const targetSessionTime = next.track.syncOffsetSec;
                  if (isGraphEmbedded && baseLap) {
                    onSeekTime(Math.max(0, targetSessionTime - baseLap.startTime));
                  } else {
                    onSeekTime(targetSessionTime);
                  }
                }
              }}
              disabled={!getNextChapter(currentGroup, activeTrack?.id || '')}
              className="p-1 rounded bg-[#182030] hover:bg-[#222c42] disabled:opacity-30 text-slate-300 transition-colors cursor-pointer"
              title="次のチャプターへ"
            >
              <ChevronRight size={12} />
            </button>
          </div>

          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/70 border border-emerald-800/80 px-1.5 py-0.2 rounded">
            シームレス連続再生: 有効
          </span>
        </div>
      )}

      {/* 5. マスタータイムライン マルチトラックインスペクター (NLE風) */}
      {(() => {
        const effectiveSessionTime = isGraphEmbedded && baseLap ? (baseLap.startTime + currentTimeSec) : currentTimeSec;
        return (
          <MasterTimelineTrackBar
            session={baseSession}
            baseLap={baseLap}
            activeTrack={activeTrack}
            subTrack={subTrack}
            chapterGroup={currentGroup}
            pins={pins}
            currentSessionTimeSec={effectiveSessionTime}
            onSeekSessionTime={(targetSessionTime) => {
              if (isGraphEmbedded && baseLap) {
                onSeekTime(Math.max(0, targetSessionTime - baseLap.startTime));
              } else {
                onSeekTime(targetSessionTime);
              }
            }}
            formatDuration={formatDuration}
          />
        );
      })()}

      {/* 6. 速度ウィンドウ完全同期 シークバー (Lap/Session切替対応) */}
      {(() => {
        const effectiveSessionTime = isGraphEmbedded && baseLap ? (baseLap.startTime + currentTimeSec) : currentTimeSec;
        const isLapMode = seekbarScope === 'lap' && baseLap;
        
        let sessionMax = 60;
        if (baseSession && baseSession.points.length > 0) {
          sessionMax = baseSession.points[baseSession.points.length - 1].time;
        } else if (activeTrack) {
          sessionMax = activeTrack.syncOffsetSec + (activeTrack.durationSec || 60);
        }

        const maxVal = isLapMode ? (baseLap.lapTime || 60) : sessionMax;
        const curVal = isLapMode ? currentTimeSec : effectiveSessionTime;

        return (
          <div className="bg-[#10141f] border-t border-[#1d2333] px-3 py-1 flex items-center justify-between gap-2.5 shrink-0 select-none">
            {/* スコープ切替スイッチ (Lap / Session) */}
            {baseLap && (
              <div className="flex items-center rounded border border-[#263147] bg-[#161a26] text-[10px] overflow-hidden shrink-0">
                <button
                  onClick={() => setSeekbarScope('lap')}
                  className={`px-2 py-0.5 font-bold transition-colors cursor-pointer ${
                    isLapMode ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="速度ウィンドウで選択中のラップ時間 (0〜lapTime) に同期"
                >
                  L{baseLap.lapNumber}
                </button>
                <button
                  onClick={() => setSeekbarScope('session')}
                  className={`px-2 py-0.5 font-bold transition-colors cursor-pointer ${
                    !isLapMode ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="セッション全体の絶対時間に同期"
                >
                  全体
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
                  onSeekTime(val);
                } else {
                  if (isGraphEmbedded && baseLap) {
                    onSeekTime(Math.max(0, val - baseLap.startTime));
                  } else {
                    onSeekTime(val);
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

      {/* 6. 下部同期調整 ＆ 再生コントロールバー (フラットデザイン) */}
      <div className="h-12 bg-[#121622] border-t border-[#22293a] px-3 flex items-center justify-between gap-3 shrink-0">
        {/* 再生ボタン群 */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onSeekTime(Math.max(0, currentTimeSec - 1.0))}
            className="p-1.5 rounded bg-[#182030] hover:bg-[#222c42] border border-[#28334a] text-slate-300 transition-colors cursor-pointer"
            title="1秒戻る"
          >
            <SkipBack size={14} />
          </button>
          <button
            onClick={onTogglePlay}
            className="p-2 rounded bg-red-600 hover:bg-red-500 text-white font-bold transition-colors cursor-pointer"
            title={isPlaying ? '一時停止' : '再生'}
          >
            {isPlaying ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button
            onClick={() => onSeekTime(currentTimeSec + 1.0)}
            className="p-1.5 rounded bg-[#182030] hover:bg-[#222c42] border border-[#28334a] text-slate-300 transition-colors cursor-pointer"
            title="1秒進む"
          >
            <SkipForward size={14} />
          </button>

          {/* 再生速度 */}
          <select
            value={playbackSpeed}
            onChange={e => setPlaybackSpeed(parseFloat(e.target.value))}
            className="bg-[#182030] border border-[#2d3852] text-[11px] font-mono text-slate-300 rounded px-1.5 py-0.5 outline-none ml-1.5 cursor-pointer"
          >
            <option value="0.25">0.25x</option>
            <option value="0.5">0.5x</option>
            <option value="1.0">1.0x</option>
            <option value="1.5">1.5x</option>
            <option value="2.0">2.0x</option>
          </select>
        </div>

        {/* 同期オフセット微調整 & ピン選択 */}
        {activeTrack && (
          <div className="flex flex-wrap items-center gap-2 text-xs bg-[#182030] px-3 py-1 rounded border border-[#273248]">
            {/* 登録済みピンのクイックジャンプドロップダウン */}
            {pins.length > 0 && (
              <div className="flex items-center gap-1 border-r border-[#2d3850] pr-2">
                <MapPin size={12} className="text-amber-400 shrink-0" />
                <select
                  onChange={e => {
                    const pin = pins.find(p => p.id === e.target.value);
                    if (pin) handleJumpToPin(pin);
                  }}
                  className="bg-transparent text-amber-300 font-bold text-[11px] outline-none cursor-pointer max-w-[110px] truncate"
                  defaultValue=""
                >
                  <option value="" disabled className="bg-[#182030] text-slate-400">ピン一覧 ({pins.length})</option>
                  {pins.map(p => (
                    <option key={p.id} value={p.id} className="bg-[#182030] text-slate-200">
                      {p.name} ({formatPinTime(p.sessionTimeSec)})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <span className="text-slate-400 flex items-center gap-1 text-[11px]">
              <Sliders size={12} className="text-amber-400" />
              オフセット:
              <input
                type="number"
                step="0.05"
                value={activeTrack.syncOffsetSec}
                onChange={e => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) videoSyncManager.updateOffset(activeTrack.id, val);
                }}
                className="w-20 bg-[#111520] border border-[#2d3850] text-amber-400 font-mono font-bold px-1 py-0.5 rounded text-right outline-none focus:border-amber-400"
              />
              s
            </span>

            {/* 微調整ボタン群 */}
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => handleNudgeOffset(-1.0)}
                className="px-1.5 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[10px] font-mono text-slate-300 cursor-pointer"
              >
                -1s
              </button>
              <button
                onClick={() => handleNudgeOffset(-0.05)}
                className="px-1.5 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[10px] font-mono text-slate-200 cursor-pointer"
              >
                -0.05s
              </button>
              <button
                onClick={() => handleNudgeOffset(0.05)}
                className="px-1.5 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[10px] font-mono text-slate-200 cursor-pointer"
              >
                +0.05s
              </button>
              <button
                onClick={() => handleNudgeOffset(1.0)}
                className="px-1.5 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[10px] font-mono text-slate-300 cursor-pointer"
              >
                +1s
              </button>
            </div>

            <button
              onClick={handleSyncCurrentFrame}
              className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-[11px] font-bold text-white transition-colors cursor-pointer ml-1"
              title="現在フレームでGPSと同期"
            >
              現フレームで同期
            </button>
          </div>
        )}
      </div>

      {/* 7. 手動キーフレーム同期 (ピン留め) モーダル */}
      {showPinModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-[#161c2b] border border-[#2b3752] rounded p-4 w-full max-w-sm text-slate-200 space-y-3 font-sans">
            <div className="flex items-center justify-between border-b border-[#2b3752] pb-2">
              <span className="text-sm font-bold flex items-center gap-1.5 text-amber-400">
                <MapPin size={15} />
                キーフレーム同期ピンの追加
              </span>
              <button
                onClick={() => setShowPinModal(false)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              現在の一時停止位置（GPS時刻と動画フレーム）をキーフレームとしてピン留めし、オフセットを固定します。
            </p>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-300">ピン名 (地点名):</label>
              <input
                type="text"
                placeholder="例: 1コーナーAPEX, コントロールライン"
                value={newPinName}
                onChange={e => setNewPinName(e.target.value)}
                className="w-full bg-[#101420] border border-[#2b3752] text-xs px-2.5 py-1.5 rounded outline-none focus:border-amber-400 text-slate-100"
                autoFocus
              />
            </div>

            {/* 登録済みピン一覧 */}
            {pins.length > 0 && (
              <div className="space-y-1 pt-1">
                <span className="text-[10px] font-medium text-slate-400">登録済みピン ({pins.length}件):</span>
                <div className="max-h-28 overflow-y-auto space-y-1 bg-[#101420] p-1.5 rounded border border-[#222a3d]">
                  {pins.map(p => (
                    <div key={p.id} className="flex items-center justify-between text-[11px] text-slate-300 py-0.5 px-1 hover:bg-[#1a2030] rounded">
                      <span className="truncate max-w-[180px] font-medium text-amber-300">{p.name}</span>
                      <div className="flex items-center gap-1.5 font-mono text-[10px] text-slate-400">
                        <span>{formatPinTime(p.sessionTimeSec)}</span>
                        <button
                          onClick={() => handleDeletePin(p.id)}
                          className="hover:text-red-400 text-slate-500 cursor-pointer"
                          title="削除"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#2b3752]">
              <button
                onClick={() => setShowPinModal(false)}
                className="px-3 py-1 rounded bg-[#20273a] hover:bg-[#2b354e] text-xs text-slate-300 cursor-pointer"
              >
                閉じる
              </button>
              <button
                onClick={handleAddPin}
                className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs transition-colors cursor-pointer"
              >
                現在位置でピン留め
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. テレメトリ動画焼き込みエクスポート設定モーダル */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-[#161c2b] border border-[#2b3752] rounded p-4 w-full max-w-sm text-slate-200 space-y-3 font-sans">
            <div className="flex items-center justify-between border-b border-[#2b3752] pb-2">
              <span className="text-sm font-bold flex items-center gap-1.5 text-red-400">
                <Download size={15} />
                テレメトリ動画書き出し設定
              </span>
              <button
                onClick={() => setShowExportModal(false)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              車載動画にメーター（速度・Gフォース・ラップタイム）を合成し、MP4動画としてエクスポートします。
            </p>

            {/* 書き出し範囲選択 */}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-300">書き出し範囲:</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setExportRange('lap')}
                  className={`px-2 py-1.5 rounded border text-xs font-bold transition-colors cursor-pointer ${
                    exportRange === 'lap'
                      ? 'bg-red-600 text-white border-red-500'
                      : 'bg-[#101420] text-slate-400 border-[#2b3752] hover:text-slate-200'
                  }`}
                >
                  {baseLap ? `Lap ${baseLap.lapNumber} (ラップ区間)` : '選択ラップ'}
                </button>
                <button
                  onClick={() => setExportRange('all')}
                  className={`px-2 py-1.5 rounded border text-xs font-bold transition-colors cursor-pointer ${
                    exportRange === 'all'
                      ? 'bg-red-600 text-white border-red-500'
                      : 'bg-[#101420] text-slate-400 border-[#2b3752] hover:text-slate-200'
                  }`}
                >
                  動画全体
                </button>
              </div>
            </div>

            {/* 解像度 & フレームレート選択 */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-slate-400">解像度:</label>
                <select
                  value={exportResolution}
                  onChange={e => setExportResolution(e.target.value as any)}
                  className="w-full bg-[#101420] border border-[#2b3752] text-xs px-2 py-1 rounded outline-none text-slate-200 cursor-pointer"
                >
                  <option value="1080p">1080p (Full HD)</option>
                  <option value="720p">720p (HD)</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-slate-400">フレームレート:</label>
                <select
                  value={exportFps}
                  onChange={e => setExportFps(parseInt(e.target.value, 10))}
                  className="w-full bg-[#101420] border border-[#2b3752] text-xs px-2 py-1 rounded outline-none text-slate-200 cursor-pointer"
                >
                  <option value="30">30 fps (推奨)</option>
                  <option value="60">60 fps (高品質)</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#2b3752]">
              <button
                onClick={() => setShowExportModal(false)}
                className="px-3 py-1 rounded bg-[#20273a] hover:bg-[#2b354e] text-xs text-slate-300 cursor-pointer"
              >
                キャンセル
              </button>
              <button
                onClick={handleStartExport}
                className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-bold text-xs transition-colors cursor-pointer"
              >
                書き出し開始
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 9. エクスポート進行状況モーダル */}
      {isExporting && exportProgress && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#161c2b] border border-[#2b3752] rounded p-5 w-full max-w-sm text-slate-200 space-y-4 font-sans text-center">
            <h4 className="text-sm font-bold text-red-400 flex items-center justify-center gap-2">
              <Download size={16} className="animate-bounce" />
              テレメトリ動画をレンダリング・書き出し中...
            </h4>

            {/* プログレスバー */}
            <div className="space-y-1">
              <div className="w-full h-2.5 bg-[#101420] rounded border border-[#2b3752] overflow-hidden">
                <div
                  className="h-full bg-red-600 transition-all duration-200"
                  style={{ width: `${exportProgress.percent}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>{exportProgress.percent}%</span>
                <span>残り約 {Math.max(0, Math.round(exportProgress.totalSec - (exportProgress.currentSec - (activeTrack?.syncOffsetSec || 0))))}s</span>
              </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              完了するとブラウザのダウンロードフォルダに MP4 動画が保存されます。
            </p>

            <button
              onClick={() => {
                if (exportControllerRef.current) {
                  exportControllerRef.current.cancel();
                }
              }}
              className="px-4 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-300 cursor-pointer transition-colors"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 隠しインプット */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleAddVideos}
        multiple
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
        className="hidden"
      />
      <input
        type="file"
        ref={jsonInputRef}
        onChange={handleImportProject}
        accept=".json,.dssync.json"
        className="hidden"
      />
    </div>
  );
};
