/**
 * ラップタイムの記録 (2026-10-20、PLAN-19)。保管場所のサーキットのフォルダごとに、過去の周を一覧にする。
 * 周ごとに非表示にできる (ファイルは消さない)。iPhone のアプリ (ラップタイマーのメニューから) とデスクトップ版 (データの画面から) で使う
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, FolderOpen, EyeOff, Eye, RefreshCw, BarChart3 } from 'lucide-react';
import { loadLapHistory, toggleLapHidden, type LapFolder } from '../services/lapHistory';
import { electronRunStore as electronLapStore, nativeRunStore as nativeLapStore } from '../services/runStore';
import { lapKey, type LapFileStore, type LapRow } from '../services/lapIndex';
import { formatLapTime } from '../services/liveLapTimer';
import { circuitLabel, getLang, useT } from '../utils/i18n';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { storageFolderChanged } from '../services/storageCourses';

interface Props {
  onClose: () => void;
  /** 走行のファイル (.bon4) を解析で開く (無ければボタンを出さない) */
  /** 走行を解析で開く。run は保管場所の走行 (走行の画面から開くのと同じに開くため)。file はその中身 (走行として見つからないとき用) */
  onOpenRun?: (file: File, run: { folder: string; file: string }) => void;
}

type SortKey = 'date' | 'time';

/** 速い順の 1〜3 番目の色 (ベストは紫、2 番目は緑、3 番目は琥珀色) */
const RANK_STYLE: Record<number, { bg: string; text: string }> = {
  1: { bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-400' },
  2: { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
  3: { bg: 'bg-amber-500/15', text: 'text-amber-400' }
};

const pad = (n: number) => String(n).padStart(2, '0');
function fmtDate(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  const wd = (getLang() === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['日', '月', '火', '水', '木', '金', '土'])[d.getDay()];
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} (${wd}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const LapHistoryPanel: React.FC<Props> = ({ onClose, onOpenRun }) => {
  const t = useT();
  const desktop = !!window.electronAPI?.laps;
  const [store, setStore] = useState<LapFileStore | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folders, setFolders] = useState<LapFolder[] | null>(null);
  // 隠す操作を続けて押しても、前の操作を消さないよう、いつも最新の一覧から直し、書くのは 1 つずつ
  const foldersRef = useRef<LapFolder[] | null>(null);
  foldersRef.current = folders;
  const toggleChain = useRef<Promise<void>>(Promise.resolve());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [showHidden, setShowHidden] = useState(false);
  useEscapeKey(true, onClose);

  const load = useCallback(async (s: LapFileStore | null) => {
    setError(null);
    if (!s) { setFolders([]); return; }
    setBusy('');
    try {
      const list = await loadLapHistory(s, f => setBusy(f));
      setFolders(list);
      // はじめは、いちばん新しい走行のあるコース
      setSelected(prev => (prev && list.some(f => f.folder === prev)) ? prev
        : [...list].sort((a, b) => (b.rows[0]?.runStartMs ?? 0) - (a.rows[0]?.runStartMs ?? 0))[0]?.folder ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFolders([]);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const s = desktop ? await electronLapStore() : nativeLapStore();
      if (desktop) setFolderPath(await window.electronAPI!.laps!.getFolder());
      setStore(s);
      await load(s);
    })();
  }, [desktop, load]);

  const pickFolder = async () => {
    const p = await window.electronAPI?.laps?.pickFolder();
    setFolderPath(p ?? null);
    if (p) void storageFolderChanged();
    const s = await electronLapStore();
    setStore(s);
    await load(s);
  };

  const current = folders?.find(f => f.folder === selected) ?? null;
  const visible = useMemo(() => (current?.rows ?? []).filter(r => showHidden || !r.hidden), [current, showHidden]);
  // 速い順の上から 3 つのタイム (隠した周は数えない。同じタイムは同じ順位)
  const top3 = useMemo(() => [...new Set((current?.rows ?? []).filter(r => !r.hidden).map(r => r.time))].sort((a, b) => a - b).slice(0, 3), [current]);
  const best = top3[0] ?? null;
  /** 順位 (1〜3。それ以外・隠した周は 0) */
  const rankOf = (r: LapRow) => (r.hidden ? 0 : top3.indexOf(r.time) + 1);
  // 走行ごとのまとまり (日付順のとき)
  const runs = useMemo(() => {
    const m = new Map<string, LapRow[]>();
    for (const r of visible) m.set(r.file, [...(m.get(r.file) ?? []), r]);
    return [...m.entries()];
  }, [visible]);
  const byTime = useMemo(() => [...visible].sort((a, b) => a.time - b.time), [visible]);

  const toggle = (r: LapRow) => {
    if (!store) return;
    toggleChain.current = toggleChain.current.then(async () => {
      const latest = foldersRef.current?.find(f => f.folder === r.folder);
      if (!latest) return;
      try {
        const next = await toggleLapHidden(store, latest, r.file, r.part, r.n, !r.hidden);
        foldersRef.current = foldersRef.current?.map(f => (f.folder === next.folder ? next : f)) ?? null;
        setFolders(foldersRef.current);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  /** 走行を解析で開く (同じフォルダのファイルを読んで渡す) */
  const openRun = async (file: string) => {
    if (!store || !current || !onOpenRun) return;
    try {
      const bytes = await store.read(`${current.folder}/${file}`);
      // 日付のフォルダの中の走行 (20261024/xxx.bon4) も、ファイルの名前だけで開く
      onOpenRun(new File([bytes as BlobPart], file.slice(file.lastIndexOf('/') + 1), { type: 'application/octet-stream' }), { folder: current.folder, file });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const lapLine = (r: LapRow, withDate: boolean) => (
    <div key={lapKey(r.file, r.part, r.n)} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${r.hidden ? 'opacity-40' : ''} ${RANK_STYLE[rankOf(r)]?.bg ?? 'bg-surface-3/60'}`} data-testid="lap-history-row" data-rank={rankOf(r) || undefined}>
      <span className="w-10 text-slate-500 font-mono" title={r.part ? t(`${r.part} つめのまとまり (解析では _${r.part})`, `Part ${r.part} (_${r.part} in analysis)`) : undefined}>{r.part ? `${r.part}-` : ''}L{r.n}</span>
      <span className={`font-mono font-bold w-20 ${RANK_STYLE[rankOf(r)]?.text ?? 'text-slate-100'}`}>{formatLapTime(r.time, 3)}</span>
      {withDate && <span className="text-slate-400 font-mono text-[11px]">{fmtDate(r.startMs || r.runStartMs)}</span>}
      <span className="hidden sm:flex gap-2 text-slate-400 font-mono text-[11px] flex-1 min-w-0 truncate">
        {r.sectors.map((s, i) => <span key={i}>S{i + 1} {s.toFixed(3)}</span>)}
      </span>
      <span className="text-slate-500 text-[11px] ml-auto whitespace-nowrap">{r.topSpeed.toFixed(0)} km/h</span>
      <button onClick={() => toggle(r)} className="p-1 rounded text-slate-400 hover:text-fg" title={r.hidden ? t('表示に戻す', 'Show') : t('この周を隠す (ファイルは消しません)', 'Hide this lap (the file is kept)')} aria-label={r.hidden ? t('表示に戻す', 'Show') : t('隠す', 'Hide')}>
        {r.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-stretch sm:items-center justify-center sm:p-4" role="dialog" aria-label={t('ラップタイムの記録', 'Lap time records')}>
      <div className="bg-surface-2 border border-line-2 sm:rounded-2xl w-full max-w-3xl sm:max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-slate-200">
        {/* スマートフォンでは画面いっぱいに出すので、上の切り欠き・時計の下から始める */}
        <div className="flex items-center gap-2 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-3 border-b border-line-2 bg-surface-1">
          <h3 className="text-sm font-bold flex-1">{t('ラップタイムの記録', 'Lap time records')}</h3>
          <button onClick={() => { void load(store); }} disabled={busy !== null} className="p-1.5 rounded-lg text-slate-400 hover:text-fg disabled:opacity-40" title={t('読み直す', 'Reload')} aria-label={t('読み直す', 'Reload')}><RefreshCw size={15} /></button>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-fg" aria-label={t('閉じる', 'Close')}><X size={18} /></button>
        </div>

        <div className="px-4 py-3 space-y-3 border-b border-line-2">
          {desktop && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400 truncate flex-1 min-w-0" title={folderPath ?? ''}>{folderPath ?? t('保管場所を選んでいません', 'No folder chosen')}</span>
              <button onClick={() => { void pickFolder(); }} disabled={busy !== null} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-surface-4 hover:bg-surface-5 border border-line-4 whitespace-nowrap disabled:opacity-40" data-testid="lap-history-pick">
                <FolderOpen size={13} />{t('保管場所を選ぶ', 'Choose folder')}
              </button>
            </div>
          )}
          {folders && folders.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select value={selected} onChange={e => setSelected(e.target.value)} className="bg-surface-0 border border-line-3 rounded-lg px-2 py-1.5 max-w-full" aria-label={t('コース', 'Course')}>
                {folders.map(f => <option key={f.folder} value={f.folder}>{f.courseName ? circuitLabel(f.courseName) : f.folder === 'unsorted' ? t('未分類', 'Unsorted') : f.folder}</option>)}
              </select>
              <select value={sort} onChange={e => setSort(e.target.value as SortKey)} className="bg-surface-0 border border-line-3 rounded-lg px-2 py-1.5" aria-label={t('並べ方', 'Sort')}>
                <option value="date">{t('走った順', 'By run')}</option>
                <option value="time">{t('タイム順', 'By lap time')}</option>
              </select>
              <label className="flex items-center gap-1.5 text-slate-400">
                <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />
                {t('隠した周も出す', 'Show hidden laps')}
              </label>
            </div>
          )}
          {current && current.courseName && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
              <span>{t('ベスト', 'Best')} <b className="text-fuchsia-400 font-mono">{best !== null ? formatLapTime(best, 3) : '—'}</b></span>
              {top3[1] !== undefined && <span>2nd <b className="text-emerald-400 font-mono">{formatLapTime(top3[1], 3)}</b></span>}
              {top3[2] !== undefined && <span>3rd <b className="text-amber-400 font-mono">{formatLapTime(top3[2], 3)}</b></span>}
              <span>{t(`${current.rows.filter(r => !r.hidden).length} 周`, `${current.rows.filter(r => !r.hidden).length} lap${(current.rows.filter(r => !r.hidden).length) === 1 ? '' : 's'}`)}</span>
              <span>{t(`${current.fileCount} 走行`, `${current.fileCount} run${current.fileCount === 1 ? '' : 's'}`)}</span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" data-testid="lap-history-list">
          {busy !== null && <div className="text-xs text-slate-400">{busy ? t(`計算しています: ${busy}`, `Calculating: ${busy}`) : t('読み込んでいます…', 'Loading…')}</div>}
          {error && <div className="text-xs text-amber-400">{t(`読み込めませんでした: ${error}`, `Could not load: ${error}`)}</div>}
          {busy === null && folders && folders.length === 0 && !error && (
            <div className="text-xs text-slate-400 leading-relaxed">
              {desktop && !folderPath
                ? t('ラップタイマーの記録を置いたフォルダ (iPhone で選んだ iCloud Drive のフォルダなど) を選んでください。その中のサーキットのフォルダの .bon4 から周を数えます。',
                  'Choose the folder where lap timer runs are kept (such as the iCloud Drive folder chosen on the iPhone). Laps are counted from the .bon4 files in its circuit folders.')
                : t('まだ記録がありません。', 'No records yet.')}
            </div>
          )}
          {current && !current.courseName && (
            <div className="text-xs text-amber-400">{t(`フォルダ「${current.folder}」のコースが分からないので、周を数えられません (コース編集の保存フォルダ名をこのフォルダ名にすると数えます)。`, `The course for folder "${current.folder}" is unknown, so laps cannot be counted (set this folder name as the folder name in the course editor).`)}</div>
          )}
          {current?.courseName && visible.length === 0 && busy === null && (
            <div className="text-xs text-slate-400">{t('周がありません。', 'No laps.')}</div>
          )}
          {sort === 'date'
            ? runs.map(([file, rows]) => {
              const runBest = Math.min(...rows.filter(r => !r.hidden).map(r => r.time));
              return (
                <div key={file} className="space-y-1">
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="font-bold text-slate-200 whitespace-nowrap">{fmtDate(rows[0].runStartMs)}</span>
                    <span className="text-slate-500">{t(`${rows.length} 周`, `${rows.length} lap${(rows.length) === 1 ? '' : 's'}`)}{Number.isFinite(runBest) ? ` · ${t('ベスト', 'best')} ${formatLapTime(runBest, 3)}` : ''}</span>
                    {/* ファイル名は、幅のある画面だけ (スマートフォンでは日付が折れないように) */}
                    <span className="hidden sm:inline text-slate-600 text-[10px] ml-auto truncate">{file}</span>
                    {onOpenRun && (
                      <button onClick={() => { void openRun(file); }} className="ml-auto sm:ml-0 flex items-center gap-1 px-2 py-0.5 rounded bg-surface-4 hover:bg-surface-5 border border-line-4 text-[11px] text-slate-200 whitespace-nowrap" data-testid="lap-history-open">
                        <BarChart3 size={11} />{t('解析で開く', 'Analyse')}
                      </button>
                    )}
                  </div>
                  {rows.map(r => lapLine(r, false))}
                </div>
              );
            })
            : <div className="space-y-1">{byTime.map(r => lapLine(r, true))}</div>}
        </div>
      </div>
    </div>
  );
};
