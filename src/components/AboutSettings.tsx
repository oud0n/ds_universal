/**
 * 設定の「バージョン情報」(PLAN-44、2026-11-02)。版の番号・更新の記録。デスクトップ版は更新の確かめと入れ替え
 */
import React from 'react';
import { RefreshCw, ScrollText, Download, RotateCcw, ExternalLink } from 'lucide-react';
import { useT, getLang } from '../utils/i18n';
import { openExternalUrl } from '../utils/url';
import { hasNative, isAndroidApp } from '../native/bridge';
import { desktopUpdate, useAppVersion, useDesktopUpdate } from '../services/desktopUpdate';

const REPO = 'https://github.com/oud0n/ds_universal';
export const releaseNotesUrl = () => `${REPO}/blob/main/docs/${getLang() === 'en' ? 'release-notes.en.md' : 'release-notes.md'}`;

/** どの形で動いているか */
function useEdition(): [string, string] {
  if (typeof window !== 'undefined' && window.electronAPI) {
    const mac = /Mac/i.test(navigator.userAgent);
    return mac ? ['デスクトップ版 (Mac)', 'Desktop app (Mac)'] : ['デスクトップ版 (Windows)', 'Desktop app (Windows)'];
  }
  if (hasNative()) return isAndroidApp() ? ['Android のアプリ (試験版)', 'Android app (test)'] : ['iPhone・iPad のアプリ', 'iPhone / iPad app'];
  return ['ブラウザ版', 'Browser version'];
}

const btn = 'flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm border cursor-pointer disabled:opacity-50 disabled:cursor-default';

export const AboutSettings: React.FC = () => {
  const t = useT();
  const version = useAppVersion();
  const edition = useEdition();
  const update = useDesktopUpdate();
  return (
    <section className="space-y-2" data-testid="about-settings">
      <h3 className="text-xs text-slate-500 px-1">{t('バージョン情報', 'About')}</h3>
      <div className="rounded-xl bg-surface-1 border border-line-2 p-4 space-y-3">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-base font-bold text-slate-100">LapLoupe</span>
          <span className="font-mono text-sm text-slate-200" data-testid="about-version">{version}</span>
          <span className="text-xs text-slate-500">{t(...edition)}</span>
        </div>
        {update && <UpdateRow update={update} />}
        {!update && !hasNative() && !(typeof window !== 'undefined' && window.electronAPI) && (
          <p className="text-[11px] text-slate-500">{t('ブラウザ版は、開き直すといつも新しい版になります。', 'The browser version is always the latest when you reload it.')}</p>
        )}
        {hasNative() && !isAndroidApp() && (
          <p className="text-[11px] text-slate-500">{t('新しい版は App Store から入ります。', 'New versions come from the App Store.')}</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => openExternalUrl(releaseNotesUrl())} className={`${btn} border-line-2 text-slate-300 hover:bg-surface-3`} data-testid="about-release-notes">
            <ScrollText size={15} />{t('更新の記録', 'Release notes')}
          </button>
          <button onClick={() => openExternalUrl(REPO)} className={`${btn} border-line-2 text-slate-300 hover:bg-surface-3`} data-testid="about-github">
            <ExternalLink size={15} />GitHub
          </button>
        </div>
      </div>
    </section>
  );
};

/** 更新の状態と操作 (デスクトップ版) */
const UpdateRow: React.FC<{ update: DesktopUpdateState }> = ({ update: u }) => {
  const t = useT();
  if (!u.enabled) {
    return <p className="text-[11px] text-slate-500" data-testid="about-update-off">{t('この版は、新しい版を確かめません (手元で作った版)。', 'This build does not check for updates (built locally).')}</p>;
  }
  const checkedAt = u.checkedAt ? new Date(u.checkedAt).toLocaleString() : null;
  return (
    <div className="space-y-2" data-testid="about-update" data-status={u.status}>
      <p className={`text-sm ${u.status === 'available' || u.status === 'ready' ? 'text-sky-300' : u.status === 'error' ? 'text-amber-400' : 'text-slate-300'}`} data-testid="about-update-status">
        {u.status === 'checking' && t('新しい版を確かめています…', 'Checking for updates…')}
        {u.status === 'none' && t('いまの版が最新です。', 'You have the latest version.')}
        {u.status === 'idle' && (u.autoCheck ? t('新しい版は、起動したときに確かめます。', 'Updates are checked when the app starts.') : t('新しい版は、ボタンを押したときだけ確かめます。', 'Updates are checked only when you press the button.'))}
        {u.status === 'available' && t(`新しい版 ${u.version} があります。`, `Version ${u.version} is available.`)}
        {u.status === 'downloading' && t(`新しい版 ${u.version ?? ''} を落としています… ${u.percent}%`, `Downloading ${u.version ?? ''}… ${u.percent}%`)}
        {u.status === 'ready' && t(`新しい版 ${u.version} の準備ができました。閉じたときにも入れ替わります。`, `Version ${u.version} is ready. It is also installed when you quit.`)}
        {u.status === 'error' && t('新しい版を確かめられませんでした (インターネットにつながっていないかもしれません)。', 'Could not check for updates (you may be offline).')}
      </p>
      {u.status === 'downloading' && (
        <div className="h-1.5 rounded bg-surface-3 overflow-hidden"><div className="h-full bg-sky-500 transition-all" style={{ width: `${u.percent}%` }} /></div>
      )}
      {u.status === 'available' && u.mode === 'manual' && (
        <p className="text-[11px] text-slate-500" data-testid="about-update-manual">
          {/Mac/i.test(navigator.userAgent)
            ? t('「アプリケーション」フォルダの外で開いているので、自動では入れ替えられません。ダウンロードのページから入れ直してください (アプリを「アプリケーション」に移すと、次から自動で入れ替わります)。', 'The app is not in the Applications folder, so it cannot replace itself. Install it again from the download page (move the app to Applications to update automatically next time).')
            : t('zip 版 (入れずに使う形) は、自動では入れ替えられません。ダウンロードのページから入れ直してください。', 'The zip (portable) version cannot replace itself. Download it again from the download page.')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {u.status === 'available' && (
          <button onClick={() => desktopUpdate.download()} className={`${btn} border-sky-600 bg-sky-600 text-white hover:bg-sky-500 font-bold`} data-testid="about-update-download">
            {u.mode === 'manual' ? <><ExternalLink size={15} />{t('ダウンロードのページ', 'Download page')}</> : <><Download size={15} />{t('入れる', 'Install')}</>}
          </button>
        )}
        {u.status === 'ready' && (
          <button onClick={() => desktopUpdate.install()} className={`${btn} border-sky-600 bg-sky-600 text-white hover:bg-sky-500 font-bold`} data-testid="about-update-install">
            <RotateCcw size={15} />{t('再起動して入れる', 'Restart and install')}
          </button>
        )}
        {(u.status === 'none' || u.status === 'idle' || u.status === 'error') && (
          <button onClick={() => desktopUpdate.check()} className={`${btn} border-line-2 text-slate-300 hover:bg-surface-3`} data-testid="about-update-check">
            <RefreshCw size={15} />{t('新しい版を確かめる', 'Check for updates')}
          </button>
        )}
      </div>
      {checkedAt && u.status !== 'checking' && <p className="text-[10px] text-slate-500">{t(`確かめた時刻: ${checkedAt}`, `Last checked: ${checkedAt}`)}</p>}
      <label className="flex items-start gap-2.5 pt-1 text-sm text-slate-200 cursor-pointer">
        <input type="checkbox" checked={u.autoCheck} onChange={e => desktopUpdate.setAutoCheck(e.target.checked)} className="mt-0.5 w-4 h-4 accent-sky-600" data-testid="about-update-auto" />
        <span className="flex-1">
          {t('起動したときに新しい版を確かめる', 'Check for updates when the app starts')}
          <span className="block text-[11px] text-slate-500">{t('GitHub の新しい版の番号を読むだけで、ログ・設定は送りません。切ると、上のボタンを押したときだけ通信します。', 'It only reads the latest version number from GitHub; no logs or settings are sent. When off, it connects only when you press the button above.')}</span>
        </span>
      </label>
    </div>
  );
};
