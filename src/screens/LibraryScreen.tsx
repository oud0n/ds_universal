import React, { useMemo, useState } from 'react';
import { BarChart2, ChevronRight, Cloud, EyeOff, FolderOpen, Loader2, Trophy, Video, X } from 'lucide-react';
import { useT } from '../utils/i18n';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { formatLapTime } from '../services/liveLapTimer';
import { RunRow, fmtDate, useRuns } from '../components/RecentRuns';
import { LapHistoryPanel } from '../components/LapHistoryPanel';
import { useStorageLabel } from '../components/StorageSettings';
import { baseName, setRunLapHidden, type RunItem } from '../services/runOpener';
import { navStore } from '../app/navStore';

/** 一度に出す行の数 (数千件あっても固まらないよう、続きは「さらに表示」で足す) */
const PAGE = 150;

interface Props {
  active: boolean;
  /** 横に広い画面 (デスクトップ・iPad)。走行の詳細を右の欄に出す。狭いときは画面いっぱいのシート */
  wide: boolean;
  onOpen: (r: RunItem) => void;
  onOpenVideo: (r: RunItem) => void;
  onPickFiles: () => void;
  /** ラップタイムの記録から、走行のファイルを解析で開く */
  onOpenFile: (file: File) => void;
  busy: boolean;
}

/** 日付の見出し (端末の時刻で) */
function dayKey(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 走行 (保管場所の一覧)。2026-10-21 (PLAN-24 の 3)。
 * 保管場所の 1 行 / サーキットで絞る / 日付ごとの走行 / 下に「ファイルを選ぶ」「ラップタイムの記録」。
 * 行を押すと走行の詳細 (周の一覧・動画・解析で開く・動画を見る)
 */
export const LibraryScreen: React.FC<Props> = ({ active, wide, onOpen, onOpenVideo, onPickFiles, onOpenFile, busy }) => {
  const t = useT();
  const ja = t('ja', 'en') === 'ja';
  const { store, runs, error, noFolder, reload } = useRuns(active);
  const storageLabel = useStorageLabel();
  const [folder, setFolder] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const folders = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const r of runs ?? []) {
      const cur = m.get(r.folder);
      m.set(r.folder, { label: r.courseName ?? r.folder, count: (cur?.count ?? 0) + 1 });
    }
    return [...m.entries()];
  }, [runs]);
  const filtered = useMemo(() => (runs ?? []).filter(r => !folder || r.folder === folder), [runs, folder]);
  const selected = filtered.find(r => `${r.folder}/${r.file}` === selectedKey) ?? null;

  if (!active) return null;

  // 日付ごとにまとめる (並びは新しい順のまま)
  const groups: { day: string; items: RunItem[] }[] = [];
  for (const r of filtered.slice(0, shown)) {
    const day = dayKey(r.startMs);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(r);
    else groups.push({ day, items: [r] });
  }
  const dayLabel = (day: string) => {
    if (!day) return t('日時が分からない走行', 'Unknown date');
    const [y, m, d] = day.split('-').map(Number);
    const w = (ja ? ['日', '月', '火', '水', '木', '金', '土'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])[new Date(y, m - 1, d).getDay()];
    return ja ? `${y}年${m}月${d}日 (${w})` : `${w}, ${y}-${m}-${d}`;
  };

  const select = (r: RunItem) => setSelectedKey(`${r.folder}/${r.file}`);

  const list = (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 保管場所の 1 行 (押すと設定の保管場所へ) */}
      {storageLabel && (
        <button
          onClick={() => navStore.go('settings')}
          className="mx-3 mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-line-2 text-xs text-slate-300 cursor-pointer hover:bg-surface-3"
          data-testid="library-storage"
        >
          <FolderOpen size={14} className="shrink-0 text-slate-400" />
          <span className="truncate flex-1 text-left">{storageLabel}</span>
          <ChevronRight size={14} className="text-slate-500 shrink-0" />
        </button>
      )}
      {folders.length > 1 && (
        <div className="flex gap-1.5 px-3 pt-3 overflow-x-auto shrink-0">
          {[[null, { label: t('すべて', 'All'), count: runs?.length ?? 0 }] as const, ...folders].map(([f, { label, count }]) => (
            <button
              key={f ?? '*'}
              onClick={() => { setFolder(f); setShown(PAGE); }}
              className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap border cursor-pointer ${folder === f ? 'bg-sky-600 border-sky-500 text-white' : 'bg-surface-3 border-line-2 text-slate-300'}`}
            >
              {label} <span className="opacity-70">{count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4" data-testid="library-list">
        {runs === null && (
          <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center"><Loader2 size={14} className="animate-spin" />{t('走行を読み込んでいます…', 'Loading runs…')}</div>
        )}
        {noFolder && (
          <div className="text-xs text-slate-400 py-4 text-center space-y-3">
            <p>{t('走行の保管場所が決まっていません。設定で、サーキットごとのフォルダが並ぶ場所を選ぶと、過去の走行をここから開けます。', 'No storage folder is set. Choose one in Settings to open past runs here.')}</p>
            <button onClick={() => navStore.go('settings')} className="px-3 py-2 rounded-lg bg-surface-3 border border-line-2 text-slate-200 cursor-pointer">{t('保管場所を選ぶ', 'Choose folder')}</button>
          </div>
        )}
        {error && <p className="text-xs text-red-400 py-2">{error}</p>}
        {runs && runs.length === 0 && !noFolder && !error && (
          <p className="text-xs text-slate-400 py-6 text-center">{t('保管場所に走行がありません。', 'No runs in the storage folder.')}</p>
        )}
        {groups.map(g => (
          <div key={g.day || 'none'}>
            <div className="text-[11px] font-bold text-slate-400 px-1 pb-1.5 sticky top-0 bg-surface-0/95 z-[1]">{dayLabel(g.day)}</div>
            <div className="space-y-1.5">
              {g.items.map(r => (
                <RunRow key={`${r.folder}/${r.file}`} run={r} onOpen={select} busy={busy} selected={wide && `${r.folder}/${r.file}` === selectedKey} />
              ))}
            </div>
          </div>
        ))}
        {filtered.length > shown && (
          <button onClick={() => setShown(n => n + PAGE)} className="w-full py-2.5 rounded-lg bg-surface-2 border border-line-2 text-xs text-slate-300 cursor-pointer" data-testid="library-more">
            {t(`さらに表示 (残り ${filtered.length - shown} 件)`, `Show more (${filtered.length - shown} left)`)}
          </button>
        )}
      </div>
      <div className="shrink-0 flex gap-2 px-3 pb-3">
        <button
          onClick={onPickFiles}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-sm text-white font-bold cursor-pointer"
          data-testid="runs-pick-files"
        >
          <FolderOpen size={16} />{t('ファイルを選ぶ', 'Choose files')}
        </button>
        <button
          onClick={() => setHistoryOpen(true)}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-surface-2 border border-line-2 text-sm text-slate-200 font-bold cursor-pointer"
          data-testid="library-lap-history"
        >
          <Trophy size={16} />{t('ラップタイムの記録', 'Lap records')}
        </button>
      </div>
    </div>
  );

  const detail = selected && store && (
    <RunDetail
      run={selected}
      busy={busy}
      onOpen={() => onOpen(selected)}
      onOpenVideo={() => onOpenVideo(selected)}
      onToggleLap={async (lap, hide) => { await setRunLapHidden(store, selected, lap, hide); reload(); }}
      onClose={wide ? undefined : () => setSelectedKey(null)}
    />
  );

  return (
    <div className="h-full flex" data-testid="library-screen">
      {wide ? (
        <>
          <div className="flex-1 min-w-0 max-w-3xl flex flex-col">{list}</div>
          <div className="w-[380px] shrink-0 border-l border-line-2 flex flex-col min-h-0" data-testid="library-detail-pane">
            {detail || <p className="text-xs text-slate-500 p-6 text-center">{t('走行を選ぶと、周の一覧と動画が出ます。', 'Select a run to see its laps and videos.')}</p>}
          </div>
        </>
      ) : (
        <>
          <div className="flex-1 min-w-0 flex flex-col max-w-2xl mx-auto">{list}</div>
          {detail && <div className="absolute inset-0 z-[35] bg-surface-0 flex flex-col">{detail}</div>}
        </>
      )}
      {historyOpen && <LapHistoryPanel onClose={() => setHistoryOpen(false)} onOpenRun={file => { setHistoryOpen(false); onOpenFile(file); }} />}
    </div>
  );
};

/** 走行の詳細 (周の一覧・動画・解析で開く・動画を見る) */
const RunDetail: React.FC<{
  run: RunItem;
  busy: boolean;
  onOpen: () => void;
  onOpenVideo: () => void;
  onToggleLap: (lap: RunItem['laps'][number], hide: boolean) => Promise<void>;
  /** 狭い画面のシートを閉じる (広い画面では右の欄なので無い) */
  onClose?: () => void;
}> = ({ run, busy, onOpen, onOpenVideo, onToggleLap, onClose }) => {
  const t = useT();
  const ja = t('ja', 'en') === 'ja';
  const [order, setOrder] = useState<'run' | 'time'>('run');
  useEscapeKey(!!onClose, () => onClose?.());
  const visible = run.laps.filter(l => !l.hidden);
  const best = visible.length ? Math.min(...visible.map(l => l.time)) : null;
  const laps = order === 'time' ? [...run.laps].sort((a, b) => a.time - b.time) : run.laps;
  // 付いている動画 (runs.json) と、同じフォルダのそのほかの動画
  const attached = new Set(run.videos);
  const videos = run.folderVideos.filter(v => !/\.lrv$/i.test(v.path));
  const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="run-detail">
      <div className="px-4 py-3 border-b border-line-2 flex items-start gap-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-slate-100">{fmtDate(run.startMs, ja)} {run.courseName ?? run.folder}</div>
          <div className="text-xs text-slate-400 mt-0.5">
            {run.pending
              ? t('☁️ iCloud にだけあるので、開くと周を数えます', '☁️ Only in iCloud; laps are counted when opened')
              : <>{t('ベスト', 'Best')} <span className="font-mono font-bold text-fuchsia-400">{best !== null ? formatLapTime(best) : '--'}</span> ・ {t(`${visible.length} 周`, `${visible.length} laps`)}</>}
            {run.videos.length > 0 && <> ・ <Video size={11} className="inline" /> {run.videos.length}{run.synced ? t(' (同期済み)', ' (synced)') : ''}</>}
          </div>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1.5 rounded hover:bg-surface-3 text-slate-400 cursor-pointer" aria-label={t('閉じる', 'Close')} data-testid="run-detail-close"><X size={18} /></button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {run.laps.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-bold text-slate-300 flex-1">{t('周', 'Laps')}</span>
              {(['run', 'time'] as const).map(o => (
                <button key={o} onClick={() => setOrder(o)} className={`px-2.5 py-1 rounded-full text-[11px] border cursor-pointer ${order === o ? 'bg-sky-600 border-sky-500 text-white' : 'border-line-2 text-slate-400'}`}>
                  {o === 'run' ? t('走った順', 'In order') : t('タイム順', 'By time')}
                </button>
              ))}
            </div>
            <div className="space-y-1">
              {laps.map(l => (
                <div key={`${l.part ?? 1}-${l.n}`} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm ${l.hidden ? 'opacity-40' : l.time === best ? 'bg-fuchsia-500/10' : ''}`}>
                  <span className="w-12 text-xs text-slate-400">{l.part ? `${l.part}-` : ''}L{l.n}</span>
                  <span className={`font-mono font-bold flex-1 ${!l.hidden && l.time === best ? 'text-fuchsia-400' : 'text-slate-200'}`}>{formatLapTime(l.time)}</span>
                  <button
                    onClick={() => void onToggleLap(l, !l.hidden)}
                    className="p-1 rounded text-slate-500 hover:text-slate-300 cursor-pointer"
                    title={l.hidden ? t('出す', 'Show') : t('隠す (ピットイン・赤旗の周など)', 'Hide (pit, red flag laps etc.)')}
                    aria-label={l.hidden ? t('出す', 'Show') : t('隠す', 'Hide')}
                  >
                    <EyeOff size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        <section>
          <div className="text-xs font-bold text-slate-300 mb-2">{t('動画', 'Videos')}</div>
          {videos.length === 0 && <p className="text-xs text-slate-500">{t('同じフォルダに動画がありません。', 'No videos in the same folder.')}</p>}
          <div className="space-y-1">
            {videos.map(v => (
              <div key={v.path} className="flex items-center gap-2 text-xs text-slate-300 px-1 py-1">
                {v.local ? <Video size={13} className={attached.has(baseName(v.path)) ? 'text-sky-400' : 'text-slate-500'} /> : <Cloud size={13} className="text-amber-500" />}
                <span className="truncate flex-1">{baseName(v.path)}</span>
                <span className="text-slate-500">{v.local ? (attached.has(baseName(v.path)) ? (run.synced ? t('同期済み', 'Synced') : t('付いている', 'Attached')) : gb(v.size)) : t(`iCloud ${gb(v.size)}`, `iCloud ${gb(v.size)}`)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="shrink-0 flex gap-2 px-4 py-3 border-t border-line-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button onClick={onOpen} disabled={busy} className="flex-1 inline-flex items-center justify-center gap-1.5 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-sm cursor-pointer disabled:opacity-50" data-testid="run-open-analysis">
          <BarChart2 size={16} />{t('解析で開く', 'Open in Graph')}
        </button>
        <button onClick={onOpenVideo} disabled={busy || videos.length === 0} className="flex-1 inline-flex items-center justify-center gap-1.5 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm cursor-pointer disabled:opacity-40" data-testid="run-open-video">
          <Video size={16} />{t('動画を見る', 'Watch video')}
        </button>
      </div>
    </div>
  );
};
