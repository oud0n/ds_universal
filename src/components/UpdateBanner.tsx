/**
 * デスクトップ版で新しい版が見つかったときの知らせ (PLAN-44)。右下に出す。「あとで」・✕ で、開き直すまで出さない (設定の「バージョン情報」からは入れられる)
 */
import React from 'react';
import { Download, RotateCcw, X, ExternalLink } from 'lucide-react';
import { useT } from '../utils/i18n';
import { openExternalUrl } from '../utils/url';
import { desktopUpdate, useDesktopUpdate, useUpdateDismissed } from '../services/desktopUpdate';
import { releaseNotesUrl } from './AboutSettings';

export const UpdateBanner: React.FC = () => {
  const t = useT();
  const u = useDesktopUpdate();
  const dismissed = useUpdateDismissed();
  if (!u?.enabled || !u.version) return null;
  if (u.status !== 'available' && u.status !== 'downloading' && u.status !== 'ready') return null;
  if (dismissed === u.version && u.status !== 'downloading') return null;
  const primary = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-sky-600 hover:bg-sky-500 cursor-pointer';
  const plain = 'px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-line-2 hover:bg-surface-3 cursor-pointer';
  return (
    <div className="fixed right-4 bottom-4 z-[90] w-[min(360px,calc(100vw-32px))] rounded-xl bg-surface-2 border border-line-3 shadow-2xl p-3 space-y-2" role="status" data-testid="update-banner" data-status={u.status}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-slate-100">
            {u.status === 'ready' ? t(`${u.version} の準備ができました`, `${u.version} is ready`) : t(`新しい版 ${u.version} があります`, `Version ${u.version} is available`)}
          </div>
          <div className="text-[11px] text-slate-400">
            {u.status === 'available' && t(`いまの版は ${u.current} です。`, `You have ${u.current}.`)}
            {u.status === 'downloading' && t(`落としています… ${u.percent}%`, `Downloading… ${u.percent}%`)}
            {u.status === 'ready' && t('再起動すると入れ替わります (閉じたときにも入れ替わります)。', 'Restart to install (it is also installed when you quit).')}
          </div>
        </div>
        {u.status !== 'downloading' && (
          <button onClick={() => desktopUpdate.dismiss(u.version)} className="p-1 text-slate-500 hover:text-slate-300 cursor-pointer" aria-label={t('閉じる', 'Close')} data-testid="update-banner-close"><X size={16} /></button>
        )}
      </div>
      {u.status === 'downloading' && (
        <div className="h-1.5 rounded bg-surface-3 overflow-hidden"><div className="h-full bg-sky-500 transition-all" style={{ width: `${u.percent}%` }} /></div>
      )}
      {u.status !== 'downloading' && (
        <div className="flex flex-wrap gap-2 justify-end">
          <button onClick={() => openExternalUrl(releaseNotesUrl())} className={plain} data-testid="update-banner-notes">{t('変わった所', "What's new")}</button>
          {u.status === 'available' && <button onClick={() => desktopUpdate.dismiss(u.version)} className={plain} data-testid="update-banner-later">{t('あとで', 'Later')}</button>}
          {u.status === 'available' && (
            <button onClick={() => desktopUpdate.download()} className={primary} data-testid="update-banner-download">
              {u.mode === 'manual' ? <><ExternalLink size={14} />{t('ダウンロードのページ', 'Download page')}</> : <><Download size={14} />{t('入れる', 'Install')}</>}
            </button>
          )}
          {u.status === 'ready' && (
            <button onClick={() => desktopUpdate.install()} className={primary} data-testid="update-banner-install"><RotateCcw size={14} />{t('再起動して入れる', 'Restart and install')}</button>
          )}
        </div>
      )}
    </div>
  );
};
