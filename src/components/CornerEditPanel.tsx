import React from 'react';
import { Check, GitMerge, RotateCcw, Scissors, Trash2, X } from 'lucide-react';
import { useT } from '../utils/i18n';
import type { NamedCorner } from '../services/cornerNames';

/**
 * コースマップの「コーナーの編集」(PLAN-27)。走る順のコーナーの一覧で、名前を付ける・まとめる・分ける・消す。
 * 地図を押すとコーナーを足す・走行の線をなぞるとその範囲を 1 つのコーナーにする (地図の側でする)
 */
export const CornerEditPanel: React.FC<{
  draft: NamedCorner[];
  /** 周の上に置けなかったコーナー (この周では通っていない) */
  missing: Set<number>;
  selected: number | null;
  onSelect: (k: number | null) => void;
  onRename: (k: number, name: string) => void;
  onMerge: (k: number) => void;
  onSplit: (k: number) => void;
  onDelete: (k: number) => void;
  onRedetect: () => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error?: string;
}> = ({ draft, missing, selected, onSelect, onRename, onMerge, onSplit, onDelete, onRedetect, onSave, onCancel, saving, error }) => {
  const t = useT();
  const btn = 'p-1.5 rounded border border-line-3 text-slate-300 hover:bg-surface-4 disabled:opacity-30 cursor-pointer';
  return (
    <div className="absolute top-2 right-2 bottom-2 w-[min(14rem,48%)] bg-surface-1/95 border border-line-2 rounded-lg shadow-xl flex flex-col text-xs" data-testid="corner-edit-panel">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line-2">
        <span className="font-bold text-slate-100 flex-1">{t('コーナーの編集', 'Edit corners')}</span>
        <button onClick={onRedetect} className={btn} title={t('この周から見つけ直す (近い所の名前は残す)', 'Detect again from this lap (keeps names nearby)')} aria-label={t('見つけ直す', 'Detect again')}>
          <RotateCcw size={13} />
        </button>
      </div>
      <p className="px-3 py-1.5 text-[11px] text-slate-500 border-b border-line-2">
        {t('名前は自由に (「1」「ヘアピン」など)。走行の線をなぞると、その範囲が 1 つのコーナーになります (中のコーナーは置き換え)。押すと、そこにコーナーを足します。', 'Name corners freely ("1", "Hairpin"...). Drag along the line to make that stretch one corner (replaces the corners inside). Tap to add a corner there.')}
      </p>
      <ol className="flex-1 min-h-0 overflow-y-auto divide-y divide-line-2" data-testid="corner-edit-list">
        {draft.map((c, k) => (
          <li
            key={k}
            onClick={() => onSelect(k === selected ? null : k)}
            className={`px-3 py-1.5 cursor-pointer ${k === selected ? 'bg-amber-500/10' : ''}`}
            data-testid="corner-edit-row"
          >
            <div className="flex items-center gap-2">
              <span className={`w-4 text-[10px] ${c.direction === 'R' ? 'text-sky-400' : 'text-amber-400'}`}>{c.direction === 'R' ? t('右', 'R') : t('左', 'L')}</span>
              <input
                value={c.name}
                onChange={e => onRename(k, e.target.value.slice(0, 40))}
                onClick={e => { e.stopPropagation(); onSelect(k); }}
                className="flex-1 min-w-0 bg-surface-2 border border-line-2 rounded px-2 py-1 text-slate-100"
                aria-label={t('コーナーの名前', 'Corner name')}
                data-testid="corner-name-input"
              />
              {missing.has(k) && <span className="text-[10px] text-amber-500" title={t('この周では通っていません', 'Not on this lap')}>!</span>}
            </div>
            {k === selected && (
              <div className="flex items-center gap-1.5 mt-1.5 pl-6" onClick={e => e.stopPropagation()}>
                <button onClick={() => onMerge(k)} disabled={k + 1 >= draft.length} className={btn} title={t('次のコーナーとまとめる', 'Merge with the next corner')} aria-label={t('次とまとめる', 'Merge with next')} data-testid="corner-merge">
                  <GitMerge size={13} />
                </button>
                <button onClick={() => onSplit(k)} disabled={missing.has(k)} className={btn} title={t('2 つに分ける', 'Split in two')} aria-label={t('分ける', 'Split')} data-testid="corner-split">
                  <Scissors size={13} />
                </button>
                <button onClick={() => onDelete(k)} className={btn} title={t('消す', 'Delete')} aria-label={t('消す', 'Delete')} data-testid="corner-delete">
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {error && <p className="px-3 py-1 text-[11px] text-red-500">{error}</p>}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-line-2">
        <button onClick={onCancel} className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded border border-line-3 text-slate-300 hover:bg-surface-4 cursor-pointer">
          <X size={13} />{t('やめる', 'Cancel')}
        </button>
        <button onClick={onSave} disabled={saving} className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold disabled:opacity-40 cursor-pointer" data-testid="corner-save">
          <Check size={13} />{t('保存', 'Save')}
        </button>
      </div>
    </div>
  );
};
