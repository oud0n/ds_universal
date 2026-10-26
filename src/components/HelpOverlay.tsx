/**
 * 使い方のページ (public/help/。PLAN-39) を、今の画面の上に重ねて開く。
 * アプリの中では、アプリに入れた写しを読むので、電波がなくても読める (動画だけは公開しているページから読む。help.js)。
 * 今の画面は残したまま (閉じれば、開く前の画面に戻る)
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { appHost } from '../app/appProfile';
import type { Screen } from '../app/navPlan';
import { isAndroidApp } from '../native/bridge';
import { getLang, useT } from '../utils/i18n';
import { openExternalUrl } from '../utils/url';

/** 画面ごとに開くページ (ない画面は目次) */
const PAGE_OF: Partial<Record<Screen, string>> = {
  timer: 'b1-timer.html',
  library: 'c1-runs.html',
  analysis: 'd1-analysis.html',
  data: 'd2-compare.html',
  video: 'e1-video.html',
  logger: 'a2-devices.html',
  settings: 'a1-start.html'
};

let open: string | null = null;
const listeners = new Set<() => void>();
const set = (v: string | null) => { open = v; listeners.forEach(f => f()); };

/** 使い方を開く (screen を渡すと、その画面のページ。渡さなければ目次) */
export function openHelp(screen?: Screen): void {
  set(PAGE_OF[screen as Screen] ?? 'index.html');
}

function helpDevice(): string {
  const host = appHost();
  if (host === 'native') return isAndroidApp() ? 'android' : 'iphone';
  return host === 'electron' ? 'desktop' : 'browser';
}

function helpUrl(page: string): string {
  return `${import.meta.env.BASE_URL}help/${page}?device=${helpDevice()}&lang=${getLang() === 'en' ? 'en' : 'ja'}`;
}

export const HelpOverlay: React.FC = () => {
  const t = useT();
  const page = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => open);
  useEffect(() => {
    if (!page) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') set(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page]);
  if (!page) return null;
  const url = helpUrl(page);
  return (
    <div className="fixed inset-0 z-[200] bg-black/60 flex items-stretch justify-center sm:p-4" data-testid="help-overlay">
      <div className="w-full max-w-3xl flex flex-col bg-surface-1 sm:border border-line-2 sm:rounded-xl overflow-hidden shadow-2xl"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line-2">
          <span className="flex-1 text-sm font-bold text-slate-100">{t('使い方', 'Guide')}</span>
          {/* ブラウザで開く (デスクトップ版・ブラウザ版。アプリの中では、公開しているページを Safari などで) */}
          <button
            onClick={() => openExternalUrl(appHost() === 'native' ? `https://oud0n.github.io/ds_universal/help/${page}` : new URL(url, window.location.href).href)}
            className="p-2 rounded text-slate-400 hover:text-slate-200 cursor-pointer" title={t('ブラウザで開く', 'Open in browser')} aria-label={t('ブラウザで開く', 'Open in browser')}
          ><ExternalLink size={16} /></button>
          <button onClick={() => set(null)} className="p-2 rounded text-slate-300 hover:text-white cursor-pointer" aria-label={t('閉じる', 'Close')} data-testid="help-close"><X size={18} /></button>
        </div>
        <iframe src={url} title={t('使い方', 'Guide')} className="flex-1 w-full border-0 bg-surface-0" data-testid="help-frame" />
      </div>
    </div>
  );
};
