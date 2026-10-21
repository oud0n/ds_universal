import React from 'react';
import { ChevronRight, Fuel, Download } from 'lucide-react';
import { setThemeSetting, useThemeSetting } from '../utils/theme';
import { setLangSetting, useLangSetting, useT } from '../utils/i18n';
import { desktopDownloadUrl, isBrowserVersionOnPc } from '../utils/desktopApp';
import { openExternalUrl } from '../utils/url';
import { LANG_OPTIONS, THEME_OPTIONS, showLangSwitch } from '../components/Header';
import type { NavPlan } from '../app/navPlan';
import { navStore } from '../app/navStore';
import { SCREEN_META } from '../app/screenMeta';
import { StorageSettings } from '../components/StorageSettings';

/**
 * 設定 (⚙)。2026-10-21 (PLAN-24 の 2)。今は、タブに並ばない画面 (データ管理・変換・ロガーなど) への入口と、テーマ・言語・開発支援。
 * 作る順番の 3 で、保管場所・機器の登録・単位などをここに足す
 */
export const SettingsScreen: React.FC<{ plan: NavPlan; onOpenDonate?: () => void }> = ({ plan, onOpenDonate }) => {
  const t = useT();
  const theme = useThemeSetting();
  const lang = useLangSetting();
  const rows = plan.more.filter(s => s !== 'settings');
  return (
    <div className="h-full overflow-y-auto" data-testid="settings-screen">
      <div className="max-w-lg mx-auto p-3 space-y-5">
        <StorageSettings />
        {rows.length > 0 && (
          <section className="rounded-xl bg-surface-1 border border-line-2 overflow-hidden">
            {rows.map((s, i) => {
              const { label, Icon } = SCREEN_META[s];
              return (
                <button
                  key={s}
                  onClick={() => navStore.go(s)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 text-left text-sm text-slate-200 hover:bg-surface-3 cursor-pointer ${i > 0 ? 'border-t border-line-2' : ''}`}
                  data-testid={`settings-go-${s}`}
                >
                  <Icon size={18} className="text-slate-400" />
                  <span className="flex-1">{t(...label)}</span>
                  <ChevronRight size={16} className="text-slate-500" />
                </button>
              );
            })}
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-xs text-slate-500 px-1">{t('テーマ', 'Theme')}</h3>
          <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label={t('テーマ', 'Theme')}>
            {THEME_OPTIONS.map(({ value, label, short, Icon }) => (
              <button
                key={value}
                onClick={() => setThemeSetting(value)}
                role="radio"
                aria-checked={theme === value}
                title={t(...label)}
                className={`flex flex-col items-center gap-1 py-2.5 rounded-lg text-[11px] border cursor-pointer ${
                  theme === value ? 'bg-surface-5 text-fg border-line-3' : 'text-slate-400 border-line-2 hover:bg-surface-3'
                }`}
              >
                <Icon size={18} />
                {t(...short)}
              </button>
            ))}
          </div>
        </section>

        {showLangSwitch && (
          <section className="space-y-2">
            <h3 className="text-xs text-slate-500 px-1">{t('言語', 'Language')}</h3>
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t('言語', 'Language')}>
              {LANG_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setLangSetting(value)}
                  role="radio"
                  aria-checked={lang === value}
                  className={`py-2.5 rounded-lg text-xs border cursor-pointer ${lang === value ? 'bg-surface-5 text-fg border-line-3' : 'text-slate-400 border-line-2 hover:bg-surface-3'}`}
                >
                  {value === 'auto' ? t('自動', 'Auto') : t(...label)}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2">
          {onOpenDonate && (
            <button onClick={onOpenDonate} className="flex items-center gap-2 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm cursor-pointer">
              <Fuel size={16} />{t('開発支援', 'Support')}
            </button>
          )}
          {isBrowserVersionOnPc() && (
            <button onClick={() => openExternalUrl(desktopDownloadUrl())} className="flex items-center gap-2 px-4 py-3 rounded-xl bg-surface-2 border border-line-2 text-slate-300 text-sm cursor-pointer">
              <Download size={16} />{t('デスクトップ版（Mac・Windows）のダウンロード', 'Download the desktop app (Mac / Windows)')}
            </button>
          )}
        </section>
      </div>
    </div>
  );
};
