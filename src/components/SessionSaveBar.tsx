import React, { useEffect, useRef, useState } from 'react';
import { Save, Upload } from 'lucide-react';
import { useT } from '../utils/i18n';

/**
 * 今の Car の割り当て (どの走行の何周目を比べているか) を、解析用のセッションとして保存する (PLAN-18)。
 * 保存したセッションは、走行の画面の「保存した比べ方」から開き直せる
 */
export const SessionSaveBar: React.FC<{
  defaultName: string;
  onSave: (name: string) => Promise<string | null>;
  /** ブラウザ版 (保管場所なし): 保存はファイルに書き出す。読み込みで、開いているログに当て直す (エラーなら文) */
  onImport?: (file: File) => Promise<string | null>;
  canSave?: boolean;
}> = ({ defaultName, onSave, onImport, canSave = true }) => {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  // Car の割り当てが変わったら (名前の候補が変わる)、前の知らせは消す
  useEffect(() => { setNote(null); }, [defaultName]);
  const importFile = async (file: File) => {
    setNote(null);
    const error = await onImport!(file).catch(e => (e instanceof Error ? e.message : String(e)));
    setNote(error ? { ok: false, text: error } : { ok: true, text: t('比べ方を読み込みました', 'Comparison loaded') });
  };
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setBusy(true);
    setNote(null);
    const error = await onSave(name.trim() || defaultName).catch(e => (e instanceof Error ? e.message : String(e)));
    setBusy(false);
    setNote(error ? { ok: false, text: error } : onImport
      ? { ok: true, text: t('ファイルに書き出しました (同じログを開いてから「読み込む」で戻せます)', 'Downloaded (open the same logs, then use "Load")') }
      : { ok: true, text: t('保存しました (走行の画面の「保存した比べ方」から開けます)', 'Saved (open it from "Saved comparisons" on the Runs screen)') });
    if (!error) setName('');
  };
  return (
    <div className="bg-surface-2 border border-line-2 rounded-xl p-3 space-y-1.5" data-testid="session-save">
      <div className="flex items-center gap-2">
        <Save size={14} className="shrink-0 text-slate-400" />
        <input
          value={name}
          onChange={e => setName(e.target.value.slice(0, 60))}
          onKeyDown={e => { if (!e.nativeEvent.isComposing && e.key === 'Enter') void save(); }}
          placeholder={defaultName}
          aria-label={t('保存する名前', 'Name to save as')}
          className="flex-1 min-w-0 bg-surface-1 border border-line-3 focus:border-sky-500 rounded px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 outline-none"
          data-testid="session-save-name"
        />
        <button onClick={() => void save()} disabled={busy || !canSave} className="shrink-0 px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold disabled:opacity-50 cursor-pointer whitespace-nowrap" data-testid="session-save-button">
          {onImport ? t('比べ方を書き出す', 'Download comparison') : t('比べ方を保存', 'Save comparison')}
        </button>
        {onImport && (
          <>
            <button onClick={() => fileRef.current?.click()} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-line-3 hover:border-sky-500 text-slate-300 text-xs cursor-pointer whitespace-nowrap" data-testid="session-import-button">
              <Upload size={12} />{t('読み込む', 'Load')}
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" data-testid="session-import-input"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
          </>
        )}
      </div>
      {note && <p className={`text-[11px] ${note.ok ? 'text-slate-400' : 'text-amber-500'}`}>{note.text}</p>}
    </div>
  );
};
