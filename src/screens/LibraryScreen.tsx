import { sameCourseName } from '../utils/courseNames';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart2, Bluetooth, ChevronRight, Cloud, EyeOff, FolderOpen, GitCompare, Loader2, Timer, Trophy, Video, X } from 'lucide-react';
import { circuitLabel, useT } from '../utils/i18n';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { formatLapTime } from '../services/liveLapTimer';
import { RunRow, fmtDate, useRuns } from '../components/RecentRuns';
import { LapHistoryPanel } from '../components/LapHistoryPanel';
import { runStem } from '../services/lapIndex';
import { useStorageLabel } from '../components/StorageSettings';
import { baseName, setRunLapHidden, setRunMeta, type RunItem } from '../services/runOpener';
import { RunNoteField } from '../components/RunNoteField';
import { navStore } from '../app/navStore';
import { deleteSession, listSessions, type LapSession, type SavedSession } from '../services/analysisSessions';
import { deleteRun, planRunDelete, type RunDeletePlan } from '../services/runDelete';
import { canRemoveRunFiles, type RunFileInfo } from '../services/runStore';
import { listVideoRefs, removeVideoLaps, videoRefCandidates, type VideoRef } from '../services/videoLaps';
import { VideoLapCompare, VideoLapMarker, VideoRefPicker } from '../components/VideoRefLaps';

/** 一度に出す行の数 (数千件あっても固まらないよう、続きは「さらに表示」で足す) */
const PAGE = 150;

interface Props {
  active: boolean;
  /** 横に広い画面 (デスクトップ・iPad)。走行の詳細を右の欄に出す。狭いときは画面いっぱいのシート */
  wide: boolean;
  onOpen: (r: RunItem) => void;
  /** 保存した比べ方 (解析用のセッション。PLAN-18) を開く */
  onOpenSession?: (s: LapSession) => void;
  onOpenVideo: (r: RunItem) => void;
  /** 比べる相手 (Car 2) として足す (走行をもう開いているときだけ) */
  onAddAsCar2?: (r: RunItem) => void;
  /** 今の Car 1 のコース (Car 2 として足せるのは、同じコースの走行だけ) */
  car1Course?: string | null;
  /** Car 1 の走行 (folder/file)。同じ走行は Car 2 にできない */
  car1Run?: string | null;
  /** 解析で開いている走行 (folder/file)。開いている走行は消せない */
  openRuns?: string[];
  onPickFiles: () => void;
  /** ラップタイムの記録から、走行のファイルを解析で開く */
  onOpenFile: (file: File) => void;
  busy: boolean;
  /** ラップタイマーを使える (アプリ)。初めて開いたときの案内に出す */
  canTime?: boolean;
}

/** 周も動画もない走行 (測定開始のボタンを足す前の、開いただけの記録など。LATER-18) */
const isEmptyRun = (r: RunItem) => !r.pending && r.laps.length === 0 && r.videos.length === 0 && r.folderVideos.length === 0 && r.courseName === null;

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
/** 同じ走行のファイルか (日付のフォルダが同じで、拡張子 .nmea / .bon4 を除いた名前が同じ) */
const sameRunFile = (a: string, b: string) => {
  const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  return dir(a) === dir(b) && runStem(a) === runStem(b);
};

export const LibraryScreen: React.FC<Props> = ({ active, wide, onOpen, onOpenSession, onOpenVideo, onAddAsCar2, car1Course = null, car1Run = null, openRuns = [], onPickFiles, onOpenFile, busy, canTime = false }) => {
  const t = useT();
  const ja = t('ja', 'en') === 'ja';
  const { store, runs, error, noFolder, reload } = useRuns(active);
  const storageLabel = useStorageLabel(active);
  const [folder, setFolder] = useState<string | null>(null);
  /** 自分の走行か、参考ラップ (自分のではない走行。PLAN-31) か */
  const [owner, setOwner] = useState<'mine' | 'ref'>('mine');
  const [shown, setShown] = useState(PAGE);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 中身のない走行 (周も動画もない) を開いて見せている日 */
  const [showEmpty, setShowEmpty] = useState<Set<string>>(() => new Set());
  /** 走行のファイルを消せる置き場か (前の版のアプリ・ブラウザ版では消せない) */
  const [canDelete, setCanDelete] = useState(false);
  useEffect(() => { let alive = true; void canRemoveRunFiles(store).then(v => { if (alive) setCanDelete(v); }); return () => { alive = false; }; }, [store]);
  /** 消す確かめの画面 (走行と、消すファイルの案) */
  const [deleting, setDeleting] = useState<{ item: RunItem; plan: RunDeletePlan | null; error?: string; running?: boolean } | null>(null);
  /** 保存した比べ方 (解析用のセッション)。走行を読み直すたびに読み直す */
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  /** 動画だけの参考ラップ (LATER-17)。走行を読み直すたびに読み直す */
  const [videoRefs, setVideoRefs] = useState<VideoRef[]>([]);
  const [refsTick, setRefsTick] = useState(0);
  useEffect(() => {
    if (!active || !store) return;
    let alive = true;
    void listVideoRefs(store).then(l => { if (alive) setVideoRefs(l); }, () => {});
    return () => { alive = false; };
  }, [active, store, runs, refsTick]);
  /** 参考ラップにする動画を選ぶ画面 (null: 探している) / 印を打つ画面 / 比べる画面 */
  const [picking, setPicking] = useState<RunFileInfo[] | null | false>(false);
  const [marking, setMarking] = useState<{ path: string; existing: VideoRef | null } | null>(null);
  const [comparing, setComparing] = useState<VideoRef | null>(null);
  const startPick = () => {
    if (!store) return;
    setPicking(null);
    void store.listAll().then(files => setPicking(videoRefCandidates(files, runs ?? [], videoRefs)), () => setPicking([]));
  };
  useEffect(() => {
    if (!active || !store || !onOpenSession) return;
    let alive = true;
    void listSessions(store).then(l => { if (alive) setSavedSessions(l); }, () => {});
    return () => { alive = false; };
  }, [active, store, runs, onOpenSession]);

  const folders = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const r of runs ?? []) {
      const cur = m.get(r.folder);
      m.set(r.folder, { label: r.courseName ?? r.folder, count: (cur?.count ?? 0) + 1 });
    }
    return [...m.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);
  const refCount = useMemo(() => (runs ?? []).filter(r => !!r.entry?.reference).length, [runs]) + videoRefs.length;
  // 参考ラップの区切りは、走行があれば出す (動画だけの参考ラップをそこから作れるように)
  const showOwner = !!store && (runs?.length ?? 0) > 0;
  const ownerNow = showOwner ? owner : 'mine';
  const filtered = useMemo(() => (runs ?? []).filter(r => (!folder || r.folder === folder) && (ownerNow === 'ref') === !!r.entry?.reference), [runs, folder, ownerNow]);
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
    return ja ? `${y}年${m}月${d}日 (${w})` : `${w}, ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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
          <span className="truncate flex-1 text-left" title={storageLabel}>{storageLabel}</span>
          <ChevronRight size={14} className="text-slate-500 shrink-0" />
        </button>
      )}
      {/* 参考ラップがあるときだけ、自分の走行と分けて出す */}
      {showOwner && (
        <div className="flex gap-1 px-3 pt-3 shrink-0" data-testid="library-owner">
          {(['mine', 'ref'] as const).map(o => (
            <button key={o} onClick={() => { setOwner(o); setShown(PAGE); setSelectedKey(null); }}
              className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-bold border cursor-pointer ${ownerNow === o ? 'bg-sky-600 border-sky-500 text-white' : 'bg-surface-2 border-line-2 text-slate-300'}`}
              data-testid={`library-owner-${o}`}>
              {o === 'mine' ? t('自分の走行', 'My runs') : refCount ? t(`参考ラップ ${refCount}`, `Reference laps ${refCount}`) : t('参考ラップ', 'Reference laps')}
            </button>
          ))}
        </div>
      )}
      {folders.length > 1 && (
        <div className="flex gap-1.5 px-3 pt-3 overflow-x-auto shrink-0">
          {[[null, { label: t('すべて', 'All'), count: runs?.length ?? 0 }] as const, ...folders].map(([f, { label, count }]) => (
            <button
              key={f ?? '*'}
              onClick={() => { setFolder(f); setShown(PAGE); setSelectedKey(null); }}
              className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap border cursor-pointer ${folder === f ? 'bg-sky-600 border-sky-500 text-white' : 'bg-surface-3 border-line-2 text-slate-300'}`}
            >
              {f === 'unsorted' && label === 'unsorted' ? t('未分類', 'Unsorted') : f !== null ? circuitLabel(label) : label} <span className="opacity-70">{count}</span>
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
        {/* 保存した比べ方 (解析で Car に割り当てた組み合わせ。PLAN-18) */}
        {onOpenSession && store && savedSessions.length > 0 && (
          <div data-testid="library-sessions">
            <button onClick={() => setSessionsOpen(o => !o)} className="w-full flex items-center gap-1 text-[11px] font-bold text-slate-400 px-1 pb-1.5 cursor-pointer">
              <GitCompare size={12} />{t(`保存した比べ方 ${savedSessions.length}`, `Saved comparisons ${savedSessions.length}`)}
              <span className="ml-auto">{sessionsOpen ? '−' : '+'}</span>
            </button>
            {sessionsOpen && (
              <div className="space-y-1.5">
                {savedSessions.map(s => (
                  <div key={s.path} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2 border border-line-2" data-testid="library-session-row">
                    <button onClick={() => onOpenSession(s.data)} disabled={busy} className="flex-1 min-w-0 text-left cursor-pointer disabled:opacity-50">
                      <div className="text-xs font-bold text-slate-100 truncate">{s.data.name}</div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {s.data.course?.name ? `${circuitLabel(s.data.course.name)} · ` : ''}{t(`${s.data.cars.length} 台`, `${s.data.cars.length} car${s.data.cars.length === 1 ? '' : 's'}`)} · {fmtDate(Date.parse(s.data.createdAt) || null, ja)}
                      </div>
                    </button>
                    <button
                      onClick={() => {
                        if (!window.confirm(t(`「${s.data.name}」を消しますか？ (走行は消えません)`, `Delete "${s.data.name}"? (The runs are kept)`))) return;
                        void deleteSession(store, s.path).then(() => setSavedSessions(l => l.filter(x => x.path !== s.path)));
                      }}
                      className="p-1.5 rounded text-slate-500 hover:text-red-400 cursor-pointer" aria-label={t('消す', 'Delete')} data-testid="library-session-delete"
                    ><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* 動画だけの参考ラップ (LATER-17)。参考ラップの区切りの上に */}
        {ownerNow === 'ref' && store && (
          <div className="space-y-1.5" data-testid="library-video-refs">
            <div className="flex items-center gap-2 px-1">
              <span className="text-[11px] font-bold text-slate-400 flex-1">{t(`動画だけの参考ラップ ${videoRefs.length}`, `Video-only reference laps ${videoRefs.length}`)}</span>
              <button onClick={startPick} className="flex items-center gap-1 px-2 py-1 rounded border border-line-3 hover:border-sky-500 text-[11px] text-slate-300 cursor-pointer" data-testid="library-video-ref-new">
                <Video size={12} />{t('動画から作る', 'From a video')}
              </button>
            </div>
            {videoRefs.filter(r => !folder || r.folder === folder).map(r => {
              const best = r.laps.length ? Math.min(...r.laps.map(l => l.time)) : null;
              return (
                <div key={r.path} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2 border border-line-2" data-testid="library-video-ref-row">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-slate-100 truncate">{r.row.name || r.file.slice(r.file.lastIndexOf('/') + 1)}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {circuitLabel(runs?.find(x => x.folder === r.folder)?.courseName ?? r.folder)}
                      {r.row.reference?.driver ? ` · ${r.row.reference.driver}` : ''}{r.row.reference?.car ? ` · ${r.row.reference.car}` : ''}
                      {` · ${t(`${r.laps.length} 周`, `${r.laps.length} lap${r.laps.length === 1 ? '' : 's'}`)}`}{best !== null ? ` · ${formatLapTime(best)}` : ''}{r.remote ? ' · iCloud' : ''}
                    </div>
                  </div>
                  <button onClick={() => setComparing(r)} disabled={!r.laps.length} className="px-2 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-bold cursor-pointer disabled:opacity-50" data-testid="library-video-ref-compare">{t('比べる', 'Compare')}</button>
                  <button onClick={() => setMarking({ path: r.path, existing: r })} className="px-2 py-1 rounded border border-line-3 text-slate-300 text-[11px] cursor-pointer" data-testid="library-video-ref-edit">{t('印', 'Marks')}</button>
                  <button
                    onClick={() => {
                      if (!window.confirm(t('この参考ラップをやめますか？ (動画のファイルは消えません)', 'Remove this reference lap? (The video file is kept)'))) return;
                      void removeVideoLaps(store, r).then(() => setRefsTick(n => n + 1));
                    }}
                    className="p-1.5 rounded text-slate-500 hover:text-red-400 cursor-pointer" aria-label={t('消す', 'Delete')} data-testid="library-video-ref-delete"
                  ><X size={14} /></button>
                </div>
              );
            })}
          </div>
        )}
        {runs && runs.length === 0 && !noFolder && !error && (
          // 初めて開いたとき: 次にすることを並べる
          <div className="py-6 space-y-3 max-w-sm mx-auto" data-testid="library-first-steps">
            <p className="text-xs text-slate-400 text-center">{t('まだ走行がありません。はじめに:', 'No runs yet. To get started:')}</p>
            {canTime && (
              <button onClick={() => navStore.go('timer')} className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-surface-1 border border-line-2 text-sm text-slate-200 cursor-pointer hover:bg-surface-3">
                <Timer size={16} className="text-red-500" />{t('ラップタイマーで測る', 'Time laps with the lap timer')}
              </button>
            )}
            {canTime && (
              <button onClick={() => navStore.go('logger')} className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-surface-1 border border-line-2 text-sm text-slate-200 cursor-pointer hover:bg-surface-3">
                <Bluetooth size={16} className="text-sky-500" />{t('機器を登録する (デジスパイス・RaceBox・Drogger など)', 'Register a device (DigSpice, RaceBox, Drogger…)')}
              </button>
            )}
            <button onClick={onPickFiles} className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-surface-1 border border-line-2 text-sm text-slate-200 cursor-pointer hover:bg-surface-3">
              <FolderOpen size={16} className="text-slate-400" />{t('ログや動画のファイルを開く', 'Open log or video files')}
            </button>
          </div>
        )}
        {groups.map(g => (
          <div key={g.day || 'none'}>
            <div className="text-[11px] font-bold text-slate-400 px-1 pb-1.5 sticky top-0 bg-surface-0/95 z-[1]">{dayLabel(g.day)}</div>
            <div className="space-y-1.5">
              {g.items.filter(r => !isEmptyRun(r) || showEmpty.has(g.day)).map(r => (
                <RunRow key={`${r.folder}/${r.file}`} run={r} onOpen={select} busy={busy} selected={wide && `${r.folder}/${r.file}` === selectedKey} />
              ))}
              {/* 中身のない走行 (測定開始の前の記録など) はまとめて 1 行に */}
              {showEmpty.has(g.day) && g.items.some(isEmptyRun) && (
                <button
                  onClick={() => setShowEmpty(s => { const n = new Set(s); n.delete(g.day); return n; })}
                  className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-line-2 text-xs text-slate-500 cursor-pointer hover:bg-surface-2"
                  data-testid="library-empty-runs-fold"
                >
                  {t(`周も動画もない走行 ${g.items.filter(isEmptyRun).length} 件をたたむ`, `Hide ${g.items.filter(isEmptyRun).length} run${g.items.filter(isEmptyRun).length === 1 ? '' : 's'} without laps or videos`)}
                </button>
              )}
              {!showEmpty.has(g.day) && g.items.some(isEmptyRun) && (
                <button
                  onClick={() => setShowEmpty(s => new Set(s).add(g.day))}
                  className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-line-2 text-xs text-slate-500 cursor-pointer hover:bg-surface-2"
                  data-testid="library-empty-runs"
                >
                  {t(`周も動画もない走行 ${g.items.filter(isEmptyRun).length} 件 (表示する)`, `${g.items.filter(isEmptyRun).length} run${g.items.filter(isEmptyRun).length === 1 ? '' : 's'} without laps or videos (show)`)}
                </button>
              )}
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
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-sm text-white font-bold cursor-pointer whitespace-nowrap"
          data-testid="runs-pick-files"
        >
          <FolderOpen size={16} />{t('ファイルを選ぶ', 'Choose files')}
        </button>
        <button
          onClick={() => setHistoryOpen(true)}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg bg-surface-2 border border-line-2 text-sm text-slate-200 font-bold cursor-pointer whitespace-nowrap"
          data-testid="library-lap-history"
        >
          {/* スマートフォンの幅でも 1 行に収まる長さ */}
          <Trophy size={16} />{t('ラップタイム', 'Lap records')}
        </button>
      </div>
    </div>
  );

  const detail = selected && store && (
    <RunDetail
      run={selected}
      busy={busy}
      // 開いたら詳細は閉じる (走行のタブに戻ったとき、前の詳細が出たままにならないように)
      onOpen={() => { setSelectedKey(null); onOpen(selected); }}
      onOpenVideo={() => { setSelectedKey(null); onOpenVideo(selected); }}
      onAddAsCar2={onAddAsCar2 ? () => { setSelectedKey(null); onAddAsCar2(selected); } : undefined}
      // 同じコースか: Car 1 と同じフォルダ (コースごとのフォルダ) の走行か、コースの名前が同じコースを指すとき。
      // 未分類のフォルダはいろいろなコースの走行が入るので、フォルダが同じでも同じコースとはみなさない
      otherCourse={!!onAddAsCar2 && !!car1Course
        && !(car1Run !== null && selected.folder !== 'unsorted' && car1Run.slice(0, car1Run.indexOf('/')) === selected.folder)
        && !sameCourseName(selected.courseName, car1Course)}
      isCar1={car1Run === `${selected.folder}/${selected.file}`}
      onToggleLap={async (lap, hide) => { await setRunLapHidden(store, selected, lap, hide); reload(); }}
      onSaveMeta={async patch => {
        // 参考ラップの印を付けた・外したら、その走行が見える側の一覧に切り替える (詳細を開いたままにする)
        if (patch.reference !== undefined) setOwner(patch.reference ? 'ref' : 'mine');
        await setRunMeta(store, selected, patch).catch(() => undefined);
        reload();
      }}
      onClose={wide ? undefined : () => setSelectedKey(null)}
      onDelete={canDelete ? () => {
        const item = selected;
        setDeleting({ item, plan: null });
        void store.listAll().then(files => setDeleting(d => (d && d.item === item ? { ...d, plan: planRunDelete(item, files, runs ?? []) } : d)),
          e => setDeleting(d => (d ? { ...d, error: e instanceof Error ? e.message : String(e) } : d)));
      } : undefined}
      isOpen={openRuns.includes(`${selected.folder}/${selected.file}`)}
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
      {historyOpen && <LapHistoryPanel onClose={() => setHistoryOpen(false)} onOpenRun={(file, run) => {
        setHistoryOpen(false);
        // 走行の一覧にある走行なら、走行の画面から開くのと同じに開く (Car 1 にする・動画と同期もそろえる)
        const item = runs?.find(r => r.folder === run.folder && sameRunFile(r.file, run.file));
        if (item) onOpen(item); else onOpenFile(file);
      }} />}
      {picking !== false && (
        <VideoRefPicker candidates={picking} onClose={() => setPicking(false)} onPick={f => { setPicking(false); setMarking({ path: f.path, existing: null }); }} />
      )}
      {marking && store && (
        <VideoLapMarker store={store} path={marking.path} existing={marking.existing} onClose={() => setMarking(null)}
          onSaved={() => { setMarking(null); setOwner('ref'); setRefsTick(n => n + 1); }} />
      )}
      {comparing && store && <VideoLapCompare store={store} videoRef={comparing} runs={runs ?? []} onClose={() => setComparing(null)} />}
      {deleting && store && (
        <DeleteRunDialog
          state={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            if (!deleting.plan) return;
            setDeleting(d => (d ? { ...d, running: true, error: undefined } : d));
            try {
              const failed = await deleteRun(store, deleting.item, deleting.plan);
              if (failed.length) {
                setDeleting(d => (d ? { ...d, running: false, error: t(`消せなかったファイルがあります: ${failed.map(f => baseName(f.path)).join(', ')}`, `Some files could not be deleted: ${failed.map(f => baseName(f.path)).join(', ')}`) } : d));
              } else {
                setDeleting(null);
                setSelectedKey(null);
              }
            } catch (e) {
              setDeleting(d => (d ? { ...d, running: false, error: e instanceof Error ? e.message : String(e) } : d));
            }
            reload();
          }}
        />
      )}
    </div>
  );
};

/** 走行を消す確かめの画面 (消すファイルと、残すファイルを理由つきで出す) */
const DeleteRunDialog: React.FC<{
  state: { item: RunItem; plan: RunDeletePlan | null; error?: string; running?: boolean };
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ state, onCancel, onConfirm }) => {
  const t = useT();
  useEscapeKey(true, onCancel);
  const { plan } = state;
  const total = plan ? plan.remove.reduce((n, f) => n + f.size, 0) : 0;
  const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const kind = (k: RunDeletePlan['remove'][number]['kind']) => ({ log: t('ログ', 'Log'), sensor: t('センサー', 'Sensor'), camera: t('内蔵カメラ', 'Camera'), video: t('付けた動画', 'Attached video') }[k]);
  const reason = (r: RunDeletePlan['keep'][number]['reason']) => ({
    'other-run': t('ほかの走行のファイル', 'Belongs to another run'),
    'shared-video': t('ほかの走行にも付いている動画', 'Also attached to another run'),
    'unattached-video': t('この走行に付けていない動画', 'Not attached to this run')
  }[r]);
  const trash = typeof navigator !== 'undefined' && !/Android/i.test(navigator.userAgent);
  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid="run-delete-dialog">
      <div className="w-full max-w-md max-h-[85vh] flex flex-col rounded-2xl bg-surface-1 border border-line-2 shadow-2xl">
        <div className="px-4 py-3 border-b border-line-2">
          <div className="text-sm font-bold text-slate-100">{t('この走行を消しますか？', 'Delete this run?')}</div>
          <div className="text-xs text-slate-400 mt-0.5 truncate">{state.item.folder}/{state.item.file}</div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3 text-xs">
          {!plan && !state.error && <div className="flex items-center gap-2 text-slate-400"><Loader2 size={14} className="animate-spin" />{t('消すファイルを調べています…', 'Checking files…')}</div>}
          {plan && (
            <>
              <div>
                <div className="font-bold text-slate-300 mb-1">{t(`消すファイル (${plan.remove.length} 件・${size(total)})`, `Files to delete (${plan.remove.length}, ${size(total)})`)}</div>
                <div className="space-y-0.5" data-testid="run-delete-remove">
                  {plan.remove.map(f => (
                    <div key={f.path} className="flex gap-2 text-slate-300"><span className="truncate flex-1">{baseName(f.path)}</span><span className="text-slate-500 shrink-0">{kind(f.kind)} · {size(f.size)}</span></div>
                  ))}
                </div>
              </div>
              {plan.keep.length > 0 && (
                <div>
                  <div className="font-bold text-slate-300 mb-1">{t('同じフォルダで残すファイル', 'Kept in the same folder')}</div>
                  <div className="space-y-0.5" data-testid="run-delete-keep">
                    {plan.keep.map(f => (
                      <div key={f.path} className="flex gap-2 text-slate-400"><span className="truncate flex-1">{baseName(f.path)}</span><span className="text-slate-500 shrink-0">{reason(f.reason)}</span></div>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[11px] text-slate-500">
                {trash
                  ? t('ファイルはゴミ箱 (iPhone は「ファイル」の最近削除した項目) へ移します。名前・メモ・同期などの走行の記録も消えます。', 'Files are moved to the Trash (Recently Deleted in Files on iPhone). The run’s name, notes and sync are removed too.')
                  : t('ファイルはすぐに消え、戻せません。名前・メモ・同期などの走行の記録も消えます。', 'Files are deleted right away and cannot be restored. The run’s name, notes and sync are removed too.')}
              </p>
            </>
          )}
          {state.error && <p className="text-amber-500">{state.error}</p>}
        </div>
        <div className="flex gap-2 px-4 py-3 border-t border-line-2">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl bg-surface-3 text-slate-200 text-sm font-bold cursor-pointer" data-testid="run-delete-cancel">{t('やめる', 'Cancel')}</button>
          <button onClick={onConfirm} disabled={!plan || plan.remove.length === 0 || state.running} className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-bold cursor-pointer disabled:opacity-50" data-testid="run-delete-confirm">
            {state.running ? t('消しています…', 'Deleting…') : t('消す', 'Delete')}
          </button>
        </div>
      </div>
    </div>
  );
};

/** 走行の詳細 (周の一覧・動画・解析で開く・動画を見る) */
/** 走行の名前 (PLAN-32)。ファイルの名前は変えず、runs.json の行に書く。離れたとき・Enter で書く */
const RunNameInput: React.FC<{ name: string; onSave: (name: string) => void }> = ({ name, onSave }) => {
  const t = useT();
  const [draft, setDraft] = useState(name);
  const saved = useRef(name);
  const save = () => { if (draft.trim() !== saved.current.trim()) { saved.current = draft; onSave(draft); } };
  // 欄が消える (別の走行を選んだ) ときも、書きかけを書く
  const latest = useRef({ draft, onSave });
  latest.current = { draft, onSave };
  useEffect(() => () => { const l = latest.current; if (l.draft.trim() !== saved.current.trim()) l.onSave(l.draft); }, []);
  return (
    <input
      value={draft}
      onChange={e => setDraft(e.target.value.slice(0, 60))}
      onBlur={save}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      placeholder={t('名前を付ける (例: 新品タイヤ・雨)', 'Name this run (e.g. new tyres, wet)')}
      aria-label={t('走行の名前', 'Run name')}
      data-testid="run-detail-name"
      className="mt-1 w-full bg-transparent border-b border-line-3 focus:border-sky-500 text-sm text-slate-100 placeholder:text-slate-500 outline-none py-0.5"
    />
  );
};

/**
 * 参考ラップの印 (自分のではない走行。PLAN-31)。印を付けると、誰の走行か・車を書ける。
 * 参考ラップは、ラップタイムの一覧の順位・ベストと、ラップタイマーの「これまでのベスト」には数えない
 */
const ReferenceField: React.FC<{ reference: { driver?: string; car?: string } | undefined; onSave: (r: { driver?: string; car?: string } | null) => void }> = ({ reference, onSave }) => {
  const t = useT();
  const [driver, setDriver] = useState(reference?.driver ?? '');
  const [car, setCar] = useState(reference?.car ?? '');
  // 印はすぐ切り替える (一覧を読み直す前に誰・車を書いても、書けるように)
  const [on, setOn] = useState(!!reference);
  const save = () => { if (on && (driver.trim() !== (reference?.driver ?? '') || car.trim() !== (reference?.car ?? ''))) onSave({ driver, car }); };
  const input = 'flex-1 min-w-0 bg-transparent border-b border-line-3 focus:border-sky-500 text-xs text-slate-200 placeholder:text-slate-500 outline-none py-0.5';
  return (
    <div className="mt-1.5 space-y-1">
      <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
        <input type="checkbox" checked={on} onChange={e => { setOn(e.target.checked); onSave(e.target.checked ? { driver, car } : null); }} data-testid="run-detail-reference" />
        {t('参考ラップ (自分の走行ではない。ベスト・順位に数えない)', 'Reference lap (not my run; not counted in bests or rankings)')}
      </label>
      {on && (
        <div className="flex gap-2 pl-5">
          <input value={driver} onChange={e => setDriver(e.target.value.slice(0, 40))} onBlur={save} placeholder={t('誰の走行か', 'Driver')} aria-label={t('誰の走行か', 'Driver')} className={input} data-testid="run-detail-ref-driver" />
          <input value={car} onChange={e => setCar(e.target.value.slice(0, 40))} onBlur={save} placeholder={t('車', 'Car')} aria-label={t('車', 'Car')} className={input} data-testid="run-detail-ref-car" />
        </div>
      )}
    </div>
  );
};

const RunDetail: React.FC<{
  run: RunItem;
  busy: boolean;
  onOpen: () => void;
  onOpenVideo: () => void;
  onAddAsCar2?: () => void;
  /** Car 1 と違うコースの走行 (比べられない) */
  otherCourse?: boolean;
  /** この走行が Car 1 (自分とは比べられない) */
  isCar1?: boolean;
  onToggleLap: (lap: RunItem['laps'][number], hide: boolean) => Promise<void>;
  /** 狭い画面のシートを閉じる (広い画面では右の欄なので無い) */
  onClose?: () => void;
  /** 走行の名前・メモを書く (PLAN-32・33) */
  onSaveMeta?: (patch: { name?: string; note?: string; reference?: { driver?: string; car?: string } | null }) => Promise<void>;
  /** この走行を消す (確かめの画面を出す)。消せない置き場では無い */
  onDelete?: () => void;
  /** 解析で開いている走行 (消せない) */
  isOpen?: boolean;
}> = ({ run, busy, onOpen, onOpenVideo, onAddAsCar2, otherCourse = false, isCar1 = false, onToggleLap, onClose, onSaveMeta, onDelete, isOpen = false }) => {
  const t = useT();
  const ja = t('ja', 'en') === 'ja';
  const [order, setOrder] = useState<'run' | 'time'>('run');
  // 書き換えている間は、隠す・出すを押せなくする
  const [saving, setSaving] = useState(false);
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
          <div className="text-sm font-bold text-slate-100">{fmtDate(run.startMs, ja)} {run.courseName != null ? circuitLabel(run.courseName) : (run.folder === 'unsorted' ? t('未分類', 'Unsorted') : run.folder)}</div>
          {onSaveMeta && <RunNameInput key={`${run.folder}/${run.file}`} name={run.entry?.name ?? ''} onSave={name => void onSaveMeta({ name })} />}
          {onSaveMeta && <ReferenceField key={`ref-${run.folder}/${run.file}`} reference={run.entry?.reference} onSave={reference => void onSaveMeta({ reference })} />}
          <div className="text-xs text-slate-400 mt-0.5">
            {run.pending
              ? t('☁️ iCloud にだけあるので、開くと周を数えます', '☁️ Only in iCloud; laps are counted when opened')
              : run.courseName === null && run.laps.length === 0
              ? t('コース未設定。開くと、計測線を自動で置いて周を数えます', 'No course. Laps are counted with an automatic timing line when you open it')
              : <>{t('ベスト', 'Best')} <span className="font-mono font-bold text-fuchsia-400">{best !== null ? formatLapTime(best) : '--'}</span>{t(' ・ ', ' · ')}{t(`${visible.length} 周`, `${visible.length} lap${(visible.length) === 1 ? '' : 's'}`)}</>}
            {run.videos.length > 0 && <>{t(' ・ ', ' · ')}<Video size={11} className="inline" /> {run.videos.length}{run.synced ? t(' (同期済み)', ' (synced)') : ''}</>}
          </div>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1.5 rounded hover:bg-surface-3 text-slate-400 cursor-pointer" aria-label={t('閉じる', 'Close')} data-testid="run-detail-close"><X size={18} /></button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {onSaveMeta && <RunNoteField key={`${run.folder}/${run.file}`} note={run.entry?.note} onSave={note => void onSaveMeta({ note })} testId="run-detail-note" />}
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
                    onClick={() => { setSaving(true); void onToggleLap(l, !l.hidden).finally(() => setSaving(false)); }}
                    disabled={saving}
                    className="p-2.5 -m-1.5 rounded text-slate-500 hover:text-slate-300 cursor-pointer disabled:opacity-40"
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
        {onDelete && (
          <section className="pt-2 border-t border-line-2">
            <button onClick={onDelete} disabled={busy || isOpen} className="text-xs text-red-400 hover:text-red-300 disabled:text-slate-500 cursor-pointer disabled:cursor-not-allowed" data-testid="run-delete">
              {t('この走行を消す…', 'Delete this run…')}
            </button>
            {isOpen && <p className="text-[11px] text-slate-500 mt-1">{t('解析で開いている走行は消せません (解析の「走行とコース」から外してください)', 'A run open in Analysis cannot be deleted (remove it from Runs & course first)')}</p>}
          </section>
        )}
      </div>
      {onAddAsCar2 && visible.length > 0 && (
        <div className="shrink-0 px-4 pt-3 border-t border-line-2">
          <button onClick={onAddAsCar2} disabled={busy || otherCourse || isCar1} title={isCar1 ? t('開いている走行 (Car 1) です', 'This run is Car 1') : otherCourse ? t('同じコースの走行だけ比べられます', 'Only runs on the same course can be compared') : undefined} className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl border-2 border-sky-500 text-sky-500 font-bold text-sm cursor-pointer disabled:cursor-not-allowed disabled:border-line-3 disabled:text-slate-400" data-testid="run-add-car2">
            <GitCompare size={16} />{isCar1
              ? t('開いている走行 (Car 1) です', 'This run is Car 1')
              : otherCourse
              ? t('同じコースの走行だけ比べられます', 'Only runs on the same course can be compared')
              : t(`Car 2 として足す (ベスト ${best !== null ? formatLapTime(best) : '--'} と比べる)`, `Add as Car 2 (compare best ${best !== null ? formatLapTime(best) : '--'})`)}
          </button>
        </div>
      )}
      <div className={`shrink-0 flex gap-2 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] ${onAddAsCar2 && visible.length > 0 ? '' : 'border-t border-line-2'}`}>
        <button onClick={onOpen} disabled={busy} className="flex-1 inline-flex items-center justify-center gap-1.5 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-sm cursor-pointer disabled:opacity-50" data-testid="run-open-analysis">
          <BarChart2 size={16} />{t('解析で開く', 'Open in Analysis')}
        </button>
        <button onClick={onOpenVideo} disabled={busy || videos.length === 0} className="flex-1 inline-flex items-center justify-center gap-1.5 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm cursor-pointer disabled:cursor-not-allowed disabled:bg-surface-4 disabled:text-slate-400 disabled:hover:bg-surface-4" data-testid="run-open-video">
          <Video size={16} />{t('動画を見る', 'Watch video')}
        </button>
      </div>
    </div>
  );
};
