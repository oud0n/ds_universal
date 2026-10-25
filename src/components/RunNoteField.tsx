import React, { useEffect, useRef, useState } from 'react';
import { StickyNote } from 'lucide-react';
import { useT } from '../utils/i18n';

/**
 * 走行の条件のメモ (天気・気温・空気圧・セッティングなど。PLAN-33)。車種・タイヤは別の欄 (2026-10-25)。
 * 欄から離れたとき (と Enter と ⌘/Ctrl) に書く。保管場所の runs.json の行に入る (呼ぶ側が書く)
 */
export const RunNoteField: React.FC<{ note: string | undefined; onSave: (note: string) => void; testId?: string }> = ({ note, onSave, testId = 'run-note' }) => {
  const t = useT();
  const [draft, setDraft] = useState(note ?? '');
  // ほかの所で書き換えたら (開き直した・別の画面で書いた) 欄も合わせる
  useEffect(() => setDraft(note ?? ''), [note]);
  // 書いた中身 (親が読み直すまで、note は古いままのことがある。同じものを 2 回書かないように)
  const saved = useRef(note ?? '');
  useEffect(() => { saved.current = note ?? ''; }, [note]);
  const save = () => { if (draft.trim() !== saved.current.trim()) { saved.current = draft; onSave(draft); } };
  // 欄が消える (別の走行を選んだ・画面を替えた) ときも、書きかけを書く (離れる前に消えると、書かれなかった)
  const latest = useRef({ draft, onSave });
  latest.current = { draft, onSave };
  useEffect(() => () => { const l = latest.current; if (l.draft.trim() !== saved.current.trim()) l.onSave(l.draft); }, []);
  return (
    <label className="flex items-start gap-1.5 w-full text-xs">
      <StickyNote size={13} className="shrink-0 mt-1.5 text-slate-500" />
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value.slice(0, 500))}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); (e.target as HTMLTextAreaElement).blur(); } }}
        rows={draft.includes('\n') ? 3 : 1}
        placeholder={t('メモ (天気・気温・空気圧・セッティングなど)', 'Notes (weather, temperature, pressures, setup…)')}
        aria-label={t('走行のメモ', 'Run notes')}
        data-testid={testId}
        className="flex-1 min-w-0 resize-y bg-surface-1 border border-line-3 focus:border-sky-500 rounded px-2 py-1 text-slate-200 placeholder:text-slate-500 outline-none"
      />
    </label>
  );
};
