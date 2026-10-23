import React, { useEffect, useState } from 'react';
import { X, Fuel, Heart, Loader2 } from 'lucide-react';
import { useT } from '../utils/i18n';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { buyTip, loadTips, tipLiters } from '../services/tips';
import type { IapProduct } from '../native/contract';

/**
 * 投げ銭 (iPhone のアプリ。アプリ内課金のガソリン 1L・5L・10L)。
 * 何も解放しないことをはっきり書く (審査の決まり 2.3・3.1.1)。パソコン版・ブラウザ版は DonateModal (Buy Me a Coffee)
 */
export const TipModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const t = useT();
  const [products, setProducts] = useState<IapProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [result, setResult] = useState<{ liters: number; status: 'purchased' | 'pending' } | null>(null);

  useEscapeKey(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    setResult(null);
    setError(null);
    let cancelled = false;
    loadTips().then(
      list => { if (!cancelled) setProducts(list); },
      e => { if (!cancelled) { setProducts([]); setError(e instanceof Error ? e.message : String(e)); } }
    );
    return () => { cancelled = true; };
  }, [isOpen]);

  if (!isOpen) return null;

  const buy = async (p: IapProduct) => {
    setBuying(p.id);
    setError(null);
    try {
      const status = await buyTip(p.id);
      if (status !== 'cancelled') setResult({ liters: tipLiters(p.id), status });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuying(null);
    }
  };

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
      data-testid="tip-modal"
    >
      <div className="bg-surface-2 border border-line-2 rounded-2xl w-full max-w-md flex flex-col shadow-2xl overflow-hidden my-auto text-slate-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-2 bg-surface-1">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-400/20 border border-amber-400/40 flex items-center justify-center text-amber-400">
              <Fuel size={18} />
            </div>
            <h2 className="text-sm font-bold text-slate-100">{t('ガソリン代で応援する', 'Tip with fuel money')}</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-fg hover:bg-surface-4 cursor-pointer" aria-label={t('閉じる', 'Close')}>
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-300 leading-relaxed">
            {t('LapLoupe は、個人が休日や夜に作っている無料のアプリです。サーキットでの試験や開発のガソリン代を、投げ銭で応援していただけると励みになります。',
              'LapLoupe is a free app made by one person on weekends and evenings. A tip towards the fuel for track testing and development keeps it going.')}
          </p>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            {t('投げ銭をしても、機能は増えません (すべての機能は無料で使えます)。ガソリンが届くこともありません。',
              'Tipping does not unlock anything (every feature is free), and no fuel is delivered.')}
          </p>

          {result ? (
            <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-4 text-center space-y-1" data-testid="tip-thanks">
              <Heart size={22} className="mx-auto text-rose-400" />
              <div className="text-sm font-bold text-slate-100">
                {result.status === 'purchased'
                  ? t(`ガソリン ${result.liters}L 分、ありがとうございます！`, `Thank you for ${result.liters} L of fuel!`)
                  : t('購入の承認を待っています。承認されると完了します。', 'The purchase is waiting for approval and will finish once approved.')}
              </div>
            </div>
          ) : products === null ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" />{t('読み込んでいます…', 'Loading…')}</div>
          ) : products.length === 0 ? (
            <div className="text-xs text-amber-400 py-4 text-center">{t('今は投げ銭を読み込めませんでした。あとでもう一度お試しください。', 'Tips could not be loaded right now. Please try again later.')}</div>
          ) : (
            <div className="space-y-2">
              {products.map(p => (
                <button
                  key={p.id}
                  onClick={() => void buy(p)}
                  disabled={buying !== null}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-line-3 bg-surface-1 hover:bg-surface-3 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  data-testid="tip-buy"
                >
                  <span className="flex items-center gap-2 text-sm font-bold text-slate-100">
                    <Fuel size={16} className="text-amber-400 shrink-0" />
                    {t(`ガソリン ${tipLiters(p.id)}L`, `${tipLiters(p.id)} L of fuel`)}
                  </span>
                  <span className="flex items-center gap-1.5 text-sm font-mono font-bold text-amber-300 whitespace-nowrap">
                    {buying === p.id && <Loader2 size={14} className="animate-spin" />}
                    {p.displayPrice}
                  </span>
                </button>
              ))}
            </div>
          )}
          {error && <div className="text-[11px] text-amber-400 break-words">{t(`うまくいきませんでした: ${error}`, `Something went wrong: ${error}`)}</div>}
        </div>
      </div>
    </div>
  );
};
