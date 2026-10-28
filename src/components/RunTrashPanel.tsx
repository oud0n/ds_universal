import React, { useState } from 'react';
import { Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { formatLapTime } from '../services/liveLapTimer';
import { baseName } from '../services/runOpener';
import { daysLeft, TRASH_DAYS, type TrashedRun } from '../services/runTrash';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { circuitLabel, useT } from '../utils/i18n';

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

/**
 * 最近消した走行 (アプリのゴミ箱。2026-10-28、services/runTrash.ts)。
 * 戻すと、ファイルと走行の記録 (名前・メモ・同期) が元に戻る。完全に消すと戻せない。30 日たったものは自動で消える
 */
export const RunTrashPanel: React.FC<{
  runs: TrashedRun[];
  onRestore: (r: TrashedRun) => Promise<string | null>;
  onPurge: (ids: string[]) => Promise<string | null>;
  onClose: () => void;
}> = ({ runs, onRestore, onPurge, onClose }) => {
  const t = useT();
  useEscapeKey(true, onClose);
  /** 動かしている走行の印 (all: すべて消す) */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, f: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    try { setError(await f()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };
  const title = (r: TrashedRun) => {
    const m = r.manifest;
    if (!m) return r.files[0] ? baseName(r.files[0].path) : r.id;
    if (m.row?.name) return m.row.name;
    const d = m.startMs !== null ? new Date(m.startMs) : null;
    const when = d ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : baseName(m.file);
    return `${when} ${m.courseName ? circuitLabel(m.courseName) : m.folder}`;
  };
  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid="run-trash-panel">
      <div className="w-full max-w-md max-h-[85vh] flex flex-col rounded-2xl bg-surface-1 border border-line-2 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-slate-100">{t('最近消した走行', 'Recently deleted runs')}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{t(`消してから ${TRASH_DAYS} 日で、自動で完全に消えます。戻すと、名前・メモ・同期も戻ります。`, `Runs are permanently deleted ${TRASH_DAYS} days after you delete them. Restoring brings back the name, notes and sync too.`)}</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-slate-400 hover:text-slate-200 cursor-pointer" aria-label={t('閉じる', 'Close')} data-testid="run-trash-close"><X size={18} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2 text-xs">
          {runs.length === 0 && <p className="text-slate-400 py-4 text-center">{t('消した走行はありません。', 'No deleted runs.')}</p>}
          {runs.map(r => (
            <div key={r.id} className="rounded-lg bg-surface-2 border border-line-2 px-3 py-2" data-testid="run-trash-row">
              <div className="font-bold text-slate-200 truncate">{title(r)}</div>
              <div className="text-[11px] text-slate-400 font-mono">
                {r.manifest ? t(`${r.manifest.lapCount} 周`, `${r.manifest.lapCount} lap${r.manifest.lapCount === 1 ? '' : 's'}`) : ''}
                {r.manifest?.best != null ? ` · ${t('ベスト', 'best')} ${formatLapTime(r.manifest.best, 3)}` : ''}
                {` · ${t(`${r.files.length} 件`, `${r.files.length} file${r.files.length === 1 ? '' : 's'}`)} ${size(r.size)}`}
              </div>
              <div className="flex items-center gap-2 mt-1.5">
                <span className="flex-1 text-[11px] text-slate-500">{t(`あと ${daysLeft(r)} 日で消えます`, `Deleted in ${daysLeft(r)} day${daysLeft(r) === 1 ? '' : 's'}`)}</span>
                <button
                  onClick={() => { if (window.confirm(t('この走行を完全に消しますか？ 戻せなくなります。', 'Permanently delete this run? It cannot be restored.'))) void run(r.id, () => onPurge([r.id])); }}
                  disabled={busy !== null}
                  className="px-2.5 py-1.5 rounded-lg text-red-400 hover:bg-surface-3 disabled:opacity-50 cursor-pointer"
                  data-testid="run-trash-purge"
                >{t('完全に消す', 'Delete')}</button>
                <button
                  onClick={() => void run(r.id, () => onRestore(r))}
                  disabled={busy !== null}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer"
                  data-testid="run-trash-restore"
                >{busy === r.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}{t('戻す', 'Restore')}</button>
              </div>
            </div>
          ))}
          {error && <p className="text-amber-500" data-testid="run-trash-error">{error}</p>}
        </div>
        {runs.length > 1 && (
          <div className="px-4 py-3 border-t border-line-2">
            <button
              onClick={() => { if (window.confirm(t(`${runs.length} 本の走行をすべて完全に消しますか？ 戻せなくなります。`, `Permanently delete all ${runs.length} runs? They cannot be restored.`))) void run('all', () => onPurge(runs.map(r => r.id))); }}
              disabled={busy !== null}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-surface-3 text-red-400 text-xs font-bold disabled:opacity-50 cursor-pointer"
              data-testid="run-trash-purge-all"
            >{busy === 'all' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}{t('すべて完全に消す', 'Delete all permanently')}</button>
          </div>
        )}
      </div>
    </div>
  );
};
