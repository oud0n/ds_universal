import React, { useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, FolderOpen, Settings, Repeat, BarChart2, List, Video, Coffee, Sun, Moon, Monitor, MoreHorizontal } from 'lucide-react';
import { SelectedCarSlot, Session } from '../types/telemetry';
import { ThemeSetting, setThemeSetting, useThemeSetting } from '../utils/theme';
import { canUseLoggerUsb } from '../utils/device';
import { Lang, setLang, useLang, useT } from '../utils/i18n';

// テーマの切り替え (ライト / ダーク / システムに合わせる)
const THEME_OPTIONS: { value: ThemeSetting; label: [string, string]; short: [string, string]; Icon: typeof Sun }[] = [
  { value: 'light', label: ['ライトモード', 'Light mode'], short: ['ライト', 'Light'], Icon: Sun },
  { value: 'dark', label: ['ダークモード', 'Dark mode'], short: ['ダーク', 'Dark'], Icon: Moon },
  { value: 'system', label: ['システムに合わせる', 'Match system'], short: ['システム', 'System'], Icon: Monitor }
];

// 言語の切り替え
const LANG_OPTIONS: { value: Lang; label: string }[] = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' }
];

interface HeaderProps {
  currentTab: 'graph' | 'data' | 'logger' | 'video' | 'convert';
  setCurrentTab: (tab: 'graph' | 'data' | 'logger' | 'video' | 'convert') => void;
  sessions: Session[];
  selectedCars: SelectedCarSlot[];
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  playbackSpeed: number;
  onChangePlaybackSpeed: (speed: number) => void;
  onOpenFile: () => void;
  onOpenDonate?: () => void;
  // スマートフォン向けの配置 (タブは画面下のタブバーに出し、ここには再生操作とメニューだけを置く)
  compact?: boolean;
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
  onOpenDonate,
  compact = false
}) => {
  const themeSetting = useThemeSetting();
  const lang = useLang();
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  if (compact) {
    return (
      <header className="relative bg-surface-1 border-b border-line-1 text-slate-200 px-2 py-1 pt-[max(0.25rem,env(safe-area-inset-top))] flex items-center justify-between gap-2 select-none">
        <button
          onClick={onOpenFile}
          className="flex items-center gap-1.5 text-xs bg-red-600 text-white font-bold px-3 py-1.5 rounded"
        >
          <FolderOpen size={16} />
          {t('読込', 'Open')}
        </button>

        {currentTab === 'graph' && selectedCars.length > 0 && (
          <div className="flex items-center gap-1">
            <button onClick={onStepBack} aria-label={t('コマ戻し', 'Step back')} className="p-1.5 rounded text-slate-300">
              <SkipBack size={18} />
            </button>
            <button
              onClick={onTogglePlay}
              aria-label={t('再生 / 一時停止', 'Play / pause')}
              className={`p-1.5 rounded ${isPlaying ? 'bg-amber-500 text-slate-950' : 'bg-red-600 text-white'}`}
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button onClick={onStepForward} aria-label={t('コマ送り', 'Step forward')} className="p-1.5 rounded text-slate-300">
              <SkipForward size={18} />
            </button>
            <select
              value={playbackSpeed}
              onChange={e => onChangePlaybackSpeed(Number(e.target.value))}
              aria-label={t('再生速度', 'Playback speed')}
              className="bg-surface-3 border border-line-3 rounded text-xs font-mono text-slate-200 px-1 py-1.5"
            >
              {[0.5, 1, 2, 4].map(s => (
                <option key={s} value={s}>{s}x</option>
              ))}
            </select>
          </div>
        )}

        <button onClick={() => setMenuOpen(o => !o)} aria-label={t('メニュー', 'Menu')} aria-expanded={menuOpen} className="p-1.5 rounded text-slate-300 border border-line-3">
          <MoreHorizontal size={18} />
        </button>

        {/* メニュー (開発支援・テーマ)。外側をタップすると閉じる */}
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-2 top-full mt-1 z-50 w-56 bg-surface-2 border border-line-3 rounded-lg shadow-xl p-2 flex flex-col gap-1 text-sm">
              {onOpenDonate && (
                <button onClick={() => { setMenuOpen(false); onOpenDonate(); }} className="flex items-center gap-2 px-3 py-2.5 rounded text-slate-200 hover:bg-surface-4 text-left">
                  <Coffee size={16} className="text-amber-400" />
                  {t('開発支援', 'Support')}
                </button>
              )}
              <div className="border-t border-line-2 mt-1 pt-2 px-1 text-[11px] text-slate-500">{t('テーマ', 'Theme')}</div>
              <div className="flex gap-1 px-1 pb-1" role="radiogroup" aria-label={t('テーマ', 'Theme')}>
                {THEME_OPTIONS.map(({ value, label, short, Icon }) => (
                  <button
                    key={value}
                    onClick={() => setThemeSetting(value)}
                    role="radio"
                    aria-checked={themeSetting === value}
                    title={t(...label)}
                    className={`flex-1 flex flex-col items-center gap-1 py-2 rounded text-[10px] ${
                      themeSetting === value ? 'bg-surface-5 text-fg' : 'text-slate-400'
                    }`}
                  >
                    <Icon size={16} />
                    {t(...short)}
                  </button>
                ))}
              </div>
              <div className="border-t border-line-2 mt-1 pt-2 px-1 text-[11px] text-slate-500">{t('言語', 'Language')}</div>
              <div className="flex gap-1 px-1 pb-1" role="radiogroup" aria-label={t('言語', 'Language')}>
                {LANG_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setLang(value)}
                    role="radio"
                    aria-checked={lang === value}
                    className={`flex-1 py-2 rounded text-xs ${lang === value ? 'bg-surface-5 text-fg' : 'text-slate-400'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </header>
    );
  }
  return (
    <header className="bg-surface-1 border-b border-line-1 text-slate-200 px-4 py-2 flex items-center justify-between select-none">
      {/* タブ切り替え (フラットデザイン) */}
      <div className="flex bg-surface-2 p-0.5 rounded border border-line-2">
        <button
          onClick={() => setCurrentTab('graph')}
          className={`flex items-center gap-1.5 px-3.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
            currentTab === 'graph'
              ? 'bg-red-600 text-white'
              : 'text-slate-400 hover:text-slate-200 hover:bg-surface-4'
          }`}
        >
          <BarChart2 size={14} />
          {t('グラフ解析', 'Graph')}
        </button>
        <button
          onClick={() => setCurrentTab('video')}
          className={`flex items-center gap-1.5 px-3.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
            currentTab === 'video'
              ? 'bg-red-600 text-white'
              : 'text-slate-400 hover:text-slate-200 hover:bg-surface-4'
          }`}
        >
          <Video size={14} />
          {t('動画同期', 'Video')}
        </button>
        <button
          onClick={() => setCurrentTab('data')}
          className={`flex items-center gap-1.5 px-3.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
            currentTab === 'data'
              ? 'bg-red-600 text-white'
              : 'text-slate-400 hover:text-slate-200 hover:bg-surface-4'
          }`}
        >
          <List size={14} />
          {t('データ管理', 'Data')}
          {sessions.length > 0 && (
            <span className="ml-1 px-1.5 py-0.2 text-[10px] rounded bg-slate-700 text-slate-300 font-mono">
              {sessions.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setCurrentTab('convert')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
            currentTab === 'convert'
              ? 'bg-red-600 text-white'
              : 'text-slate-400 hover:text-slate-200 hover:bg-surface-4'
          }`}
        >
          <Repeat size={14} />
          {t('ログ変換', 'Convert')}
        </button>
        {/* ロガー設定は USB でつなぐので、つなげない環境 (スマートフォン・タブレット・Safari など) では出さない */}
        {canUseLoggerUsb && (
          <button
            onClick={() => setCurrentTab('logger')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
              currentTab === 'logger'
                ? 'bg-red-600 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-surface-4'
            }`}
          >
            <Settings size={14} />
            {t('ロガー設定', 'Logger')}
          </button>
        )}
      </div>

      {/* アニメーション再生コントロール (フラットデザイン) */}
      {currentTab === 'graph' && selectedCars.length > 0 && (
        <div className="hidden lg:flex items-center gap-2 bg-surface-2 px-2.5 py-1 rounded border border-line-2">
          <button
            onClick={onStepBack}
            title={t('コマ戻し (B / ←キー、Shift で 1 秒)', 'Step back (B / ← key, Shift for 1 s)')}
            className="p-1 hover:bg-surface-4 rounded text-slate-300 hover:text-fg transition-colors cursor-pointer"
          >
            <SkipBack size={14} />
          </button>
          <button
            onClick={onTogglePlay}
            title={t('再生 / 一時停止 (SPACEキー)', 'Play / pause (Space)')}
            className={`p-1.5 rounded transition-colors cursor-pointer ${
              isPlaying ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold' : 'bg-red-600 hover:bg-red-500 text-white'
            }`}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
          </button>
          <button
            onClick={onStepForward}
            title={t('コマ送り (F / →キー、Shift で 1 秒)', 'Step forward (F / → key, Shift for 1 s)')}
            className="p-1 hover:bg-surface-4 rounded text-slate-300 hover:text-fg transition-colors cursor-pointer"
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
                    : 'hover:bg-surface-4 text-slate-400'
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
        {/* ファイル読み込み */}
        <button
          onClick={onOpenFile}
          className="flex items-center gap-1.5 text-xs bg-red-600 hover:bg-red-500 text-white font-bold px-3 py-1.5 rounded transition-colors cursor-pointer"
        >
          <FolderOpen size={13} />
          {t('ファイル読込', 'Open file')}
        </button>

        {/* 開発支援 / Buy Me a Coffee */}
        {onOpenDonate && (
          <button
            onClick={onOpenDonate}
            className="flex items-center gap-1.5 text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 hover:text-amber-200 border border-amber-500/30 hover:border-amber-400/50 font-medium px-2.5 py-1.5 rounded transition-colors cursor-pointer"
            title={t('Buy Me a Coffee で開発者を支援', 'Support the developer on Buy Me a Coffee')}
          >
            <Coffee size={13} className="text-amber-400" />
            <span className="hidden sm:inline">{t('開発支援', 'Support')}</span>
          </button>
        )}

        {/* 言語 */}
        <div className="flex bg-surface-3 p-0.5 rounded border border-line-3" role="radiogroup" aria-label={t('言語', 'Language')}>
          {LANG_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setLang(value)}
              role="radio"
              aria-checked={lang === value}
              title={label}
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors cursor-pointer ${
                lang === value ? 'bg-surface-5 text-fg' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {value === 'ja' ? 'JA' : 'EN'}
            </button>
          ))}
        </div>

        {/* テーマ */}
        <div className="flex bg-surface-3 p-0.5 rounded border border-line-3" role="radiogroup" aria-label={t('テーマ', 'Theme')}>
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => setThemeSetting(value)}
              role="radio"
              aria-checked={themeSetting === value}
              title={t(...label)}
              className={`p-1 rounded transition-colors cursor-pointer ${
                themeSetting === value ? 'bg-surface-5 text-fg' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>
    </header>
  );
};
