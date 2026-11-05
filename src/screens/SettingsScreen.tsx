import React from 'react';
import { ChevronRight, Fuel, Download, CircleHelp } from 'lucide-react';
import { openHelp } from '../components/HelpOverlay';
import { setThemeSetting, useThemeSetting } from '../utils/theme';
import { setLangSetting, useLangSetting, useT } from '../utils/i18n';
import { desktopDownloadUrl, isBrowserVersionOnPc } from '../utils/desktopApp';
import { openExternalUrl } from '../utils/url';
import { LANG_OPTIONS, THEME_OPTIONS, showLangSwitch } from '../components/Header';
import type { NavPlan } from '../app/navPlan';
import { navStore } from '../app/navStore';
import { SCREEN_META, screenLabel } from '../app/screenMeta';
import { StorageSettings } from '../components/StorageSettings';
import { CsvFormatSettings } from '../components/CsvFormatSettings';
import { CourseDataSettings } from '../components/CourseDataSettings';
import { getWriteBon4, setWriteBon4 } from '../services/runFormatSettings';
import { hasNative } from '../native/bridge';
import { AnalysisSettings, VideoSettings } from '../components/AnalysisSettings';
import { AboutSettings } from '../components/AboutSettings';
import { addons } from '../addons';

/** 設定の分類の見出しとまとまり (PLAN-42、2026-11-01) */
const Group: React.FC<{ title: string; testId: string; children: React.ReactNode }> = ({ title, testId, children }) => (
  <section className="space-y-3" data-testid={testId}>
    <h2 className="text-sm font-bold text-slate-200 px-1 pt-1 border-b border-line-2 pb-1.5">{title}</h2>
    {children}
  </section>
);

/**
 * 設定 (⚙)。2026-10-21 (PLAN-24 の 2)。2026-11-01 (PLAN-42) から分類ごとに見出しで分け、画面の中にあった
 * 一度決めたらあまり変えない設定 (G のならし方・G の出どころ・動画の GPS をログに加えるか) もここに移した
 */
export const SettingsScreen: React.FC<{
  plan: NavPlan;
  onOpenDonate?: () => void;
  /** コースのデータ (一括設置)。無ければ出さない */
  courseData?: React.ComponentProps<typeof CourseDataSettings>;
  /** 解析の設定 (G のならし方・G の出どころ) */
  analysis?: React.ComponentProps<typeof AnalysisSettings>;
}> = ({ plan, onOpenDonate, courseData, analysis }) => {
  const t = useT();
  const theme = useThemeSetting();
  const lang = useLangSetting();
  // サイドバーの組み方では、サイドバーの下に同じものがあるので並べない
  // データは解析の「走行とコース」から開く
  const rows = plan.chrome === 'sidebar' ? [] : plan.more.filter(s => s !== 'settings' && s !== 'data');
  return (
    <div className="h-full overflow-y-auto" data-testid="settings-screen">
      <div className="max-w-lg mx-auto p-3 space-y-7">
        <Group title={t('保管場所とファイル', 'Storage and files')} testId="settings-group-storage">
          <StorageSettings />
          {hasNative() && <RunFormatSetting />}
        </Group>
        <Group title={t('コースとデータの形式', 'Courses and data formats')} testId="settings-group-data">
          {courseData && <CourseDataSettings {...courseData} />}
          <CsvFormatSettings />
        </Group>
        {analysis && (
          <Group title={t('解析', 'Analysis')} testId="settings-group-analysis">
            <AnalysisSettings {...analysis} />
          </Group>
        )}
        <Group title={t('動画', 'Video')} testId="settings-group-video">
          <VideoSettings />
        </Group>
        <Group title={t('表示', 'Display')} testId="settings-group-display">

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
                className={`flex flex-col items-center gap-1 py-2.5 px-0.5 rounded-lg text-[10px] min-[400px]:text-[11px] whitespace-nowrap border cursor-pointer ${
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
        </Group>

        {addons.settingsSections?.map(({ id, label, Component }) => (
          <Group key={id} title={t(...label)} testId={`settings-group-${id}`}>
            <Component />
          </Group>
        ))}
        <Group title={t('その他', 'Other')} testId="settings-group-other">
        {rows.length > 0 && (
          <section className="rounded-xl bg-surface-1 border border-line-2 overflow-hidden">
            {rows.map((s, i) => {
              const { Icon } = SCREEN_META[s];
              const label = screenLabel(s);
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
        <section className="flex flex-col gap-2">
          <button onClick={() => openHelp()} className="flex items-center gap-2 px-4 py-3 rounded-xl bg-surface-2 border border-line-2 text-slate-200 text-sm cursor-pointer" data-testid="settings-help">
            <CircleHelp size={16} />{t('使い方 (操作の説明と動画)', 'Guide (how-tos and videos)')}
          </button>
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
        <AboutSettings />
        </Group>
      </div>
    </div>
  );
};

/** 走行のファイルの形式: .bon4 も書くか (走行の基準は .nmea) */
const RunFormatSetting: React.FC = () => {
  const t = useT();
  const [on, setOn] = React.useState(getWriteBon4);
  return (
    <section className="space-y-2" data-testid="run-format-setting">
      <h3 className="text-xs text-slate-500 px-1">{t('走行のファイル', 'Run files')}</h3>
      <label className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-1 border border-line-2 text-sm text-slate-200 cursor-pointer">
        <input type="checkbox" checked={on} onChange={e => { setOn(e.target.checked); setWriteBon4(e.target.checked); }} className="w-5 h-5 accent-sky-600" />
        <span className="flex-1">{t('デジスパイスの公式ソフト用の .bon4 も書く', 'Also write .bon4 for the official DigSpice software')}</span>
      </label>
      <p className="text-[11px] text-slate-500 px-1">{t('走行はいつも .nmea で記録します (ほかのアプリでも読める形)。次に測り始めた走行から変わります。', 'Runs are always recorded as .nmea (readable by other apps). Applies from the next run.')}</p>
    </section>
  );
};
