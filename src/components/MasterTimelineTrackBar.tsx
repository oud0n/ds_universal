import React, { useRef, useState, useCallback, useMemo } from 'react';
import { Layers, Video, Gauge, MapPin, ChevronDown, ChevronUp } from 'lucide-react';
import { Session } from '../types/telemetry';
import { VideoTrack } from '../services/videoSyncManager';
import { VideoChapterGroup } from '../services/videoChapterManager';
import { SyncPin, formatPinTime } from '../services/videoSyncPinManager';

export interface MasterTimelineTrackBarProps {
  session: Session | undefined;
  baseLap: any;
  activeTrack: VideoTrack | undefined;
  subTrack: VideoTrack | undefined;
  chapterGroup: VideoChapterGroup | null;
  pins: SyncPin[];
  currentSessionTimeSec: number; // セッション絶対時間 (秒)
  onSeekSessionTime: (sessionTimeSec: number) => void;
  formatDuration: (sec: number) => string;
}

export const MasterTimelineTrackBar: React.FC<MasterTimelineTrackBarProps> = ({
  session,
  baseLap,
  activeTrack,
  subTrack,
  chapterGroup,
  pins,
  currentSessionTimeSec,
  onSeekSessionTime,
  formatDuration
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);

  // セッション全体および動画全体の絶対時間軸の最小値・最大値を算出
  const { minTime, maxTime, totalDuration } = useMemo(() => {
    let min = 0;
    let max = 60;

    if (session && session.points.length > 0) {
      const lastPt = session.points[session.points.length - 1];
      if (lastPt.time > max) max = lastPt.time;
    }

    if (activeTrack) {
      const vidStart = activeTrack.syncOffsetSec || 0;
      const vidDur = chapterGroup ? chapterGroup.totalDurationSec : (activeTrack.durationSec || 0);
      const vidEnd = vidStart + vidDur;

      if (vidStart < min) min = vidStart;
      if (vidEnd > max) max = vidEnd;
    }

    if (subTrack) {
      const subStart = subTrack.syncOffsetSec || 0;
      const subEnd = subStart + (subTrack.durationSec || 0);

      if (subStart < min) min = subStart;
      if (subEnd > max) max = subEnd;
    }

    const dur = Math.max(1, max - min);
    return { minTime: min, maxTime: max, totalDuration: dur };
  }, [session, activeTrack, subTrack, chapterGroup]);

  // 秒数からタイムライン横幅%を計算
  const timeToPercent = useCallback((timeSec: number) => {
    return Math.max(0, Math.min(100, ((timeSec - minTime) / totalDuration) * 100));
  }, [minTime, totalDuration]);

  // マウススクラブ処理 (クリック・ドラッグでシーク)
  const handleScrub = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetSessionSec = minTime + ratio * totalDuration;
    onSeekSessionTime(Number(targetSessionSec.toFixed(2)));
  }, [minTime, totalDuration, onSeekSessionTime]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsScrubbing(true);
    handleScrub(e.clientX);

    const onMouseMove = (ev: MouseEvent) => {
      handleScrub(ev.clientX);
    };

    const onMouseUp = () => {
      setIsScrubbing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // 目盛りステップ (秒) の自動算出 (例: 60s, 120s, 300s, 600s)
  const rulerTicks = useMemo(() => {
    const ticks: number[] = [];
    const step = totalDuration > 1800 ? 300 : totalDuration > 600 ? 120 : 60;
    const startTick = Math.ceil(minTime / step) * step;
    for (let t = startTick; t <= maxTime; t += step) {
      ticks.push(t);
    }
    return ticks;
  }, [minTime, maxTime, totalDuration]);

  const playheadPercent = timeToPercent(currentSessionTimeSec);

  return (
    <div className="bg-[#0e121d] border-t border-[#22293a] flex flex-col shrink-0 select-none font-sans text-xs">
      {/* タイムラインヘッダーバー */}
      <div className="h-6 bg-[#131724] px-3 flex items-center justify-between border-b border-[#1f2638] text-[10px] text-slate-400">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-300 flex items-center gap-1">
            <Layers size={11} className="text-red-400" />
            タイムライン同期インスペクター (NLE Multi-Track)
          </span>
          <span className="text-slate-500">|</span>
          <span>範囲: {formatDuration(minTime)} 〜 {formatDuration(maxTime)} ({formatDuration(totalDuration)})</span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 font-mono">
            <span className="text-red-400">現在位置:</span>
            <strong className="text-slate-200">{formatDuration(currentSessionTimeSec)}</strong>
          </div>
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-0.5 hover:text-slate-200 text-slate-500 cursor-pointer"
            title={isCollapsed ? 'タイムラインを展開' : 'タイムラインを折りたたむ'}
          >
            {isCollapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {/* タイムライントラック群 (展開時) */}
      {!isCollapsed && (
        <div
          ref={containerRef}
          onMouseDown={handleMouseDown}
          className="relative px-2 py-1.5 flex flex-col gap-1 cursor-pointer bg-[#0b0e17] overflow-hidden"
          style={{ height: '76px' }}
        >
          {/* 1. 時間目盛り (Time Ruler) */}
          <div className="relative h-3 w-full border-b border-[#1e2538]">
            {rulerTicks.map((t) => {
              const p = timeToPercent(t);
              return (
                <div
                  key={t}
                  className="absolute top-0 flex flex-col items-center pointer-events-none transform -translate-x-1/2"
                  style={{ left: `${p}%` }}
                >
                  <span className="text-[8px] font-mono text-slate-500 leading-none">{formatDuration(t)}</span>
                  <div className="w-[1px] h-1 bg-slate-700 mt-0.5" />
                </div>
              );
            })}
          </div>

          {/* 2. Track 1: GPS 走行ログトラック (Laps) */}
          <div className="relative h-4.5 w-full bg-[#121624] border border-[#1e273b] rounded-sm overflow-hidden flex items-center">
            <span className="absolute left-1 z-10 text-[8px] font-mono font-bold text-emerald-400 bg-black/60 px-1 py-0.2 rounded pointer-events-none flex items-center gap-0.5">
              <Gauge size={8} /> GPS
            </span>
            {session && session.laps && session.laps.map((lap) => {
              const leftP = timeToPercent(lap.startTime);
              const rightP = timeToPercent(lap.endTime);
              const widthP = Math.max(0.5, rightP - leftP);
              const isSelected = baseLap && baseLap.lapNumber === lap.lapNumber;

              return (
                <div
                  key={lap.lapNumber}
                  style={{ left: `${leftP}%`, width: `${widthP}%` }}
                  className={`absolute top-0 bottom-0 border-r border-[#1a2236] flex items-center justify-center px-0.5 transition-colors ${
                    isSelected
                      ? 'bg-emerald-900/80 border-t-2 border-t-emerald-400'
                      : 'bg-emerald-950/40 hover:bg-emerald-950/70'
                  }`}
                  title={`Lap ${lap.lapNumber}: ${formatDuration(lap.lapTime)} (開始: ${formatDuration(lap.startTime)})`}
                >
                  <span className={`text-[8px] font-mono truncate ${isSelected ? 'text-emerald-200 font-bold' : 'text-slate-400'}`}>
                    L{lap.lapNumber}
                  </span>
                </div>
              );
            })}
          </div>

          {/* 3. Track 2: 車載動画メイン (GoPro / Chapters) */}
          <div className="relative h-4.5 w-full bg-[#121624] border border-[#1e273b] rounded-sm overflow-hidden flex items-center">
            <span className="absolute left-1 z-10 text-[8px] font-mono font-bold text-red-400 bg-black/60 px-1 py-0.2 rounded pointer-events-none flex items-center gap-0.5">
              <Video size={8} /> Video
            </span>

            {/* チャプター分割動画ブロック群 */}
            {chapterGroup && chapterGroup.tracks.length > 0 ? (
              chapterGroup.tracks.map((ct) => {
                const startSec = chapterGroup.baseSyncOffsetSec + ct.groupOffsetSec;
                const endSec = startSec + ct.durationSec;
                const leftP = timeToPercent(startSec);
                const widthP = Math.max(0.5, timeToPercent(endSec) - leftP);
                const isActive = activeTrack && activeTrack.fileName === ct.track.fileName;

                return (
                  <div
                    key={ct.track.id}
                    style={{ left: `${leftP}%`, width: `${widthP}%` }}
                    className={`absolute top-0 bottom-0 border-r border-red-700/60 flex items-center justify-center px-1 ${
                      isActive
                        ? 'bg-red-800/90 border-t-2 border-t-red-400'
                        : 'bg-red-950/60 hover:bg-red-950/80'
                    }`}
                    title={`${ct.track.fileName} (Ch ${ct.chapterIndex}, 長さ: ${formatDuration(ct.durationSec)})`}
                  >
                    <span className="text-[8px] font-mono text-slate-200 truncate font-semibold">
                      Ch{ct.chapterIndex} ({formatDuration(ct.durationSec)})
                    </span>
                  </div>
                );
              })
            ) : activeTrack ? (
              // 単独動画クリップブロック
              (() => {
                const startSec = activeTrack.syncOffsetSec || 0;
                const endSec = startSec + (activeTrack.durationSec || 0);
                const leftP = timeToPercent(startSec);
                const widthP = Math.max(0.5, timeToPercent(endSec) - leftP);

                return (
                  <div
                    style={{ left: `${leftP}%`, width: `${widthP}%` }}
                    className="absolute top-0 bottom-0 bg-red-900/80 border border-red-500/80 flex items-center justify-center px-1"
                    title={`${activeTrack.fileName} (${formatDuration(activeTrack.durationSec)})`}
                  >
                    <span className="text-[8px] font-mono text-white truncate font-bold">
                      {activeTrack.fileName}
                    </span>
                  </div>
                );
              })()
            ) : (
              <span className="text-[8px] text-slate-600 pl-14">動画ファイル未ロード</span>
            )}
          </div>

          {/* 4. Track 3: サブ動画 (Sub Cam - 2カメラ時) */}
          {subTrack && (
            <div className="relative h-3 w-full bg-[#101420] border border-[#1a2233] rounded-xs overflow-hidden flex items-center">
              <span className="absolute left-1 z-10 text-[7px] font-mono font-bold text-blue-400 bg-black/60 px-1 rounded pointer-events-none">
                Sub
              </span>
              {(() => {
                const startSec = subTrack.syncOffsetSec || 0;
                const endSec = startSec + (subTrack.durationSec || 0);
                const leftP = timeToPercent(startSec);
                const widthP = Math.max(0.5, timeToPercent(endSec) - leftP);

                return (
                  <div
                    style={{ left: `${leftP}%`, width: `${widthP}%` }}
                    className="absolute top-0 bottom-0 bg-blue-900/70 border border-blue-500/60 flex items-center justify-center px-1"
                    title={`Sub: ${subTrack.fileName}`}
                  >
                    <span className="text-[7px] font-mono text-blue-200 truncate">
                      {subTrack.fileName}
                    </span>
                  </div>
                );
              })()}
            </div>
          )}

          {/* 5. 同期ピン (Sync Pins) マーカー表示 */}
          {pins.map((pin) => {
            const p = timeToPercent(pin.sessionTimeSec);
            return (
              <div
                key={pin.id}
                style={{ left: `${p}%` }}
                className="absolute top-3 bottom-0 w-[1px] bg-amber-400/80 z-25 pointer-events-none"
              >
                <div
                  className="absolute -top-2 -translate-x-1/2 bg-amber-500 text-slate-950 p-0.5 rounded shadow pointer-events-auto cursor-pointer"
                  title={`ピン: ${pin.name} (${formatPinTime(pin.sessionTimeSec)})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeekSessionTime(pin.sessionTimeSec);
                  }}
                >
                  <MapPin size={8} />
                </div>
              </div>
            );
          })}

          {/* 6. 再生ヘッド (Playhead / 赤い針) */}
          <div
            style={{ left: `${playheadPercent}%` }}
            className="absolute top-0 bottom-0 w-[2px] bg-red-500 z-30 pointer-events-none shadow-[0_0_4px_rgba(239,68,68,0.8)]"
          >
            {/* 上部インジケーターヘッド */}
            <div className="absolute -top-1 -translate-x-1/2 w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[5px] border-t-red-500" />
          </div>
        </div>
      )}
    </div>
  );
};
