import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import { circuitLabel, useT } from '../../utils/i18n';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import type { ImportPart, ImportPlan } from '../../services/import/importPlan';
import type { PartResult } from '../../services/import/importApply';

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const md = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };

/** 速さの折れ線 (分け目を見るため) */
const Sparkline: React.FC<{ values: number[]; color: string }> = ({ values, color }) => {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${24 - (v / max) * 22}`).join(' ');
  return (
    <svg viewBox="0 0 100 26" preserveAspectRatio="none" className="w-full h-6">
      <polyline fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" points={pts} />
    </svg>
  );
};

/**
 * 取り込みの確認 (2026-10-21、PLAN-24 の D15〜D17)。1 本のログを、走行ごと・場所ごとに分けた案を並べ、印の付いたものを保管場所に書く。
 * スマートフォンでは画面いっぱい、広い画面では真ん中のシート
 */
export const ImportSheet: React.FC<{
  plan: ImportPlan;
  /** 書いている最中か・書き終えた結果 */
  phase: 'confirm' | 'writing' | 'done';
  progress?: { done: number; total: number };
  results?: PartResult[];
  onToggle: (id: string) => void;
  onApply: () => void;
  /** 取り込まずに、今だけ開く */
  onOpenOnly: () => void;
  /** 取り込んだあと、解析で開く */
  onOpenAfter?: () => void;
  onClose: () => void;
}> = ({ plan, phase, progress, results, onToggle, onApply, onOpenOnly, onOpenAfter, onClose }) => {
  const t = useT();
  useEscapeKey(phase !== 'writing', onClose);
  const checked = plan.parts.filter(p => p.checked).length;
  const circuits = new Set(plan.parts.filter(p => p.dest.kind === 'circuit').map(p => p.course?.id)).size;
  const label = (p: ImportPart) => {
    if (p.kind === 'transit') return t('移動 (コースの外)', 'Transit (off course)');
    if (p.kind === 'unknown') return t('知らない場所 (計測線を自動で置ける)', 'Unknown place (timing line can be placed)');
    return p.course?.name ? circuitLabel(p.course.name) : t('未分類', 'Unsorted');
  };
  const countText = (p: ImportPart) => (p.kind === 'stage' ? t(`区間 ${p.laps}`, `${p.laps} stage${(p.laps) === 1 ? '' : 's'}`) : p.kind === 'transit' ? '—' : t(`${p.laps} 周`, `${p.laps} lap${(p.laps) === 1 ? '' : 's'}`));
  const color = (p: ImportPart) => (p.kind === 'transit' ? '#64748b' : p.kind === 'unknown' ? '#f59e0b' : p.kind === 'stage' ? '#a78bfa' : '#10b981');
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-stretch sm:items-center justify-center" role="dialog" aria-modal="true" data-testid="import-sheet">
      <div className="bg-surface-1 border border-line-2 w-full sm:max-w-3xl sm:max-h-[86vh] sm:rounded-2xl flex flex-col overflow-hidden shadow-2xl">
        <div className="flex items-start gap-2 px-4 py-3 border-b border-line-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-slate-100 truncate">{t(`取り込み: ${plan.sourceName}`, `Import: ${plan.sourceName}`)}</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {t(`走行を ${plan.parts.length} つに分けました${circuits > 1 ? ` (${circuits} つのサーキット)` : ''}。取り込むものに印を付けてください。`,
                `Split into ${plan.parts.length} part${plan.parts.length === 1 ? '' : 's'}${circuits > 1 ? ` (${circuits} circuits)` : ''}. Tick the ones to import.`)}
            </p>
          </div>
          {phase !== 'writing' && (
            <button onClick={onClose} className="p-1.5 rounded hover:bg-surface-3 text-slate-400 cursor-pointer" aria-label={t('閉じる', 'Close')}><X size={18} /></button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-line-2" data-testid="import-rows">
          {plan.parts.map(p => {
            const r = results?.find(x => x.id === p.id);
            return (
              <label key={p.id} className={`flex items-center gap-3 px-4 py-3 ${p.kind === 'unknown' ? 'bg-amber-500/5' : ''} ${phase === 'confirm' ? 'cursor-pointer' : ''}`} data-testid="import-row">
                <input type="checkbox" checked={p.checked} disabled={phase !== 'confirm'} onChange={() => onToggle(p.id)} className="w-5 h-5 accent-sky-600 shrink-0" />
                <div className="w-24 shrink-0 font-mono text-xs text-slate-300">
                  <div>{md(p.startMs)}</div>
                  <div>{hm(p.startMs)}–{hm(p.endMs)}</div>
                </div>
                <div className="w-28 sm:w-40 shrink-0 hidden sm:block"><Sparkline values={p.sparkline} color={color(p)} /></div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-bold truncate ${p.kind === 'transit' ? 'text-slate-500' : p.kind === 'unknown' ? 'text-amber-500' : 'text-slate-100'}`}>
                    {p.kind === 'unknown' && <AlertTriangle size={13} className="inline mr-1" />}{label(p)}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate font-mono">{p.base}.nmea</div>
                  {p.already && <div className="text-[11px] text-sky-500">{t('取り込み済み (同じ走行がもうある)', 'Already imported')}</div>}
                  {r?.error && <div className="text-[11px] text-red-500">{r.error}</div>}
                </div>
                <div className="w-14 text-right text-xs font-mono text-slate-300 shrink-0">{countText(p)}</div>
                <div className="w-5 shrink-0">
                  {r && !r.error && (r.written.length ? <CheckCircle2 size={16} className="text-emerald-500" /> : <span className="text-[10px] text-slate-500">—</span>)}
                </div>
              </label>
            );
          })}
        </div>
        <div className="px-4 py-2 text-[11px] text-slate-500 border-t border-line-2">
          {t('元のファイルは 取り込み元/ に、手を加えずに残します。知らない場所の走行は 未分類 に入れます (あとでコースにできます)。',
            'The original file is kept untouched in the 取り込み元/ (originals) folder. Runs at unknown places go to Unsorted (you can make a course later).')}
        </div>
        {/* 狭い幅では折り返す (ボタンの中で文字が割れないよう、ボタンは折り返さない) */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-line-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {phase === 'writing' && progress && (
            <span className="flex items-center gap-2 text-xs text-slate-300"><Loader2 size={14} className="animate-spin" />{t(`書いています ${progress.done}/${progress.total}`, `Writing ${progress.done}/${progress.total}`)}</span>
          )}
          {phase === 'confirm' && (
            <button onClick={onOpenOnly} className="px-3 py-2 rounded-lg text-xs text-slate-300 border border-line-2 hover:bg-surface-3 cursor-pointer whitespace-nowrap" data-testid="import-open-only">
              {t('取り込まずに今だけ開く', 'Just open (no import)')}
            </button>
          )}
          <div className="flex-1" />
          {phase === 'confirm' && (
            <>
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-300 border border-line-2 hover:bg-surface-3 cursor-pointer whitespace-nowrap">{t('やめる', 'Cancel')}</button>
              <button onClick={onApply} disabled={checked === 0} className="px-4 py-2 rounded-lg text-sm font-bold text-white bg-red-600 hover:bg-red-500 disabled:opacity-40 cursor-pointer whitespace-nowrap" data-testid="import-apply">
                {t(`${checked} つを取り込む`, `Import ${checked}`)}
              </button>
            </>
          )}
          {phase === 'done' && (
            <>
              <span className="text-xs text-slate-300" data-testid="import-summary">
                {t(`${results?.filter(r => r.written.length).length ?? 0} つを取り込みました`, `Imported ${results?.filter(r => r.written.length).length ?? 0}`)}
              </span>
              <div className="flex-1" />
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-300 border border-line-2 hover:bg-surface-3 cursor-pointer" data-testid="import-done">{t('閉じる', 'Close')}</button>
              {onOpenAfter && (
                <button onClick={onOpenAfter} className="px-4 py-2 rounded-lg text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-500 cursor-pointer" data-testid="import-open-after">{t('解析で開く', 'Open in analysis')}</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
