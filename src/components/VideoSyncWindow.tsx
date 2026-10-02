import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, SkipBack, SkipForward, Video, Upload, 
  Save, FolderOpen, RefreshCw, Sliders, Eye, EyeOff, 
  Clock, Gauge, Plus, Trash2, CheckCircle2, ChevronRight,
  Globe, AlertTriangle, Zap
} from 'lucide-react';
import { Session, TelemetryPoint, SelectedCarSlot } from '../types/telemetry';
import { videoSyncManager, VideoTrack, TIMEZONE_OPTIONS, getTimezoneOffsetMs } from '../services/videoSyncManager';

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
  const [showOverlay, setShowOverlay] = useState<boolean>(true);
  const [showGForce, setShowGForce] = useState<boolean>(true);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const jsonInputRef = useRef<HTMLInputElement | null>(null);

  // 速度ウィンドウの選択状態 (Car 1) を最優先で参照
  const baseSelected = selectedCars.find(c => c.slot === 0);
  const speedSessionId = targetSessionId || baseSelected?.sessionId;
  const baseSession = sessions.find(s => s.id === speedSessionId) || sessions[0];
  const baseLap = targetLap || baseSession?.laps.find(l => l.lapNumber === baseSelected?.lapNumber) || baseSession?.laps[0];

  const activeTrack = tracks.find(t => t.id === selectedTrackId);

  // タイムスタンプフォーマット関数
  const formatTzDate = (d: Date | null | undefined, tz: string): string => {
    if (!d) return '--:--:--';
    const offsetMs = getTimezoneOffsetMs(tz);
    const adjusted = new Date(d.getTime() + offsetMs);
    const y = adjusted.getUTCFullYear();
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
    };
  }, [selectedTrackId]);

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

  // タイムゾーン変更ハンドラ
  const handleVideoTzChange = (newTz: string) => {
    if (!activeTrack || !baseSession) return;
    videoSyncManager.resyncTrack(activeTrack.id, sessions, newTz, undefined, baseSession.id);
  };

  const handleGpsTzChange = (newTz: string) => {
    if (!activeTrack || !baseSession) return;
    videoSyncManager.resyncTrack(activeTrack.id, sessions, undefined, newTz, baseSession.id);
  };

  // 再同期ボタンハンドラ
  const handleResync = () => {
    if (!activeTrack || !baseSession) return;
    videoSyncManager.resyncTrack(
      activeTrack.id,
      sessions,
      activeTrack.videoTimezone || 'JST',
      activeTrack.gpsTimezone || 'JST',
      baseSession.id
    );
  };

  // GPS タイムライン変化に合わせて動画の再生位置を追従 (ユーザーが速度グラフ等でシークした場合)
  useEffect(() => {
    if (!videoRef.current || !activeTrack) return;
    // グラフ画面埋め込み時は、選択中ラップの開始秒を加味してセッション全体秒に変換
    const effectiveSessionTime = isGraphEmbedded && baseLap
      ? (baseLap.startTime + currentTimeSec)
      : currentTimeSec;

    const targetVideoTime = effectiveSessionTime - activeTrack.syncOffsetSec;
    if (targetVideoTime >= 0 && targetVideoTime <= (activeTrack.durationSec || 9999)) {
      if (Math.abs(videoRef.current.currentTime - targetVideoTime) > 0.15) {
        videoRef.current.currentTime = targetVideoTime;
      }
    }
  }, [currentTimeSec, activeTrack, isGraphEmbedded, baseLap]);

  // 再生/一時停止同期
  useEffect(() => {
    if (!videoRef.current) return;
    if (isPlaying && videoRef.current.paused) {
      videoRef.current.play().catch(console.warn);
    } else if (!isPlaying && !videoRef.current.paused) {
      videoRef.current.pause();
    }
  }, [isPlaying]);

  // 再生速度同期
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  // 動画側の再生時間更新イベント -> 速度ウィンドウ・GPS タイムラインへ同期伝達
  const handleTimeUpdate = () => {
    if (!videoRef.current || !activeTrack || !isPlaying) return;
    const vTime = videoRef.current.currentTime;
    const sessionTime = vTime + activeTrack.syncOffsetSec;

    if (isGraphEmbedded && baseLap) {
      // 速度ウィンドウ表示時は、ラップ内時間 (0〜lapTime) に変換して onSeekTime を呼ぶ
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
  const handleNudgeOffset = (deltaSec: number) => {
    if (!activeTrack) return;
    videoSyncManager.updateOffset(activeTrack.id, activeTrack.syncOffsetSec + deltaSec);
  };

  // 動画ファイル一括処理
  const processFiles = async (fileList: FileList | File[]) => {
    const updated = await videoSyncManager.addVideoFiles(fileList, sessions);
    if (updated.length > 0 && !selectedTrackId) {
      setSelectedTrackId(updated[0].id);
    }
  };

  // 動画ファイル追加 (ファイルダイアログ経由)
  const handleAddVideos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await processFiles(files);
    e.target.value = '';
  };

  // ドラッグ＆ドロップ操作
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      await processFiles(files);
    }
  };

  // プロジェクト JSON 保存
  const handleExportProject = () => {
    const jsonStr = videoSyncManager.exportProjectJson(sessions, circuitName);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${circuitName || 'motorsport'}_sync_project.dssync.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // プロジェクト JSON 復元
  const handleImportProject = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      videoSyncManager.importProjectJson(text);
      alert('同期プロジェクト設定を復元しました。\n動画ファイルを再リンクしてください。');
    } catch (err: any) {
      alert(`プロジェクト復元エラー: ${err.message}`);
    }
    e.target.value = '';
  };

  // リアルタイム・テレメトリオーバーレイ描画 (Canvas)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !showOverlay) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 現在のテレメトリポイント取得 (動画同期時はセッション全体のタイムラインを参照)
    const pts = baseSession?.points || baseLap?.points || [];
    if (pts.length === 0) return;

    // 速度ウィンドウ表示時はラップ開始秒を加算してセッション全体の絶対時刻を計算
    const effectiveTime = isGraphEmbedded && baseLap
      ? (baseLap.startTime + currentTimeSec)
      : currentTimeSec;

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

    const w = canvas.width;
    const h = canvas.height;

    // 1. デジタルスピードメーター (左下)
    ctx.save();
    ctx.translate(40, h - 110);

    // 背景半透明プレート
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 160, 85, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 速度数値
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 38px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${curPt.speed.toFixed(0)}`, 16, 50);

    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('km/h', 105, 48);

    // 速度カラーバー
    const maxScaleSpd = 200;
    const spdRatio = Math.min(1, curPt.speed / maxScaleSpd);
    ctx.fillStyle = '#334155';
    ctx.fillRect(16, 64, 128, 6);
    ctx.fillStyle = spdRatio > 0.8 ? '#ef4444' : spdRatio > 0.5 ? '#eab308' : '#3b82f6';
    ctx.fillRect(16, 64, 128 * spdRatio, 6);

    ctx.restore();

    // 2. Gフォースメーター (右下)
    if (showGForce) {
      ctx.save();
      ctx.translate(w - 140, h - 110);

      // 背景プレート
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.beginPath();
      ctx.roundRect(0, 0, 110, 85, 12);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.stroke();

      // フリクションサークル
      const cX = 55;
      const cY = 42;
      const r = 26;

      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cX, cY, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cX, cY, r * 0.5, 0, Math.PI * 2);
      ctx.stroke();

      // 十字線
      ctx.strokeStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(cX - r, cY); ctx.lineTo(cX + r, cY);
      ctx.moveTo(cX, cY - r); ctx.lineTo(cX, cY + r);
      ctx.stroke();

      // 軸ラベル (上=減速/ブレーキ, 下=加速, 左=左G/右旋回, 右=右G/左旋回)
      ctx.font = 'bold 7px sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('減', cX, cY - r + 5);
      ctx.fillText('加', cX, cY + r - 5);
      ctx.fillText('L', cX - r + 5, cY);
      ctx.fillText('R', cX + r - 5, cY);

      // 現在Gプロット (1.5Gスケール: 減速時(accelG<0)で上(-Y), 右旋回時(corneringG>0)で左(-X))
      const scaleG = r / 1.5;
      const gX = cX - (curPt.corneringG || 0) * scaleG;
      const gY = cY + (curPt.accelG || 0) * scaleG;

      ctx.fillStyle = '#ef4444';
      ctx.shadowColor = '#ef4444';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(gX, gY, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.font = 'bold 9px monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'center';
      ctx.fillText(`${(curPt.combinedG || 0).toFixed(2)} G`, cX, 80);

      ctx.restore();
    }

    // 3. ラップタイム情報 (右上)
    ctx.save();
    ctx.translate(w - 180, 24);

    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 155, 60, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.stroke();

    // 現在走行中のラップを動的特定 (effectiveTimeがどのラップ区間に属するか)
    const currentLap = baseSession?.laps.find(l => effectiveTime >= l.startTime && effectiveTime <= l.endTime);
    const lapLabel = currentLap ? `Lap ${currentLap.lapNumber}` : (baseLap ? `Lap ${baseLap.lapNumber}` : 'Out / In Lap');
    const lapDisplayTime = currentLap ? (effectiveTime - currentLap.startTime) : (baseLap ? currentTimeSec : effectiveTime);

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(lapLabel, 14, 22);

    const m = Math.floor(lapDisplayTime / 60);
    const s = (lapDisplayTime % 60).toFixed(2).padStart(5, '0');
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(`${m}:${s}`, 14, 48);

    ctx.restore();
  }, [currentTimeSec, baseLap, baseSession, showOverlay, showGForce, isGraphEmbedded]);

  return (
    <div className="flex flex-col h-full bg-[#0a0d14] text-slate-200 select-none overflow-hidden">
      {/* 上部コントロールバー */}
      <div className="h-12 bg-[#121622] border-b border-[#22293a] px-4 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5 shrink-0">
            <Video size={16} className="text-red-500" />
            車載動画同期 (GoPro H.265 / MP4)
          </span>

          {/* 速度ウィンドウ連携バッジ */}
          {baseSession && (
            <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/70 border border-emerald-800/80 px-2 py-0.5 rounded-md flex items-center gap-1 shrink-0 shadow-xs" title="速度ウィンドウで選択中の走行ログファイルと同期中">
              <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
              <span className="max-w-[130px] truncate font-bold text-slate-100">{baseSession.sessionName}</span>
              {baseLap && <span className="text-emerald-300 font-bold">L{baseLap.lapNumber}</span>}
            </span>
          )}

          {/* 動画トラック切り替え */}
          {tracks.length > 0 && (
            <div className="flex items-center gap-1">
              <select
                value={selectedTrackId || ''}
                onChange={e => setSelectedTrackId(e.target.value)}
                className="bg-[#182030] border border-[#2d3852] text-xs text-slate-200 rounded-lg px-2.5 py-1 outline-none max-w-xs truncate"
              >
                {tracks.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.fileName} {t.isAutoMatched ? '(JST自動同期済)' : ''}
                  </option>
                ))}
              </select>
              {selectedTrackId && (
                <button
                  onClick={() => {
                    videoSyncManager.removeTrack(selectedTrackId);
                    const remaining = videoSyncManager.getTracks();
                    setSelectedTrackId(remaining[0]?.id || null);
                  }}
                  title="この動画トラックを削除"
                  className="p-1 hover:bg-red-950/60 text-slate-400 hover:text-red-400 rounded transition-colors cursor-pointer"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          )}

          {/* 動画追加ボタン */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#1e2638] hover:bg-[#28334c] text-xs text-slate-300 border border-[#313e5c] transition-colors cursor-pointer"
          >
            <Plus size={13} />
            動画を追加
          </button>
        </div>

        {/* 同期プロジェクト JSON 保存 / 読込 */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportProject}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#182030] hover:bg-[#222c42] text-xs text-slate-300 border border-[#2d3852] transition-colors cursor-pointer"
            title="同期情報とファイル構成を .dssync.json として保存"
          >
            <Save size={13} />
            同期プロジェクト保存
          </button>
          <button
            onClick={() => jsonInputRef.current?.click()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#182030] hover:bg-[#222c42] text-xs text-slate-300 border border-[#2d3852] transition-colors cursor-pointer"
            title="保存した .dssync.json から同期状態を復元"
          >
            <FolderOpen size={13} />
            プロジェクト読込
          </button>

          {/* オーバーレイON/OFF */}
          <button
            onClick={() => setShowOverlay(!showOverlay)}
            className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
              showOverlay ? 'bg-red-600/20 text-red-400 border-red-500/40' : 'bg-slate-800 text-slate-500 border-slate-700'
            }`}
            title="テレメトリ計器オーバーレイの表示切替"
          >
            {showOverlay ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
        </div>
      </div>

      {/* タイムゾーン設定 & 再同期専用バー */}
      {activeTrack && (
        <div className="bg-[#151926] border-b border-[#242c3f] px-4 py-2 flex flex-wrap items-center justify-between gap-2.5 text-xs shrink-0 select-none">
          <div className="flex flex-wrap items-center gap-3">
            {/* 動画タイムゾーン選択 */}
            <div className="flex items-center gap-1.5 bg-[#1a2030] px-2.5 py-1 rounded-lg border border-[#2d3852]">
              <Video size={13} className="text-red-400 shrink-0" />
              <span className="text-slate-400 text-[11px] font-medium shrink-0">動画TZ:</span>
              <select
                value={activeTrack.videoTimezone || 'JST'}
                onChange={e => handleVideoTzChange(e.target.value)}
                className="bg-transparent text-slate-100 font-bold text-xs outline-none cursor-pointer"
              >
                {TIMEZONE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value} className="bg-[#182030] text-slate-200">
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* デジスパイスGPSログタイムゾーン選択 */}
            <div className="flex items-center gap-1.5 bg-[#1a2030] px-2.5 py-1 rounded-lg border border-[#2d3852]">
              <Gauge size={13} className="text-blue-400 shrink-0" />
              <span className="text-slate-400 text-[11px] font-medium shrink-0">デジスパイスTZ:</span>
              <select
                value={activeTrack.gpsTimezone || 'JST'}
                onChange={e => handleGpsTzChange(e.target.value)}
                className="bg-transparent text-slate-100 font-bold text-xs outline-none cursor-pointer"
              >
                {TIMEZONE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value} className="bg-[#182030] text-slate-200">
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 対象走行枠セッション選択 (複数セッション読み込み時) */}
            {sessions.length > 1 && (
              <div className="flex items-center gap-1.5 bg-[#1a2030] px-2.5 py-1 rounded-lg border border-[#2d3852]">
                <span className="text-slate-400 text-[11px] font-medium shrink-0">走行枠:</span>
                <select
                  value={activeTrack.matchedSessionId || ''}
                  onChange={e => {
                    videoSyncManager.setMatchedSession(activeTrack.id, e.target.value);
                    videoSyncManager.resyncTrack(activeTrack.id, sessions, activeTrack.videoTimezone, activeTrack.gpsTimezone, e.target.value);
                  }}
                  className="bg-transparent text-slate-100 font-bold text-xs outline-none cursor-pointer max-w-[130px] truncate"
                >
                  {sessions.map(s => (
                    <option key={s.id} value={s.id} className="bg-[#182030] text-slate-200">
                      {s.sessionName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* 再同期ボタン */}
            <button
              onClick={handleResync}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-md transition-all cursor-pointer"
              title="選択したタイムゾーンに基づいて動画とGPS走行データの時間差を再計算"
            >
              <RefreshCw size={13} />
              再同期
            </button>
          </div>

          {/* 時刻比較診断 & クイック時差補正 */}
          <div className="flex items-center gap-2 text-[11px]">
            {/* 9時間などの時差ズレ検出バッジ */}
            {isLargeOffset && (
              <div className="flex items-center gap-1.5 bg-amber-950/70 border border-amber-500/60 text-amber-300 px-2.5 py-1 rounded-lg shadow-sm">
                <AlertTriangle size={13} className="text-amber-400 shrink-0" />
                <span>約{Math.round(Math.abs(activeTrack.syncOffsetSec) / 3600)}時間ズレ検出</span>
                <button
                  onClick={() => videoSyncManager.shiftOffsetHours(activeTrack.id, activeTrack.syncOffsetSec > 0 ? -9 : 9)}
                  className="px-2 py-0.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded text-[10px] cursor-pointer transition-colors"
                  title="9時間の時差ズレをワンクリックで打ち消し補正"
                >
                  ±9h即時補正
                </button>
              </div>
            )}

            {/* 診断情報: 動画録画時刻 & GPS開始時刻 */}
            <div className="hidden lg:flex items-center gap-2 bg-[#121622] px-3 py-1 rounded-lg border border-[#232b3d] text-slate-400 font-mono text-[11px]">
              <span>動画: <strong className="text-slate-200">{formatTzDate(activeTrack.rawRecordedAt, activeTrack.videoTimezone || 'JST')}</strong></span>
              <span className="text-slate-600">|</span>
              <span>GPS: <strong className="text-slate-200">{formatTzDate(gpsStartTime, activeTrack.gpsTimezone || 'JST')}</strong></span>
            </div>
          </div>
        </div>
      )}

      {/* メイン動画プレイヤー ＆ オーバーレイエリア (ドラッグ＆ドロップ対応) */}
      <div 
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex-1 relative bg-black flex items-center justify-center overflow-hidden transition-all ${
          isDragging ? 'border-2 border-dashed border-red-500 bg-red-950/20' : ''
        }`}
      >
        {/* ドラッグ中オーバーレイ */}
        {isDragging && (
          <div className="absolute inset-0 bg-red-950/80 backdrop-blur-xs flex flex-col items-center justify-center z-30 pointer-events-none space-y-2">
            <Video size={48} className="text-red-400 animate-bounce" />
            <p className="text-sm font-bold text-white">ここに動画ファイル（.mp4, .mov, .webm）をドロップ</p>
            <p className="text-xs text-red-300">GoProの複数分割ファイルも一括ドロップ可能です</p>
          </div>
        )}

        {activeTrack && activeTrack.objectUrl ? (
          <>
            <video
              ref={videoRef}
              src={activeTrack.objectUrl}
              onTimeUpdate={handleTimeUpdate}
              onEnded={() => {
                if (isPlaying) onTogglePlay();
              }}
              playsInline
              className="max-h-full max-w-full object-contain"
            />
            {/* テレメトリオーバーレイ Canvas */}
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              className={`absolute inset-0 w-full h-full object-contain pointer-events-none ${
                showOverlay ? 'opacity-100' : 'opacity-0'
              } transition-opacity duration-200`}
            />

            {/* 録画開始前 / 録画終了後のステータスインジケーター */}
            {currentTimeSec < activeTrack.syncOffsetSec && (
              <div className="absolute top-4 bg-amber-950/90 border border-amber-500/80 text-amber-200 px-3.5 py-2 rounded-xl shadow-2xl backdrop-blur-sm flex items-center gap-2.5 text-xs font-medium z-20 pointer-events-auto">
                <Clock size={15} className="text-amber-400 animate-pulse shrink-0" />
                <span>動画録画開始前（動画開始まであと <strong className="font-mono text-amber-300">{(activeTrack.syncOffsetSec - currentTimeSec).toFixed(1)}s</strong>）</span>
                <button
                  onClick={() => onSeekTime(activeTrack.syncOffsetSec)}
                  className="px-2 py-0.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded text-[11px] cursor-pointer transition-colors shadow-sm ml-1"
                  title="動画の録画開始時刻へGPSタイムラインをスキップ"
                >
                  動画開始位置へジャンプ
                </button>
              </div>
            )}
            {currentTimeSec > activeTrack.syncOffsetSec + (activeTrack.durationSec || 99999) && (
              <div className="absolute top-4 bg-slate-900/90 border border-slate-600 text-slate-300 px-3.5 py-1.5 rounded-xl shadow-xl backdrop-blur-sm flex items-center gap-2 text-xs font-medium z-20 pointer-events-none">
                <CheckCircle2 size={14} className="text-slate-400 shrink-0" />
                <span>動画録画終了後（GPS走行ログ再生中）</span>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center p-8 text-center space-y-4 max-w-md">
            <div className="p-5 rounded-2xl bg-slate-800/60 text-slate-400 border border-slate-700/50">
              <Video size={48} className="text-red-500/90" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-sm font-bold text-slate-200">車載動画（オンボード映像）を読み込む</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                GoPro（最新H.265 / HEVC対応）などの MP4 / MOV 動画をここにドラッグ＆ドロップするか、下のボタンから選択してください。
              </p>
              {sessions.length > 0 ? (
                <div className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400 bg-emerald-950/50 border border-emerald-800/60 px-3 py-1 rounded-full font-medium mt-1">
                  <CheckCircle2 size={13} />
                  GPS走行ログ読み込み済み（動画の録画開始時刻と照合して自動同期されます）
                </div>
              ) : (
                <div className="inline-flex items-center gap-1.5 text-[11px] text-amber-400 bg-amber-950/40 border border-amber-800/50 px-3 py-1 rounded-full font-medium mt-1">
                  ⚠️ 先にヘッダーの「ファイル読込」からデジスパイス走行ログを開くと自動同期が有効になります
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-lg cursor-pointer transition-all hover:scale-[1.02]"
              >
                <Upload size={14} />
                車載動画ファイルを選択
              </button>
              <button
                onClick={() => jsonInputRef.current?.click()}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[#1b2233] hover:bg-[#252f47] text-slate-300 font-medium text-xs border border-[#2e3a57] cursor-pointer transition-all"
              >
                <FolderOpen size={13} />
                プロジェクト読込 (.dssync.json)
              </button>
            </div>
            <p className="text-[10px] text-slate-500">
              ※ GoPro のチャプター分割ファイル (GH01, GH02...) や複数ヒートの動画も一括複数選択可能
            </p>
          </div>
        )}
      </div>

      {/* 動画タイムライン シークバー */}
      {activeTrack && activeTrack.durationSec && (() => {
        const effectiveTime = isGraphEmbedded && baseLap ? (baseLap.startTime + currentTimeSec) : currentTimeSec;
        const currentVideoSec = Math.max(0, effectiveTime - activeTrack.syncOffsetSec);
        return (
          <div className="bg-[#10141f] border-t border-[#1d2333] px-4 py-1.5 flex items-center gap-3 shrink-0 select-none">
            <span className="text-[11px] font-mono text-slate-400 min-w-[55px]">
              {formatDuration(currentVideoSec)}
            </span>
            <input
              type="range"
              min={0}
              max={activeTrack.durationSec}
              step={0.1}
              value={Math.min(activeTrack.durationSec, currentVideoSec)}
              onChange={e => {
                const vTime = parseFloat(e.target.value);
                if (videoRef.current) {
                  videoRef.current.currentTime = vTime;
                }
                const sessionTime = vTime + activeTrack.syncOffsetSec;
                if (isGraphEmbedded && baseLap) {
                  onSeekTime(Math.max(0, sessionTime - baseLap.startTime));
                } else {
                  onSeekTime(sessionTime);
                }
              }}
              className="flex-1 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-red-500"
            />
            <span className="text-[11px] font-mono text-slate-500 min-w-[55px] text-right">
              {formatDuration(activeTrack.durationSec)}
            </span>
          </div>
        );
      })()}

      {/* 下部同期調整 ＆ 再生コントロールバー */}
      <div className="h-14 bg-[#121622] border-t border-[#22293a] px-4 flex items-center justify-between gap-4 shrink-0">
        {/* 再生ボタン群 */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSeekTime(Math.max(0, currentTimeSec - 1.0))}
            className="p-2 rounded-lg bg-[#182030] hover:bg-[#222c42] text-slate-300 transition-colors cursor-pointer"
            title="1秒戻る"
          >
            <SkipBack size={15} />
          </button>
          <button
            onClick={onTogglePlay}
            className="p-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold transition-all shadow cursor-pointer"
            title={isPlaying ? '一時停止' : '再生'}
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button
            onClick={() => onSeekTime(currentTimeSec + 1.0)}
            className="p-2 rounded-lg bg-[#182030] hover:bg-[#222c42] text-slate-300 transition-colors cursor-pointer"
            title="1秒進む"
          >
            <SkipForward size={15} />
          </button>

          {/* 再生速度 */}
          <select
            value={playbackSpeed}
            onChange={e => setPlaybackSpeed(parseFloat(e.target.value))}
            className="bg-[#182030] border border-[#2d3852] text-[11px] font-mono text-slate-300 rounded-lg px-2 py-1 outline-none ml-2"
          >
            <option value="0.25">0.25x</option>
            <option value="0.5">0.5x</option>
            <option value="1.0">1.0x</option>
            <option value="1.5">1.5x</option>
            <option value="2.0">2.0x</option>
          </select>
        </div>

        {/* 同期オフセット微調整コントロール */}
        {activeTrack && (
          <div className="flex flex-wrap items-center gap-2.5 text-xs bg-[#182030] px-3.5 py-1.5 rounded-xl border border-[#273248]">
            <span className="text-slate-400 flex items-center gap-1.5 text-[11px]">
              <Sliders size={13} className="text-amber-400" />
              オフセット:
              <input
                type="number"
                step="0.05"
                value={activeTrack.syncOffsetSec}
                onChange={e => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) videoSyncManager.updateOffset(activeTrack.id, val);
                }}
                className="w-24 bg-[#111520] border border-[#2d3850] text-amber-400 font-mono font-bold px-1.5 py-0.5 rounded text-right outline-none focus:border-amber-400 transition-colors"
                title="オフセット秒数を直接手入力可能"
              />
              s
            </span>

            {/* 微調整ボタン群 */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleNudgeOffset(-1.0)}
                className="px-1.5 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[10px] font-mono text-slate-300 transition-colors cursor-pointer"
                title="1秒戻す (-1.0秒)"
              >
                -1s
              </button>
              <button
                onClick={() => handleNudgeOffset(-0.05)}
                className="px-1.5 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[10px] font-mono text-slate-200 transition-colors cursor-pointer"
                title="1フレーム戻す (-0.05秒)"
              >
                -0.05s
              </button>
              <button
                onClick={() => handleNudgeOffset(0.05)}
                className="px-1.5 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[10px] font-mono text-slate-200 transition-colors cursor-pointer"
                title="1フレーム進める (+0.05秒)"
              >
                +0.05s
              </button>
              <button
                onClick={() => handleNudgeOffset(1.0)}
                className="px-1.5 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[10px] font-mono text-slate-300 transition-colors cursor-pointer"
                title="1秒進める (+1.0秒)"
              >
                +1s
              </button>
            </div>

            {/* 時差シフトクイックボタン */}
            <div className="flex items-center gap-0.5 border-l border-[#2e3a52] pl-2">
              <button
                onClick={() => videoSyncManager.shiftOffsetHours(activeTrack.id, -9)}
                className="px-1.5 py-0.5 rounded bg-[#20273a] hover:bg-[#2a354e] text-[10px] font-mono text-slate-400 hover:text-amber-300 transition-colors cursor-pointer"
                title="-9時間シフト"
              >
                -9h
              </button>
              <button
                onClick={() => videoSyncManager.shiftOffsetHours(activeTrack.id, 9)}
                className="px-1.5 py-0.5 rounded bg-[#20273a] hover:bg-[#2a354e] text-[10px] font-mono text-slate-400 hover:text-amber-300 transition-colors cursor-pointer"
                title="+9時間シフト"
              >
                +9h
              </button>
            </div>

            <button
              onClick={handleSyncCurrentFrame}
              className="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-[11px] font-bold text-white transition-all shadow cursor-pointer ml-1"
              title="現在の動画再生位置を、現在選択されているGPSログ時刻に合わせる"
            >
              現フレームで同期
            </button>
          </div>
        )}
      </div>

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
