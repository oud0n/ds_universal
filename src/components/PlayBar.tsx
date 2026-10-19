import React from 'react';
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import { formatMinSec } from '../utils/timeFormat';
import { useLandscape } from '../hooks/useCompactLayout';
import { useT } from '../utils/i18n';

/**
 * グラフ解析の再生の段 (画面の下)。動画同期の画面の下の段と同じ並び:
 * 1 段目に周の印・今の時刻・シークバー・周の長さ、2 段目に戻る・再生・進む・速さ。
 * スマートフォンを横にしたときは、高さを取らないよう 1 段にまとめる
 */
export const PlayBar: React.FC<{
  /** 周の印 (L8 など) */
  label?: string;
  currentTime: number;
  endTime: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeekTime: (t: number) => void;
  onStepBack: () => void;
  onStepForward: () => void;
  playbackSpeed: number;
  onChangePlaybackSpeed: (speed: number) => void;
  compact: boolean;
}> = ({ label, currentTime, endTime, isPlaying, onTogglePlay, onSeekTime, onStepBack, onStepForward, playbackSpeed, onChangePlaybackSpeed, compact }) => {
  const t = useT();
  const landscape = useLandscape();
  const oneRow = compact && landscape;
  const end = Math.max(endTime, 0.1);

  const seek = (
    <div className="flex items-center gap-2.5 flex-1 min-w-0">
      {label && (
        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-600 text-white shrink-0">{label}</span>
      )}
      <span className="text-[11px] font-mono text-emerald-400 font-bold min-w-[44px]">{formatMinSec(Math.min(currentTime, end), 1)}</span>
      <input
        type="range"
        min={0}
        max={end}
        step={0.05}
        value={Math.max(0, Math.min(currentTime, end))}
        onChange={e => onSeekTime(Number(e.target.value))}
        // 触り終わったら注目を外す (入力欄に注目があると、スペース・矢印キーの再生・コマ送りが効かないため)
        onPointerUp={e => e.currentTarget.blur()}
        className={`flex-1 min-w-0 cursor-pointer accent-red-500 ${compact ? 'h-6' : 'h-1'}`}
        aria-label={t('再生位置', 'Playback position')}
      />
      <span className="text-[11px] font-mono text-slate-400 min-w-[44px] text-right">{formatMinSec(end, 1)}</span>
    </div>
  );

  const buttons = (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        onClick={onStepBack}
        className="p-1.5 rounded bg-surface-3 hover:bg-surface-4 border border-line-2 text-slate-300 transition-colors cursor-pointer"
        title={t('コマ戻し (B / ←キー、Shift で 1 秒)', 'Step back (B / ← key, Shift for 1 s)')}
        aria-label={t('コマ戻し', 'Step back')}
      >
        <SkipBack size={compact ? 16 : 14} />
      </button>
      <button
        onClick={onTogglePlay}
        className={`p-2 rounded font-bold transition-colors cursor-pointer ${isPlaying ? 'bg-amber-500 hover:bg-amber-400 text-slate-950' : 'bg-red-600 hover:bg-red-500 text-white'}`}
        title={t('再生 / 一時停止 (SPACEキー)', 'Play / pause (Space)')}
        aria-label={isPlaying ? t('一時停止', 'Pause') : t('再生', 'Play')}
      >
        {isPlaying ? <Pause size={compact ? 17 : 15} /> : <Play size={compact ? 17 : 15} />}
      </button>
      <button
        onClick={onStepForward}
        className="p-1.5 rounded bg-surface-3 hover:bg-surface-4 border border-line-2 text-slate-300 transition-colors cursor-pointer"
        title={t('コマ送り (F / →キー、Shift で 1 秒)', 'Step forward (F / → key, Shift for 1 s)')}
        aria-label={t('コマ送り', 'Step forward')}
      >
        <SkipForward size={compact ? 16 : 14} />
      </button>
      <select
        value={String(playbackSpeed)}
        onChange={e => { onChangePlaybackSpeed(Number(e.target.value)); e.currentTarget.blur(); }}
        className="bg-surface-3 border border-line-3 text-[11px] font-mono text-slate-300 rounded px-1.5 py-1 outline-none ml-1.5 cursor-pointer"
        aria-label={t('再生速度', 'Playback speed')}
      >
        {[0.5, 1, 2, 4].map(v => <option key={v} value={String(v)}>{v}x</option>)}
      </select>
    </div>
  );

  return (
    <div className="shrink-0 bg-surface-1 border-t border-line-1 select-none" data-testid="play-bar">
      {oneRow ? (
        <div className="flex items-center gap-3 px-3 py-0.5">{buttons}{seek}</div>
      ) : (
        <>
          <div className="flex items-center px-3 py-1">{seek}</div>
          <div className="flex items-center px-3 pb-1.5 border-t border-line-1 pt-1.5">{buttons}</div>
        </>
      )}
    </div>
  );
};
