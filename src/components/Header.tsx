import React from 'react';
import { FolderOpen, Fuel, Sun, Moon, Monitor, Contrast, Download, SlidersHorizontal, ChevronLeft, List } from 'lucide-react';
import type { ThemeSetting } from '../utils/theme';
import { BleStatusPill } from './BleLoggerCard';
import { useT, type LangSetting } from '../utils/i18n';
import type { NavPlan, Screen } from '../app/navPlan';
import { SCREEN_META, screenLabel } from '../app/screenMeta';
import { navStore } from '../app/navStore';
import { hasNative } from '../native/bridge';
import { desktopDownloadUrl, isBrowserVersionOnPc } from '../utils/desktopApp';
import { openExternalUrl } from '../utils/url';

// テーマの切り替え (ライト / ダーク / システムに合わせる)
export const THEME_OPTIONS: { value: ThemeSetting; label: [string, string]; short: [string, string]; Icon: typeof Sun }[] = [
  { value: 'light', label: ['ライトモード', 'Light mode'], short: ['ライト', 'Light'], Icon: Sun },
  { value: 'dark', label: ['ダークモード', 'Dark mode'], short: ['ダーク', 'Dark'], Icon: Moon },
  { value: 'system', label: ['システムに合わせる', 'Match system'], short: ['システム', 'System'], Icon: Monitor },
  { value: 'contrast', label: ['ハイコントラスト (屋外の日差しの下で見やすい)', 'High contrast (easier to read in sunlight)'], short: ['高コントラスト', 'Contrast'], Icon: Contrast }
];

// 言語の切り替え (ふだんは端末の言語に合わせるので、目立たない所に置く。
// iPhone のアプリは、設定アプリでアプリごとに言語を選べるので出さない)
export const LANG_OPTIONS: { value: LangSetting; label: [string, string] }[] = [
  { value: 'auto', label: ['自動 (端末の言語)', 'Auto (device language)'] },
  { value: 'ja', label: ['日本語', '日本語'] },
  { value: 'en', label: ['English', 'English'] }
];
export const showLangSwitch = !hasNative();

interface HeaderProps {
  plan: NavPlan;
  screen: Screen;
  /** 画面の印に出す数 (データ管理: 読み込んだログの数) */
  badges?: Partial<Record<Screen, number>>;
  onOpenFile: () => void;
  onOpenDonate?: () => void;
  // スマートフォン向けの配置 (タブは画面下のタブバーに出し、ここには読み込みと ⚙ だけを置く)
  compact?: boolean;
  /** 解析の「走行とコース」の引き出しを開いているか・開け閉めする */
  dataOpen?: boolean;
  onToggleData?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  plan,
  screen,
  badges,
  onOpenFile,
  onOpenDonate,
  compact = false,
  dataOpen = false,
  onToggleData
}) => {
  const t = useT();
  // ⚙ の中の画面 (タブ・サイドバーに並ばない画面) を出しているときは、戻るボタンを出す
  const secondary = !plan.primary.includes(screen);
  const go = (s: Screen) => navStore.go(s);
  // ⚙: 設定を開く。設定を出しているときは閉じる (来た画面へ戻る)
  const toggleSettings = () => (screen === 'settings' ? navStore.back() : go('settings'));
  // 解析の画面の「走行とコース」(読み込んだ走行・Car の割り当て・コース・補正)
  const dataButton = screen === 'analysis' && onToggleData && (
    <button
      onClick={onToggleData}
      aria-pressed={dataOpen}
      className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded border cursor-pointer whitespace-nowrap ${dataOpen ? 'bg-sky-600 text-white border-sky-500' : 'text-slate-300 border-line-3 hover:bg-surface-3'}`}
      data-testid="toggle-data-drawer"
    >
      <List size={compact ? 16 : 14} />
      {t('走行とコース', 'Runs & course')}
      {!!badges?.data && <span className="px-1.5 text-[10px] rounded bg-slate-700 text-slate-300 font-mono">{badges.data}</span>}
    </button>
  );

  if (compact) {
    return (
      <header className="relative bg-surface-1 border-b border-line-1 text-slate-200 px-2 py-1 pt-[max(0.25rem,env(safe-area-inset-top))] flex items-center justify-between gap-2 select-none">
        {secondary && screen !== 'settings' ? (
          <button onClick={() => navStore.back()} className="flex items-center gap-1 text-sm text-slate-200 px-1 py-1.5 rounded" data-testid="nav-back">
            <ChevronLeft size={18} />
            {t(...screenLabel(screen))}
          </button>
        ) : screen === 'library' || screen === 'settings' ? (
          <span className="text-sm font-bold text-slate-200 px-1">{t(...screenLabel(screen))}</span>
        ) : (
          <button
            onClick={onOpenFile}
            className="flex items-center gap-1.5 text-xs bg-red-600 text-white font-bold px-3 py-1.5 rounded whitespace-nowrap"
          >
            <FolderOpen size={16} />
            {t('開く', 'Open')}
          </button>
        )}

        {dataButton}

        {/* 右: つなぎの状態と ⚙ (状態を真ん中に置くと、名前の長さで位置がずれて見えるため右に寄せる) */}
        <div className="flex items-center gap-2 min-w-0">
          {plan.available.has('logger') && <BleStatusPill onClick={() => go('logger')} />}
          {/* 設定の画面でも同じ場所に出す (消すと左の印の位置がずれるため)。設定の画面では押した状態 */}
          <button
            onClick={toggleSettings}
            aria-label={t('設定', 'Settings')}
            aria-current={screen === 'settings' ? 'page' : undefined}
            className={`p-1.5 rounded border border-line-3 shrink-0 ${screen === 'settings' ? 'bg-surface-5 text-fg' : 'text-slate-300'}`}
            data-testid="nav-settings"
          >
            <SlidersHorizontal size={18} />
          </button>
        </div>
      </header>
    );
  }
  return (
    <header className="bg-surface-1 border-b border-line-1 text-slate-200 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] flex items-center justify-between select-none">
      {/* タブ切り替え (ブラウザ版。デスクトップ版・iPad は左のサイドバー) */}
      {/* ウインドウが狭いときは、タブの名前を隠してアイコンだけにする (名前が 2 行に折り返さないように) */}
      {plan.chrome === 'top' ? (
        <div className="flex min-w-0 bg-surface-2 p-0.5 rounded border border-line-2">
          {plan.primary.map(id => {
            const { Icon } = SCREEN_META[id];
    const label = screenLabel(id);
            const badge = badges?.[id];
            return (
              <button
                key={id}
                onClick={() => go(id)}
                title={t(...label)}
                aria-label={badge ? `${t(...label)} (${badge})` : t(...label)}
                aria-current={screen === id ? 'page' : undefined}
                className={`flex items-center gap-1.5 px-3.5 py-1 rounded text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  screen === id
                    ? 'bg-red-600 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-surface-4'
                }`}
                data-testid={`nav-${id}`}
              >
                <Icon size={14} />
                <span className="hidden lg:inline">{t(...label)}</span>
                {!!badge && (
                  <span className="ml-1 px-1.5 py-0.2 text-[10px] rounded bg-slate-700 text-slate-300 font-mono">{badge}</span>
                )}
              </button>
            );
          })}
          {plan.available.has('logger') && <span className="ml-2 self-center"><BleStatusPill onClick={() => go('logger')} /></span>}
          {dataButton && <span className="ml-2 self-center">{dataButton}</span>}
        </div>
      ) : (
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-bold text-slate-200 truncate">{t(...screenLabel(screen))}</span>
          {dataButton}
          {plan.available.has('logger') && <BleStatusPill onClick={() => go('logger')} />}
        </div>
      )}

      {/* 再生・シークは、グラフ解析の下の段 (PlayBar) に置く */}

      {/* ファイル操作 (フラットデザイン) */}
      <div className="flex items-center gap-2 shrink-0 ml-2">
        {/* ファイルを開く (走行・設定の画面では出さない。走行の画面には下に同じボタンがある) */}
        {screen !== 'library' && screen !== 'settings' && (
          <button
            onClick={onOpenFile}
            className="flex items-center gap-1.5 text-xs bg-red-600 hover:bg-red-500 text-white font-bold px-3 py-1.5 rounded whitespace-nowrap transition-colors cursor-pointer"
            title={t('ファイルを開く', 'Open file')}
            aria-label={t('ファイルを開く', 'Open file')}
          >
            <FolderOpen size={13} />
            <span className="hidden md:inline">{t('ファイルを開く', 'Open file')}</span>
          </button>
        )}

        {/* デスクトップ版の案内 (パソコンのブラウザ版だけ。デスクトップ版・iPhone アプリの中では出さない) */}
        {isBrowserVersionOnPc() && (
          <button
            onClick={() => openExternalUrl(desktopDownloadUrl())}
            className="flex items-center gap-1.5 text-xs bg-surface-3 hover:bg-surface-4 text-slate-300 hover:text-fg border border-line-3 font-medium px-2.5 py-1.5 rounded transition-colors cursor-pointer"
            title={t('デスクトップ版（Mac・Windows）のダウンロード', 'Download the desktop app (Mac / Windows)')}
            aria-label={t('デスクトップ版', 'Desktop app')}
          >
            <Download size={13} />
            <span className="hidden xl:inline whitespace-nowrap">{t('デスクトップ版', 'Desktop app')}</span>
          </button>
        )}

        {/* 開発支援 / Buy Me a Coffee (サイドバーの組み方では設定の画面にあるので出さない) */}
        {onOpenDonate && plan.chrome !== 'sidebar' && (
          <button
            onClick={onOpenDonate}
            className="flex items-center gap-1.5 text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 hover:text-amber-200 border border-amber-500/30 hover:border-amber-400/50 font-medium px-2.5 py-1.5 rounded transition-colors cursor-pointer"
            title={t('Buy Me a Coffee で開発者を支援', 'Support the developer on Buy Me a Coffee')}
            aria-label={t('開発支援', 'Support')}
          >
            <Fuel size={13} className="text-amber-400" />
            <span className="hidden xl:inline whitespace-nowrap">{t('開発支援', 'Support')}</span>
          </button>
        )}

        {plan.chrome === 'top' && (
          <button
            onClick={toggleSettings}
            title={t('設定', 'Settings')}
            aria-label={t('設定', 'Settings')}
            className={`p-1.5 rounded border border-line-3 cursor-pointer ${screen === 'settings' ? 'bg-surface-5 text-fg' : 'text-slate-400 hover:text-slate-200'}`}
            data-testid="nav-settings"
          >
            <SlidersHorizontal size={14} />
          </button>
        )}
      </div>
    </header>
  );
};
