import React from 'react';
import { BarChart2, List, Repeat, Settings } from 'lucide-react';
import { formatMinSec } from '../utils/timeFormat';
import { useLandscape } from '../hooks/useCompactLayout';
import { isMobileDevice } from '../utils/device';

type Tab = 'graph' | 'data' | 'logger' | 'video' | 'convert';

// スマートフォン向けの配置で出すタブ (動画同期は出さない)。
// ロガー設定は、USB でつなげるパソコンのウインドウを狭くしたときだけ出す
const TABS: { id: Tab; label: string; Icon: typeof BarChart2 }[] = [
  { id: 'graph', label: 'グラフ', Icon: BarChart2 },
  { id: 'data', label: 'データ', Icon: List },
  { id: 'convert', label: '変換', Icon: Repeat },
  ...(isMobileDevice ? [] : [{ id: 'logger' as Tab, label: 'ロガー', Icon: Settings }])
];

/** スマートフォン用の画面下のタブバー (親指で届く位置に置く) */
export const BottomTabBar: React.FC<{
  currentTab: Tab;
  setCurrentTab: (tab: Tab) => void;
  sessionCount: number;
}> = ({ currentTab, setCurrentTab, sessionCount }) => {
  // 横向きでは高さを取らないよう、アイコンと名前を横に並べて薄くする
  const landscape = useLandscape();
  return (
    <nav className="shrink-0 flex bg-surface-1 border-t border-line-1 pb-[env(safe-area-inset-bottom)]">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => setCurrentTab(id)}
          className={`flex-1 flex items-center justify-center font-bold transition-colors ${
            landscape ? 'flex-row gap-2 py-1 text-xs' : 'flex-col gap-0.5 py-2 text-[11px]'
          } ${currentTab === id ? 'text-red-500' : 'text-slate-400'}`}
        >
          <span className="relative">
            <Icon size={landscape ? 16 : 20} />
            {id === 'data' && sessionCount > 0 && (
              <span className="absolute -top-1 -right-3 bg-surface-5 text-slate-200 text-[9px] font-mono px-1 rounded-full">{sessionCount}</span>
            )}
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
};

/** スマートフォン用のシークバー (グラフ解析タブで、指で再生位置を動かす) */
export const MobileSeekBar: React.FC<{
  currentTime: number;
  endTime: number;
  onSeekTime: (t: number) => void;
}> = ({ currentTime, endTime, onSeekTime }) => {
  const landscape = useLandscape();
  return (
    <div className={`shrink-0 flex items-center gap-3 px-3 bg-surface-1 border-t border-line-1 ${landscape ? 'py-0.5' : 'py-2'}`}>
      <input
        type="range"
        min={0}
        max={Math.max(endTime, 0.1)}
        step={0.05}
        value={Math.min(currentTime, endTime)}
        onChange={e => onSeekTime(Number(e.target.value))}
        className="flex-1 accent-red-500 h-6"
        aria-label="再生位置"
      />
      <span className="text-xs font-mono text-slate-300 w-16 text-right">{formatMinSec(currentTime, 1)}</span>
    </div>
  );
};
