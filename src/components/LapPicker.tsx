import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { addons } from '../addons';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { formatLapTime } from '../services/liveLapTimer';
import type { LapFolder } from '../services/lapHistory';
import { NO_FILTER } from '../services/runFilters';
import { canUseRunStore, getRunStore, type RunStore } from '../services/runStore';
import { getStorageRevision } from '../services/storageCourses';
import type { SelectedCarSlot, Session } from '../types/telemetry';
import { circuitLabel, getLang, useT } from '../utils/i18n';
import { ConditionFilters } from './ConditionFilters';
import { loadedPickerRows, pickerTable, readPickerHistory, storedPickerRows, type LapPickerChoice, type PickerRow } from './lapPickerRows';

export type { LapPickerChoice } from './lapPickerRows';

interface Props {
  sessions: Session[];
  selectedCars: SelectedCarSlot[];
  onAssign: (choice: LapPickerChoice, slot: number, signal: AbortSignal) => Promise<void>;
  onClose: () => void;
  sourceRevision?: number;
}

const slots = [0, 1, 2, 3];
const selectClass = 'max-w-full min-h-9 rounded-lg border border-line-3 bg-surface-1 px-2 text-xs';
const actionClass = 'rounded-lg px-2.5 py-2 hover:bg-surface-4 disabled:opacity-40';

function LapTable({ rows, selectedCars, onAssign, stored }: Pick<Props, 'selectedCars' | 'onAssign'> & { rows: PickerRow[]; stored: boolean }) {
  const t = useT();
  const [order, setOrder] = useState<'date' | 'time'>('date');
  const [filter, setFilter] = useState(NO_FILTER);
  const [hidden, setHidden] = useState(false);
  const [view, setView] = useState('');
  const [pending, setPending] = useState<number[]>([]);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const requests = useRef(new Map<number, AbortController>());
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
    };
  }, []);
  const { options, currentFilter, times, visible } = useMemo(() => pickerTable(rows, filter, hidden, order), [rows, filter, hidden, order]);
  const lang = getLang();
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(lang, {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }), [lang]);
  const latest = useRef(visible);
  latest.current = visible;
  const views = stored ? addons.lapTableViews : undefined;
  const CustomView = views?.find(v => v.id === view)?.Component;
  const assign = async (r: PickerRow, slot: number) => {
    if (!active.current || !latest.current.includes(r) || !slots.includes(slot)) return;
    requests.current.get(slot)?.abort();
    const request = new AbortController();
    requests.current.set(slot, request);
    setPending([...requests.current.keys()]);
    setFailed(false);
    setMessage('');
    try {
      await onAssign(r.choice, slot, request.signal);
      if (!request.signal.aborted) {
        setFailed(false);
        setMessage(t(`Car ${slot + 1} に ${r.number} を設定しました`, `Assigned ${r.number} to Car ${slot + 1}`));
      }
    } catch (err) {
      if (!request.signal.aborted) {
        setFailed(true);
        const detail = err instanceof Error ? err.message : String(err);
        setMessage(t(`ラップを開けませんでした: ${detail}`, `Could not open the lap: ${detail}`));
      }
    } finally {
      if (requests.current.get(slot) === request) {
        requests.current.delete(slot);
        setPending([...requests.current.keys()]);
      }
    }
  };
  return <>
    <div className="flex flex-wrap items-center gap-2 border-b border-line-2 px-3 py-2">
      <select className={selectClass} value={order} onChange={e => setOrder(e.target.value as typeof order)} aria-label={t('並べ方', 'Sort')}>
        <option value="date">{t('走った順', 'By run')}</option>
        <option value="time">{t('タイム順', 'By lap time')}</option>
      </select>
      <ConditionFilters options={options} filter={currentFilter} onChange={setFilter} testIdPrefix="lap-picker" selectClass="max-w-full" />
      {rows.some(r => r.hidden) && <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={hidden}
        onChange={e => setHidden(e.target.checked)} />{t('隠した周も表示', 'Show hidden laps')}</label>}
      {!!views?.length && <select className={selectClass} value={view} onChange={e => setView(e.target.value)} aria-label={t('表示', 'View')}>
        <option value="">{t('一覧', 'List')}</option>
        {views.map(v => <option key={v.id} value={v.id}>{t(...v.label)}</option>)}
      </select>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="lap-picker-rows">
      {!visible.length ? <p className="text-sm text-slate-400">{t('該当するラップがありません。', 'No matching laps.')}</p>
        : CustomView ? <CustomView rows={visible.flatMap(r => r.choice.kind === 'stored' ? [r.choice.row] : [])} order={order}
          assign={(row, slot) => {
            const match = latest.current.find(r => r.choice.kind === 'stored' && r.choice.row === row);
            if (match) void assign(match, slot - 1);
          }} />
        : visible.map((r, i) => {
          const showRun = order === 'time' || i === 0 || visible[i - 1].run !== r.run;
          const file = r.choice.kind === 'stored' ? r.choice.row.file : r.choice.session.fileName;
          const heading = showRun ? [r.date === null ? '' : dateFormat.format(r.date), r.runName,
            file !== r.runName ? file : ''].filter(Boolean).join(' · ') : '';
          const rank = r.hidden || r.reference !== undefined ? 0 : times.indexOf(r.time) + 1;
          const lap = r.choice.kind === 'loaded' ? r.choice.lap : null;
          return <div key={r.key}>
            {showRun && <p className={`truncate pb-1 text-xs font-medium text-slate-400 ${i ? 'pt-3' : ''}`} title={heading}>{heading}</p>}
            <div className="flex flex-wrap items-center gap-2 border-b border-line-1 py-1 text-xs" data-testid="lap-picker-row">
              <span className="min-w-7 font-mono text-slate-400">{r.number}</span>
              <span className={`font-mono font-semibold ${['', 'text-fuchsia-400', 'text-emerald-400', 'text-amber-400'][rank] ?? ''}`}>{formatLapTime(r.time)}</span>
              {rank > 0 && <span className="text-[11px] text-slate-400">#{rank}</span>}
              {r.hidden && <span className="text-slate-400">{t('非表示', 'Hidden')}</span>}
              {r.reference !== undefined && <span className="text-amber-400">{t('参考', 'Ref')}{r.reference && ` · ${r.reference}`}</span>}
              {(lap?.isPartialLap || lap?.isWholeSession) && <span className="text-slate-400">{lap.isPartialLap ? t('途中まで', 'Partial') : t('走行全体', 'Whole run')}</span>}
              <div className="ml-auto flex gap-1">
                {slots.map(slot => {
                  const choice = r.choice;
                  const assigned = choice.kind === 'loaded' && selectedCars.some(c => c.slot === slot && c.sessionId === choice.session.id && c.lapNumber === choice.lap.lapNumber);
                  return <button key={slot} type="button" onClick={() => void assign(r, slot)}
                    className={`min-h-9 min-w-8 rounded-md border px-1 text-xs disabled:opacity-40 sm:px-2 ${assigned ? 'border-cyan-500 text-cyan-300' : 'border-line-3 bg-surface-2 hover:bg-surface-4'}`}
                    aria-label={t(`${r.number} を Car ${slot + 1} に設定`, `Assign ${r.number} to Car ${slot + 1}`)} data-slot={slot}>
                    Car {slot + 1}
                  </button>;
                })}
              </div>
            </div>
          </div>;
        })}
    </div>
    {pending.length > 0 && <p role="status" className="px-3 py-1 text-xs text-slate-300">
      {t('読み込み中…', 'Loading…')} {pending.map(slot => `Car ${slot + 1}`).join(', ')}
    </p>}
    {message && <p role={failed ? 'alert' : 'status'} className={`px-3 py-1 text-xs ${failed ? 'text-amber-400' : 'text-slate-300'}`}>
      {message}
    </p>}
  </>;
}

type History = { state: 'ready'; store: RunStore | null; revision: number; folders: LapFolder[] } | { state: 'error'; detail: string } | { state: 'loading' };

function StoredLaps({ selectedCars, onAssign }: Pick<Props, 'selectedCars' | 'onAssign'>) {
  const t = useT();
  const [history, setHistory] = useState<History>({ state: 'loading' });
  const [selected, setSelected] = useState('');
  useLayoutEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const revision = getStorageRevision();
    void (async () => {
      try {
        const store = await getRunStore();
        if (signal.aborted || revision !== getStorageRevision()) return;
        const folders = store ? await readPickerHistory(store, signal, revision) : [];
        if (!signal.aborted && revision === getStorageRevision()) setHistory({ state: 'ready', store, revision, folders });
      } catch (err) {
        if (!signal.aborted && revision === getStorageRevision()) setHistory({ state: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => controller.abort();
  }, []);
  const folders = history.state === 'ready' ? history.folders : [];
  const current = folders.find(f => f.folder === selected) ?? [...folders].sort((a, b) => (b.rows[0]?.runStartMs ?? 0) - (a.rows[0]?.runStartMs ?? 0))[0];
  const rows = useMemo(() => current && history.state === 'ready' && history.store ? storedPickerRows(current, history.store, history.revision) : [], [current, history]);
  if (history.state === 'loading') return <p className="p-3 text-sm" role="status">{t('保管場所を読み込み中…', 'Loading stored laps…')}</p>;
  if (history.state === 'error') return <p className="p-3 text-sm text-amber-400" role="alert">{t(`一覧を読めませんでした: ${history.detail}`, `Could not load the list: ${history.detail}`)}</p>;
  if (!current) return <p className="p-3 text-sm text-slate-400">{history.store ? t('保存された走行がありません。', 'No stored runs.') :
    t('設定で走行の保管場所を選んでください。', 'Choose a run folder in Settings.')}</p>;
  return <>
    <div className="px-3 pt-2">
      <select className={selectClass} value={current.folder} onChange={e => setSelected(e.target.value)} aria-label={t('コース', 'Course')}>
        {folders.map(f => <option key={f.folder} value={f.folder}>{f.courseName ? circuitLabel(f.courseName) : f.folder}</option>)}
      </select>
    </div>
    {current.courseName ? <LapTable key={current.folder} rows={rows} selectedCars={selectedCars} onAssign={onAssign} stored />
      : <p className="p-3 text-sm text-amber-400">{t('このフォルダのコースが分からないため、周を数えられません。', 'This folder has no matching course for counting laps.')}</p>}
  </>;
}

function LoadedLaps({ sessions, selectedCars, onAssign }: Pick<Props, 'sessions' | 'selectedCars' | 'onAssign'>) {
  const t = useT();
  const [course, setCourse] = useState<string>();
  const courses = [...new Set(sessions.map(s => s.circuitName))];
  const current = course !== undefined && courses.includes(course) ? course : courses[0];
  const rows = useMemo(() => loadedPickerRows(sessions.filter(s => s.circuitName === current)), [sessions, current]);
  if (!sessions.length) return <p className="p-3 text-sm text-slate-400">{t('開いている走行がありません。', 'No open runs.')}</p>;
  return <>
    {courses.length > 1 && <div className="px-3 pt-2">
      <select className={selectClass} value={current} onChange={e => setCourse(e.target.value)} aria-label={t('コース', 'Course')}>
        {courses.map(c => <option key={c} value={c}>{circuitLabel(c) || t('コース未設定', 'Unknown course')}</option>)}
      </select>
    </div>}
    <LapTable key={current} rows={rows} selectedCars={selectedCars} onAssign={onAssign} stored={false} />
  </>;
}

export function LapPicker({ sessions, selectedCars, onAssign, onClose, sourceRevision = 0 }: Props) {
  const t = useT();
  const library = canUseRunStore();
  const [stored, setStored] = useState(library && !sessions.length);
  const [reload, setReload] = useState(0);
  useEscapeKey(true, onClose);
  return <div role="dialog" aria-modal="true" aria-label={t('ラップを選ぶ', 'Choose laps')}
    className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 sm:items-center sm:p-4">
    <div className="flex w-full max-w-3xl flex-col overflow-hidden border border-line-2 bg-surface-1 text-slate-100 shadow-2xl sm:h-[80dvh] sm:rounded-2xl">
      <header className="flex items-center gap-2 border-b border-line-2 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:pt-2">
        <h2 className="flex-1 font-bold">{t('ラップを選ぶ', 'Choose laps')}</h2>
        {stored && <button className={actionClass} aria-label={t('読み直す', 'Reload')} onClick={() => setReload(n => n + 1)}><RefreshCw size={17} /></button>}
        <button className={actionClass} aria-label={t('閉じる', 'Close')} onClick={onClose}><X size={20} /></button>
      </header>
      {library && <div className="flex gap-1 border-b border-line-2 px-3 py-1.5 text-xs">
        {[false, true].map(s => <button key={Number(s)} aria-pressed={s === stored} onClick={() => setStored(s)}
          className={`rounded-md px-3 py-2 ${s === stored ? 'bg-surface-4 font-semibold' : 'text-slate-400'}`}>
          {s ? t('保管場所', 'Stored runs') : t('読み込み済み', 'Open runs')}
        </button>)}
      </div>}
      {stored ? <StoredLaps key={`${sourceRevision}:${reload}`} selectedCars={selectedCars} onAssign={onAssign} /> :
        <LoadedLaps key={sourceRevision} sessions={sessions} selectedCars={selectedCars} onAssign={onAssign} />}
      <p className="mt-auto border-t border-line-2 px-3 pt-2 text-xs text-slate-400">{t('Car に割り当てた走行と、保持する動画の保存元を残します。', 'Keeps assigned runs and the source needed to save retained video sync.')}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-xs sm:grid-cols-4 sm:pb-2">
        {slots.map(slot => {
          const car = selectedCars.find(c => c.slot === slot);
          return <div key={slot} className="min-w-0"><b style={{ color: car?.colorHex }}>Car {slot + 1}</b>
            <span className="block truncate text-slate-400" title={car?.label}>{car?.label || '—'}</span></div>;
        })}
      </div>
    </div>
  </div>;
}
