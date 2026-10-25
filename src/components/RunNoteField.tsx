import React, { useEffect, useState } from 'react';
import { StickyNote } from 'lucide-react';
import { useT } from '../utils/i18n';

/**
 * 走行の条件のメモ (天気・気温・タイヤ・空気圧・セッティングなど。PLAN-33)。決まった項目は作らず、自由に書く。
 * 欄から離れたとき (と Enter と ⌘/Ctrl) に書く。保管場所の runs.json の行に入る (呼ぶ側が書く)
 */
export const RunNoteField: React.FC<{ note: string | undefined; onSave: (note: string) => void; testId?: string }> = ({ note, onSave, testId = 'run-note' }) => {
  const t = useT();
  const [draft, setDraft] = useState(note ?? '');
  // ほかの所で書き換えたら (開き直した・別の画面で書いた) 欄も合わせる
  useEffect(() => setDraft(note ?? ''), [note]);
  const save = () => { if (draft.trim() !== (note ?? '').trim()) onSave(draft); };
  return (
    <label className="flex items-start gap-1.5 w-full text-xs">
      <StickyNote size={13} className="shrink-0 mt-1.5 text-slate-500" />
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value.slice(0, 500))}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); (e.target as HTMLTextAreaElement).blur(); } }}
        rows={draft.includes('\n') ? 3 : 1}
        placeholder={t('メモ (天気・気温・タイヤ・空気圧・セッティングなど)', 'Notes (weather, temperature, tyres, pressures, setup…)')}
        aria-label={t('走行のメモ', 'Run notes')}
        data-testid={testId}
        className="flex-1 min-w-0 resize-y bg-surface-1 border border-line-3 focus:border-sky-500 rounded px-2 py-1 text-slate-200 placeholder:text-slate-500 outline-none"
      />
    </label>
  );
};
