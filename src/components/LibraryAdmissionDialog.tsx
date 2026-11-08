import React, { useEffect, useRef, useState } from 'react';
import type { RunStore } from '../services/runStore';
import { setLibraryDecision, type RunItem } from '../services/runOpener';
import { useT } from '../utils/i18n';
import { useEscapeKey } from '../hooks/useEscapeKey';

/** 時間が重なるログを一覧に追加するか、利用者が決める。元ログは変更しない。 */
export function LibraryAdmissionDialog({ store, run, onClose, onSaved }: {
  store: RunStore; run: RunItem; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const close = () => { if (!saving.current) onClose(); };
  useEscapeKey(true, close);
  const save = async (include: boolean) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      await setLibraryDecision(store, run, include);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      saving.current = false; setBusy(false);
    }
  };
  const stamp = (ms: number) => new Date(ms).toLocaleString(t('ja-JP', 'en-US'));
  const pending = run.libraryAdmission?.status === 'pending';
  return <dialog ref={dialog} onCancel={e => { e.preventDefault(); close(); }} aria-modal="true" aria-labelledby="library-admission-title" className="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[calc(100%-2rem)] overflow-y-auto rounded-xl border border-line-2 bg-surface-1 p-5 text-slate-200 shadow-xl backdrop:bg-black/60" data-testid="library-admission-dialog">
      <h2 id="library-admission-title" className="text-base font-bold">{t('ライブラリに追加しますか？', 'Add to the library?')}</h2>
      <p className="mt-3 text-sm break-all">{run.folder}/{run.file}</p>
      {pending && <p className="mt-3 text-sm text-slate-400">{t('次のログと収録時間が重なっています。別の車の同時走行の場合もあります。', 'Its recording time overlaps the following logs. These may be different cars driving at the same time.')}</p>}
      <ul className="mt-2 space-y-2 text-xs text-slate-400">
        {run.libraryAdmission?.overlaps.map(other => <li key={other.file}>
          <div className="break-all">{other.file}</div>
          <div>{stamp(other.startMs)} – {stamp(other.endMs)}</div>
          <div>{t(`重なる時間: 約${Math.round(other.overlapSec / 60)}分`, `Overlapping time: about ${Math.round(other.overlapSec / 60)} min`)}</div>
        </li>)}
      </ul>
      <p className="mt-3 text-xs text-slate-400">{t('どちらを選んでも元ファイルは残ります。「追加しない」を選んだログは、一覧から後で追加できます。', 'Original files are kept either way. Logs you skip can be added later from the library.')}</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2 text-sm">
        <button autoFocus disabled={busy} onClick={close} className="px-3 py-2 rounded border border-line-2 disabled:opacity-50">{pending ? t('あとで', 'Later') : t('閉じる', 'Close')}</button>
        {pending && <button disabled={busy} onClick={() => void save(false)} className="px-3 py-2 rounded border border-line-2 disabled:opacity-50">{t('追加しない', 'Skip')}</button>}
        <button disabled={busy} onClick={() => void save(true)} className="px-3 py-2 rounded bg-sky-600 text-white disabled:opacity-50">{busy ? t('保存中…', 'Saving…') : t('追加する', 'Add')}</button>
      </div>
  </dialog>;
}
