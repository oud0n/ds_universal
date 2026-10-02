import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, SkipBack, SkipForward, Video, Upload, 
  Save, FolderOpen, RefreshCw, Sliders, Eye, EyeOff, 
  Clock, Gauge, Plus, Trash2, CheckCircle2, ChevronRight
} from 'lucide-react';
import { Session, TelemetryPoint, SelectedCarSlot } from '../types/telemetry';
import { videoSyncManager, VideoTrack } from '../services/videoSyncManager';

interface VideoSyncWindowProps {
  sessions: Session[];
  selectedCars: SelectedCarSlot[];
  currentTimeSec: number;
  currentDistanceKm: number;
  isPlaying: boolean;
  onSeekTime: (timeSec: number) => void;
  onTogglePlay: () => void;
  circuitName: string;
}

export const VideoSyncWindow: React.FC<VideoSyncWindowProps> = ({
  sessions,
  selectedCars,
  currentTimeSec,
  currentDistanceKm,
  isPlaying,
  onSeekTime,
  onTogglePlay,
  circuitName
}) => {
  const [tracks, setTracks] = useState<VideoTrack[]>(() => videoSyncManager.getTracks());
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(tracks[0]?.id || null);
  const [showOverlay, setShowOverlay] = useState<boolean>(true);
  const [showGForce, setShowGForce] = useState<boolean>(true);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const jsonInputRef = useRef<HTMLInputElement | null>(null);

  const activeTrack = tracks.find(t => t.id === selectedTrackId);
  const baseSelected = selectedCars.find(c => c.slot === 0);
  const baseSession = sessions.find(s => s.id === (activeTrack?.matchedSessionId || baseSelected?.sessionId));
  const baseLap = baseSession?.laps.find(l => l.lapNumber === baseSelected?.lapNumber);

  useEffect(() => {
    videoSyncManager.onTracksUpdated = updated => {
      setTracks([...updated]);
      if (!selectedTrackId && updated.length > 0) {
        setSelectedTrackId(updated[0].id);
      }
    };
  }, [selectedTrackId]);

  // GPS タイムライン変化に合わせて動画の再生位置を追従 (ユーザーがグラフ等でシークした場合)
  useEffect(() => {
    if (!videoRef.current || !activeTrack) return;
    const targetVideoTime = currentTimeSec - activeTrack.syncOffsetSec;
    if (targetVideoTime >= 0 && targetVideoTime <= (activeTrack.durationSec || 9999)) {
      if (Math.abs(videoRef.current.currentTime - targetVideoTime) > 0.15) {
        videoRef.current.currentTime = targetVideoTime;
      }
    }
  }, [currentTimeSec, activeTrack]);

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

  // 動画側の再生時間更新イベント -> GPS タイムラインへ同期伝達
  const handleTimeUpdate = () => {
    if (!videoRef.current || !activeTrack || !isPlaying) return;
    const vTime = videoRef.current.currentTime;
    const gpsTime = vTime + activeTrack.syncOffsetSec;
    onSeekTime(Math.max(0, gpsTime));
  };

  // ワンクリック同期: 現在の動画フレームを GPS の現在選択タイムに合わせる
  const handleSyncCurrentFrame = () => {
    if (!videoRef.current || !activeTrack) return;
    const currentVideoTime = videoRef.current.currentTime;
    const newOffset = currentTimeSec - currentVideoTime;
    videoSyncManager.updateOffset(activeTrack.id, newOffset);
  };

  // 微調整 (+/- 0.05秒: 1フレーム単位)
  const handleNudgeOffset = (deltaSec: number) => {
    if (!activeTrack) return;
    videoSyncManager.updateOffset(activeTrack.id, activeTrack.syncOffsetSec + deltaSec);
  };

  // 動画ファイル追加
  const handleAddVideos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const updated = await videoSyncManager.addVideoFiles(files, sessions);
    if (updated.length > 0 && !selectedTrackId) {
      setSelectedTrackId(updated[0].id);
    }
    e.target.value = '';
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

    // 現在のテレメトリポイント取得
    const pts = baseLap?.points || baseSession?.points || [];
    if (pts.length === 0) return;

    const curPt: TelemetryPoint = pts.reduce((prev, curr) => {
      return Math.abs(curr.time - currentTimeSec) < Math.abs(prev.time - currentTimeSec) ? curr : prev;
    }, pts[0]);

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

      // 現在Gプロット (1.5Gスケール)
      const scaleG = r / 1.5;
      const gX = cX + (curPt.corneringG || 0) * scaleG;
      const gY = cY - (curPt.accelG || 0) * scaleG;

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

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(baseLap ? `Lap ${baseLap.lapNumber}` : 'Total Time', 14, 22);

    const m = Math.floor(currentTimeSec / 60);
    const s = (currentTimeSec % 60).toFixed(2).padStart(5, '0');
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(`${m}:${s}`, 14, 48);

    ctx.restore();
  }, [currentTimeSec, baseLap, baseSession, showOverlay, showGForce]);

  return (
    <div className="flex flex-col h-full bg-[#0a0d14] text-slate-200 select-none overflow-hidden">
      {/* 上部コントロールバー */}
      <div className="h-12 bg-[#121622] border-b border-[#22293a] px-4 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
            <Video size={16} className="text-red-500" />
            車載動画同期 (GoPro H.265 / MP4)
          </span>

          {/* 動画トラック切り替え */}
          {tracks.length > 0 && (
            <select
              value={selectedTrackId || ''}
              onChange={e => setSelectedTrackId(e.target.value)}
              className="bg-[#182030] border border-[#2d3852] text-xs text-slate-200 rounded-lg px-2.5 py-1 outline-none"
            >
              {tracks.map(t => (
                <option key={t.id} value={t.id}>
                  {t.fileName} {t.isAutoMatched ? '(JST自動同期済)' : ''}
                </option>
              ))}
            </select>
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

      {/* メイン動画プレイヤー ＆ オーバーレイエリア */}
      <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
        {activeTrack && activeTrack.objectUrl ? (
          <>
            <video
              ref={videoRef}
              src={activeTrack.objectUrl}
              onTimeUpdate={handleTimeUpdate}
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
          </>
        ) : (
          <div className="flex flex-col items-center justify-center p-8 text-center space-y-4">
            <div className="p-4 rounded-full bg-slate-800/60 text-slate-500">
              <Video size={48} />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-slate-300">車載動画が読み込まれていません</h3>
              <p className="text-xs text-slate-500 max-w-sm">
                GoPro (H.265 / HEVC) などの MP4 / MOV 動画を追加すると、JSTタイムスタンプにより走行ログと自動同期されます。
              </p>
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-lg cursor-pointer transition-all"
            >
              <Upload size={14} />
              車載動画ファイルを選択
            </button>
          </div>
        )}
      </div>

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
          <div className="flex items-center gap-3 text-xs bg-[#182030] px-3.5 py-1.5 rounded-xl border border-[#273248]">
            <span className="text-slate-400 flex items-center gap-1.5 text-[11px]">
              <Sliders size={13} className="text-amber-400" />
              同期オフセット:
              <span className="font-mono font-bold text-amber-400">
                {activeTrack.syncOffsetSec >= 0 ? `+${activeTrack.syncOffsetSec.toFixed(2)}` : activeTrack.syncOffsetSec.toFixed(2)}s
              </span>
            </span>

            <div className="flex items-center gap-1">
              <button
                onClick={() => handleNudgeOffset(-0.05)}
                className="px-2 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[11px] font-mono text-slate-200 transition-colors cursor-pointer"
                title="1フレーム戻す (-0.05秒)"
              >
                -0.05s
              </button>
              <button
                onClick={() => handleNudgeOffset(0.05)}
                className="px-2 py-0.5 rounded bg-[#243048] hover:bg-[#2e3e5c] text-[11px] font-mono text-slate-200 transition-colors cursor-pointer"
                title="1フレーム進める (+0.05秒)"
              >
                +0.05s
              </button>
            </div>

            <button
              onClick={handleSyncCurrentFrame}
              className="px-2.5 py-0.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-[11px] font-bold text-white transition-all shadow cursor-pointer ml-1"
              title="現在の動画再生位置を、現在選択されているGPSログ時刻に同期"
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
