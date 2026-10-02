import React from 'react';
import { Play, Pause, SkipBack, SkipForward, FolderOpen, Settings, BarChart2, List, ShieldCheck, Video, Download } from 'lucide-react';
import { SelectedCarSlot, Session } from '../types/telemetry';

interface HeaderProps {
  currentTab: 'graph' | 'data' | 'logger' | 'video';
  setCurrentTab: (tab: 'graph' | 'data' | 'logger' | 'video') => void;
  sessions: Session[];
  selectedCars: SelectedCarSlot[];
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  playbackSpeed: number;
  onChangePlaybackSpeed: (speed: number) => void;
  onOpenFile: () => void;
  onExportNmea?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  setCurrentTab,
  sessions,
  selectedCars,
  isPlaying,
  onTogglePlay,
  onStepForward,
  onStepBack,
  playbackSpeed,
  onChangePlaybackSpeed,
  onOpenFile,
  onExportNmea
}) => {
  return (
    <header className="bg-[#131620] border-b border-[#222838] text-slate-200 px-4 py-2 flex items-center justify-between select-none">
      {/* ロゴ & アプリ名 (フラットデザイン) */}
      <div className="flex items-center space-x-3">
        <div className="bg-red-600 text-white font-black text-sm px-2.5 py-1 rounded tracking-wider flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-white"></span>
          DS-ANALYSER
        </div>
        <div className="hidden md:flex flex-col">
          <span className="text-xs font-semibold text-slate-300 tracking-wide">
            DigiSpice Universal Analyser
          </span>
          <span className="text-[10px] text-emerald-400 font-mono flex items-center gap-1">
            <ShieldCheck size={11} /> 完全オフライン動作 / 互換仕様
          </span>
        </div>
      </div>

      {/* タブ切り替え (フラットデザイン) */}
      <div className="flex bg-[#181d2a] p-0.5 rounded border border-[#262e40]">
        <button
          onClick={() => setCurrentTab('graph')}
          className={`flex items-center gap-1.5 px-3.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
            currentTab === 'graph'
              ? 'bg-red-600 text-white'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#202738]'
          }`}
        >
          <BarChart2 size={14} />
          グラフ解析
        </button>
        <button
          onClick={() => setCurrentTab('video')}
          className={`flex items-center gap-1.5 px-3.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
            currentTab === 'video'
              ? 'bg-red-600 text-white'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#202738]'
          }`}
        >
          <Video size={14} />
          動画同期
        </button>
        <button
          onClick={() => setCurrentTab('data')}
          className={`flex items-center gap-1.5 px-3.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
            currentTab === 'data'
              ? 'bg-red-600 text-white'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#202738]'
          }`}
        >
          <List size={14} />
          データ管理
          {sessions.length > 0 && (
            <span className="ml-1 px-1.5 py-0.2 text-[10px] rounded bg-slate-700 text-slate-300 font-mono">
              {sessions.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setCurrentTab('logger')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
            currentTab === 'logger'
              ? 'bg-red-600 text-white'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#202738]'
          }`}
        >
          <Settings size={14} />
          ロガー設定
        </button>
      </div>

      {/* アニメーション再生コントロール (フラットデザイン) */}
      {currentTab === 'graph' && selectedCars.length > 0 && (
        <div className="hidden lg:flex items-center gap-2 bg-[#181d2a] px-2.5 py-1 rounded border border-[#262e40]">
          <button
            onClick={onStepBack}
            title="コマ戻し (Bキー)"
            className="p-1 hover:bg-[#242b3b] rounded text-slate-300 hover:text-white transition-colors cursor-pointer"
          >
            <SkipBack size={14} />
          </button>
          <button
            onClick={onTogglePlay}
            title="再生 / 一時停止 (SPACEキー)"
            className={`p-1.5 rounded transition-colors cursor-pointer ${
              isPlaying ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold' : 'bg-red-600 hover:bg-red-500 text-white'
            }`}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
          </button>
          <button
            onClick={onStepForward}
            title="コマ送り (Fキー)"
            className="p-1 hover:bg-[#242b3b] rounded text-slate-300 hover:text-white transition-colors cursor-pointer"
          >
            <SkipForward size={14} />
          </button>

          <div className="h-4 w-[1px] bg-slate-700 mx-1"></div>

          {/* 再生速度 */}
          <div className="flex items-center gap-0.5 text-[11px] font-mono text-slate-400">
            {[0.5, 1, 2, 4].map(s => (
              <button
                key={s}
                onClick={() => onChangePlaybackSpeed(s)}
                className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                  playbackSpeed === s
                    ? 'bg-red-600 text-white font-bold'
                    : 'hover:bg-[#242b3b] text-slate-400'
                }`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ファイル操作 (フラットデザイン) */}
      <div className="flex items-center gap-2">
        {/* NMEA-0183 出力 (RaceChrono連携) */}
        {sessions.length > 0 && onExportNmea && (
          <button
            onClick={onExportNmea}
            className="flex items-center gap-1.5 text-xs bg-[#1a2030] hover:bg-[#252f46] text-slate-200 border border-[#2d3852] font-medium px-2.5 py-1.5 rounded transition-colors cursor-pointer"
            title="現在の走行データを RaceChrono 互換の NMEA-0183 (.nmea) としてエクスポート"
          >
            <Download size={13} className="text-cyan-400" />
            NMEA出力
          </button>
        )}

        {/* ファイル読み込み */}
        <button
          onClick={onOpenFile}
          className="flex items-center gap-1.5 text-xs bg-red-600 hover:bg-red-500 text-white font-bold px-3 py-1.5 rounded transition-colors cursor-pointer"
        >
          <FolderOpen size={13} />
          ファイル読込
        </button>
      </div>
    </header>
  );
};
