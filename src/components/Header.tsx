import React from 'react';
import { Play, Pause, SkipBack, SkipForward, FolderOpen, Download, Settings, BarChart2, List, ShieldCheck } from 'lucide-react';
import { SelectedCarSlot, Session } from '../types/telemetry';

interface HeaderProps {
  currentTab: 'graph' | 'data' | 'logger';
  setCurrentTab: (tab: 'graph' | 'data' | 'logger') => void;
  sessions: Session[];
  selectedCars: SelectedCarSlot[];
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  playbackSpeed: number;
  onChangePlaybackSpeed: (speed: number) => void;
  onOpenFile: () => void;
  onLoadSample: (sampleName: string) => void;
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
  onLoadSample
}) => {
  return (
    <header className="bg-[#161922] border-b border-[#262c3d] text-slate-200 px-4 py-2 flex items-center justify-between select-none">
      {/* ロゴ & アプリ名 */}
      <div className="flex items-center space-x-3">
        <div className="bg-gradient-to-tr from-red-600 to-red-500 text-white font-black text-lg px-2.5 py-1 rounded shadow-md tracking-wider flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse"></span>
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

      {/* タブ切り替え */}
      <div className="flex bg-[#1f2433] p-1 rounded-lg border border-[#2e364a]">
        <button
          onClick={() => setCurrentTab('graph')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
            currentTab === 'graph'
              ? 'bg-red-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#283042]'
          }`}
        >
          <BarChart2 size={15} />
          グラフ解析
        </button>
        <button
          onClick={() => setCurrentTab('data')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
            currentTab === 'data'
              ? 'bg-red-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#283042]'
          }`}
        >
          <List size={15} />
          データ管理
          {sessions.length > 0 && (
            <span className="ml-1 px-1.5 py-0.2 text-[10px] rounded-full bg-slate-700 text-slate-300 font-mono">
              {sessions.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setCurrentTab('logger')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
            currentTab === 'logger'
              ? 'bg-red-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#283042]'
          }`}
        >
          <Settings size={15} />
          ロガー設定
        </button>
      </div>

      {/* アニメーション再生コントロール (グラフタブ時) */}
      {currentTab === 'graph' && selectedCars.length > 0 && (
        <div className="hidden lg:flex items-center gap-2 bg-[#1a1e2b] px-3 py-1 rounded-lg border border-[#2c3447]">
          <button
            onClick={onStepBack}
            title="コマ戻し (Bキー)"
            className="p-1 hover:bg-[#262e42] rounded text-slate-300 hover:text-white transition-colors"
          >
            <SkipBack size={15} />
          </button>
          <button
            onClick={onTogglePlay}
            title="再生 / 一時停止 (SPACEキー)"
            className={`p-1.5 rounded-full transition-all ${
              isPlaying ? 'bg-amber-500 hover:bg-amber-400 text-slate-950' : 'bg-red-600 hover:bg-red-500 text-white'
            }`}
          >
            {isPlaying ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
          </button>
          <button
            onClick={onStepForward}
            title="コマ送り (Fキー)"
            className="p-1 hover:bg-[#262e42] rounded text-slate-300 hover:text-white transition-colors"
          >
            <SkipForward size={15} />
          </button>

          <div className="h-4 w-[1px] bg-slate-700 mx-1"></div>

          {/* 再生速度 */}
          <div className="flex items-center gap-1 text-[11px] font-mono text-slate-400">
            {[0.5, 1, 2, 4].map(s => (
              <button
                key={s}
                onClick={() => onChangePlaybackSpeed(s)}
                className={`px-1.5 py-0.5 rounded ${
                  playbackSpeed === s
                    ? 'bg-red-600 text-white font-bold'
                    : 'hover:bg-[#262e42] text-slate-400'
                }`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ファイル操作 & サンプルデータ */}
      <div className="flex items-center gap-2">
        {/* サンプルデータドロップダウン */}
        <div className="relative group">
          <button className="flex items-center gap-1.5 text-xs bg-[#242b3d] hover:bg-[#2e374e] text-slate-200 px-3 py-1.5 rounded border border-[#37425e] transition-colors">
            <Download size={13} className="text-red-400" />
            サンプル走行データ
          </button>
          <div className="absolute right-0 top-full mt-1 w-52 bg-[#1a1f2c] border border-[#2e374e] rounded-lg shadow-xl py-1 hidden group-hover:block z-50">
            <button
              onClick={() => onLoadSample('fsw')}
              className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-red-600 hover:text-white transition-colors flex items-center justify-between"
            >
              <span>富士スピードウェイ (Z33)</span>
              <span className="text-[10px] text-slate-400">1:59.511</span>
            </button>
            <button
              onClick={() => onLoadSample('suzuka')}
              className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-red-600 hover:text-white transition-colors flex items-center justify-between"
            >
              <span>鈴鹿サーキット (GSX-R)</span>
              <span className="text-[10px] text-slate-400">2:32.743</span>
            </button>
            <button
              onClick={() => onLoadSample('tsukuba')}
              className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-red-600 hover:text-white transition-colors flex items-center justify-between"
            >
              <span>筑波1000 (EVO10)</span>
              <span className="text-[10px] text-slate-400">42.200</span>
            </button>
          </div>
        </div>

        {/* ファイル読み込み */}
        <button
          onClick={onOpenFile}
          className="flex items-center gap-1.5 text-xs bg-red-600 hover:bg-red-500 text-white font-medium px-3.5 py-1.5 rounded shadow transition-all hover:shadow-red-600/30"
        >
          <FolderOpen size={14} />
          ファイル読込
        </button>
      </div>
    </header>
  );
};
