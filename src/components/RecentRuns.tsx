/**
 * 過去の走行の一覧 (2026-10-20)。保管場所の走行を新しい順に出し、押すとログ・動画・同期をそろえて開く。
 * - RecentRunsList: 読み込む前のグラフの画面に出す、最近の数件
 * - RunsSheet: 上の「読込」から開く、全部の走行 (サーキットで絞れる) と「ファイルを選ぶ」
 */
import React, { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Video, X, Loader2, ChevronRight } from 'lucide-react';
import { useT } from '../utils/i18n';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { formatLapTime } from '../services/liveLapTimer';
import { getRunStore, type RunStore } from '../services/runStore';
import { listRuns, type RunItem } from '../services/runOpener';

const pad = (n: number) => String(n).padStart(2, '0');
function fmtDate(ms: number | null, ja: boolean): string {
  if (ms === null) return '--';
  const d = new Date(ms);
  const w = (ja ? ['日', '月', '火', '水', '木', '金', '土'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} (${w}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 走行の一覧を読み込む (開いている間に 1 回) */
function useRuns(enabled: boolean) {
  const [state, setState] = useState<{ store: RunStore | null; runs: RunItem[] | null; error: string | null; noFolder: boolean }>({ store: null, runs: null, error: null, noFolder: false });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const store = await getRunStore();
        if (!store) { if (!cancelled) setState({ store: null, runs: [], error: null, noFolder: true }); return; }
        const runs = await listRuns(store);
        if (!cancelled) setState({ store, runs, error: null, noFolder: false });
      } catch (e) {
        if (!cancelled) setState(s => ({ ...s, runs: [], error: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, reload]);
  return { ...state, reload: () => setReload(n => n + 1) };
}

const RunRow: React.FC<{ run: RunItem; onOpen: (r: RunItem) => void; busy: boolean }> = ({ run, onOpen, busy }) => {
  const t = useT();
  const ja = t('ja', 'en') === 'ja';
  const videoCount = run.videos.length;
  return (
    <button
      onClick={() => onOpen(run)}
      disabled={busy}
      className="w-full text-left flex items-center gap-2 px-3 py-2.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-line-2 disabled:opacity-50 cursor-pointer"
      data-testid="run-row"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="font-mono text-slate-200 shrink-0">{fmtDate(run.startMs, ja)}</span>
          <span className="text-slate-400 truncate">{run.courseName ?? run.folder}</span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs">
          {run.pending ? (
            <span className="text-slate-500" title={t('iCloud にだけあるので、開くと落としてきて周を数えます', 'Only in iCloud. Laps are counted after it downloads when you open it')}>
              {t('☁️ 未集計', '☁️ Not counted')}
            </span>
          ) : (
            <>
              <span className={`font-mono font-bold ${run.best !== null ? 'text-fuchsia-400' : 'text-slate-500'}`}>
                {run.best !== null ? formatLapTime(run.best) : '--'}
              </span>
              <span className="text-slate-400">{t(`${run.lapCount} 周`, `${run.lapCount} laps`)}</span>
            </>
          )}
          {videoCount > 0 && (
            <span className="inline-flex items-center gap-1 text-sky-300">
              <Video size={12} />{videoCount}{run.synced ? t('・同期済み', ' · synced') : ''}
            </span>
          )}
        </div>
      </div>
      <ChevronRight size={16} className="text-slate-500 shrink-0" />
    </button>
  );
};

/** 読み込む前のグラフの画面に出す、最近の走行 */
export const RecentRunsList: React.FC<{ limit: number; onOpen: (r: RunItem) => void; onShowAll: () => void; busy: boolean }> = ({ limit, onOpen, onShowAll, busy }) => {
  const t = useT();
  const { runs } = useRuns(true);
  if (!runs || runs.length === 0) return null;
  return (
    <div className="w-full max-w-sm mt-5 text-left" data-testid="recent-runs">
      <div className="flex items-center justify-between mb-1.5 px-0.5">
        <span className="text-xs font-bold text-slate-300">{t('最近の走行', 'Recent runs')}</span>
        {runs.length > limit && (
          <button onClick={onShowAll} className="text-xs text-sky-400 hover:text-sky-300 cursor-pointer">{t('すべて見る', 'Show all')}</button>
        )}
      </div>
      <div className="space-y-1.5">
        {runs.slice(0, limit).map(r => <RunRow key={`${r.folder}/${r.file}`} run={r} onOpen={onOpen} busy={busy} />)}
      </div>
    </div>
  );
};

/** 全部の走行と「ファイルを選ぶ」 */
/** 走行の一覧 (ファイルを選ぶ・サーキットで絞る・一覧)。走行の画面にそのまま置き、スマートフォン以外のシートでも使う */
export const RunsBrowser: React.FC<{ onOpen: (r: RunItem) => void; onPickFiles: () => void; busy: boolean }> = ({ onOpen, onPickFiles, busy }) => {
  const t = useT();
  const { runs, error, noFolder, reload } = useRuns(true);
  const [folder, setFolder] = useState<string | null>(null);
  const folders = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of runs ?? []) if (!m.has(r.folder)) m.set(r.folder, r.courseName ?? r.folder);
    return [...m.entries()];
  }, [runs]);
  const shown = (runs ?? []).filter(r => !folder || r.folder === folder);
  const pickFolder = async () => {
    await window.electronAPI?.laps?.pickFolder();
    reload();
  };
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 pt-3">
        <button
          onClick={onPickFiles}
          className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-sm text-white font-bold cursor-pointer"
          data-testid="runs-pick-files"
        >
          <FolderOpen size={16} />{t('ファイルを選ぶ', 'Choose files')}
        </button>
      </div>
      {folders.length > 1 && (
        <div className="flex gap-1.5 px-4 pt-3 overflow-x-auto shrink-0">
          {[[null, t('すべて', 'All')] as const, ...folders].map(([f, label]) => (
            <button
              key={f ?? '*'}
              onClick={() => setFolder(f)}
              className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap border cursor-pointer ${folder === f ? 'bg-sky-600 border-sky-500 text-white' : 'bg-surface-3 border-line-2 text-slate-300'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
        {runs === null && (
          <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center"><Loader2 size={14} className="animate-spin" />{t('走行を読み込んでいます…', 'Loading runs…')}</div>
        )}
        {noFolder && (
          <div className="text-xs text-slate-400 py-4 text-center space-y-3">
            <p>{t('走行の保管場所が決まっていません。保管場所のフォルダ (サーキットごとのフォルダが並ぶところ) を選ぶと、過去の走行をここから開けます。', 'No storage folder is set. Choose the folder that holds a folder per circuit to open past runs here.')}</p>
            {window.electronAPI?.laps && <button onClick={() => void pickFolder()} className="px-3 py-2 rounded-lg bg-surface-3 border border-line-2 text-slate-200 cursor-pointer">{t('保管場所を選ぶ', 'Choose folder')}</button>}
          </div>
        )}
        {error && <p className="text-xs text-red-400 py-2">{error}</p>}
        {runs && runs.length === 0 && !noFolder && !error && (
          <p className="text-xs text-slate-400 py-6 text-center">{t('保管場所に走行がありません。', 'No runs in the storage folder.')}</p>
        )}
        {shown.map(r => <RunRow key={`${r.folder}/${r.file}`} run={r} onOpen={onOpen} busy={busy} />)}
      </div>
    </div>
  );
};

/** 走行の一覧を、画面の上に重ねて出す (走行の画面がない組み方のとき) */
export const RunsSheet: React.FC<{ onClose: () => void; onOpen: (r: RunItem) => void; onPickFiles: () => void; busy: boolean }> = ({ onClose, onOpen, onPickFiles, busy }) => {
  const t = useT();
  useEscapeKey(true, onClose);
  return (
    <div className="fixed inset-0 z-[55] bg-black/70 flex items-end sm:items-center justify-center" onClick={e => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" data-testid="runs-sheet">
      <div className="bg-surface-1 border border-line-2 w-full sm:max-w-lg h-[85vh] sm:h-[80vh] rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2">
          <h2 className="text-sm font-bold text-slate-100 flex-1">{t('走行を開く', 'Open a run')}</h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-surface-3 text-slate-400 cursor-pointer" aria-label={t('閉じる', 'Close')}><X size={18} /></button>
        </div>
        <RunsBrowser onOpen={onOpen} onPickFiles={onPickFiles} busy={busy} />
      </div>
    </div>
  );
};
