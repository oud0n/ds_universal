import React, { useState } from 'react';
import { X, Coffee, Fuel, ExternalLink, Copy, Check, Heart, Star, Smartphone, Sparkles } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { openExternalUrl } from '../utils/url';
import { useT } from '../utils/i18n';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface DonateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/oud0n';
const GITHUB_REPO_URL = 'https://github.com/oud0n/ds_universal';

export const DonateModal: React.FC<DonateModalProps> = ({ isOpen, onClose }) => {
  const t = useT();
  const [copied, setCopied] = useState(false);

  useEscapeKey(isOpen, onClose);

  if (!isOpen) return null;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(BUY_ME_A_COFFEE_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.warn('クリップボードコピー失敗:', e);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-150"
    >
      <div className="bg-surface-2 border border-line-2 rounded-2xl w-full max-w-xl flex flex-col shadow-2xl overflow-hidden my-auto text-slate-200">
        {/* モーダルヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line-2 bg-surface-1">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-400/20 border border-amber-400/40 flex items-center justify-center text-amber-400 shadow-inner">
              <Fuel size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
                {t('開発者を支援', 'Support the developer')} <span className="text-xs font-normal text-amber-400">{t('（Buy Me a Coffee）', '(Buy Me a Coffee)')}</span>
              </h2>
              <p className="text-[11px] text-slate-400">
                {t('LapLoupe の継続的な開発・検証を応援していただけます', 'Help keep LapLoupe developed and tested')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-fg hover:bg-surface-4 transition-colors cursor-pointer"
            aria-label={t('閉じる', 'Close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* モーダル本文 */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          {/* メッセージカード */}
          <div className="bg-gradient-to-r from-surface-3 to-surface-2 border border-line-3 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
              <Sparkles size={15} className="text-amber-400" />
              <span>{t('いつもご利用ありがとうございます！', 'Thank you for using LapLoupe!')}</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              <strong className="text-fg">LapLoupe（旧名 DS Universal、ds_universal）</strong>
              {t('は、個人が休日や夜間に開発している、無料でソースコードを公開しているソフトウェアです。 デジスパイスIV実機での通信テストやサーキットでの実走ログ検証、GoPro動画同期・高精度解析機能の継続開発をサポートしていただけると大変励みになります☕🏁',
                ' is free, source-available software developed by one person on weekends and evenings. Your support for testing with a real DigSpice IV, checking logs at the track, and continued work on GoPro sync and precise analysis is a big encouragement ☕🏁')}
            </p>
          </div>

          {/* 支援方法エリア (2カラム: 左アクション / 右QRコード) */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-stretch">
            {/* 左: ボタン & URLコピー (3カラム分) */}
            <div className="md:col-span-3 flex flex-col justify-between space-y-3 bg-surface-1 border border-line-1 rounded-xl p-4">
              <div>
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  {t('PC / デスクトップから支援', 'From a PC / desktop')}
                </span>
                <p className="text-xs text-slate-300 mb-3">
                  {t('ブラウザで Buy Me a Coffee のページを開き、コーヒー1杯（$3〜）から直接支援できます。', 'Open the Buy Me a Coffee page in your browser and support directly, from the price of a coffee ($3 and up).')}
                </p>
              </div>

              {/* Buy Me a Coffee ブランドボタン */}
              <button
                onClick={() => openExternalUrl(BUY_ME_A_COFFEE_URL)}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#FFDD00] hover:bg-[#ffe333] active:bg-[#e6c700] text-black font-extrabold text-sm transition-all shadow-md hover:shadow-amber-500/20 cursor-pointer group"
              >
                <Coffee size={18} className="text-black group-hover:scale-110 transition-transform" />
                <span>{t('Buy Me a Coffee で支援する', 'Support on Buy Me a Coffee')}</span>
                <ExternalLink size={14} className="opacity-70 group-hover:opacity-100 transition-opacity ml-1" />
              </button>

              {/* URL コピー欄 */}
              <div className="pt-2">
                <span className="text-[10px] text-slate-400 block mb-1">{t('URLを直接共有・保存:', 'Share or save the URL:')}</span>
                <div className="flex items-center gap-1.5 bg-surface-2 border border-line-3 rounded-lg p-1.5 text-xs font-mono">
                  <span className="flex-1 truncate text-slate-300 px-1 select-all">
                    {BUY_ME_A_COFFEE_URL}
                  </span>
                  <button
                    onClick={handleCopyUrl}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                      copied
                        ? 'bg-emerald-600 text-white'
                        : 'bg-surface-4 hover:bg-surface-5 text-slate-200'
                    }`}
                    title={t('URLをクリップボードにコピー', 'Copy the URL to the clipboard')}
                  >
                    {copied ? (
                      <>
                        <Check size={12} />
                        <span>{t('コピー完了', 'Copied')}</span>
                      </>
                    ) : (
                      <>
                        <Copy size={12} />
                        <span>{t('コピー', 'Copy')}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* 右: スマホ用 QRコード (2カラム分) */}
            <div className="md:col-span-2 flex flex-col items-center justify-center bg-surface-1 border border-line-1 rounded-xl p-4 text-center">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-400 mb-2">
                <Smartphone size={13} className="text-amber-400" />
                <span>{t('スマホから支援', 'From a smartphone')}</span>
              </div>

              {/* QR Code */}
              <div className="p-2.5 bg-white rounded-xl shadow-lg border border-slate-300 flex items-center justify-center">
                <QRCodeSVG
                  value={BUY_ME_A_COFFEE_URL}
                  size={128}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="M"
                  includeMargin={false}
                />
              </div>

              <p className="text-[10px] text-slate-400 mt-2.5 leading-tight">
                {t('サーキット現地やピットでも、スマホカメラでスキャンして手軽に支援いただけます', 'Even at the track or in the pits, just scan with your phone camera')}
              </p>
            </div>
          </div>

          {/* ご支援金の使途 */}
          <div className="bg-surface-1 border border-line-1 rounded-xl p-4 space-y-2">
            <h4 className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Heart size={13} className="text-red-400" />
              {t('ご支援金の主な使い道', 'How support is used')}
            </h4>
            <ul className="text-xs text-slate-400 space-y-1.5 pl-1">
              <li className="flex items-start gap-2">
                <span className="text-red-400">🏁</span>
                <span>{t('サーキット走行費・ガソリン代・高速代', 'Track days, fuel and highway tolls')}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-400">📡</span>
                <span>{t('デジスパイス実機・各種ロガー・車載カメラ等の検証環境の維持', 'Keeping test hardware: DigSpice units, other loggers, onboard cameras')}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-cyan-400">💻</span>
                <span>{t('Windows / macOS (Apple Silicon) 対応・自動ビルド環境の整備', 'Windows / macOS (Apple Silicon) support and automated builds')}</span>
              </li>
            </ul>
          </div>

          {/* その他の応援方法 */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-3 py-2.5 bg-surface-2/50 rounded-xl border border-line-2 text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <Star size={15} className="text-amber-400 fill-amber-400/20" />
              <span>{t('GitHubでのStar ⭐ や不具合報告・フィードバックも大歓迎です！', 'Stars ⭐, bug reports and feedback on GitHub are very welcome too!')}</span>
            </div>
            <button
              onClick={() => openExternalUrl(GITHUB_REPO_URL)}
              className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 font-medium hover:underline cursor-pointer"
            >
              <span>{t('GitHubリポジトリ', 'GitHub repository')}</span>
              <ExternalLink size={12} />
            </button>
          </div>
        </div>

        {/* モーダルフッター */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-line-2 bg-surface-1">
          <span className="text-[11px] text-slate-400 flex items-center gap-1">
            Creator ID: <span className="font-mono font-bold text-amber-300">oud0n</span>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-line-3 text-xs text-slate-300 hover:bg-surface-4 transition-colors cursor-pointer"
          >
            {t('閉じる', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};
