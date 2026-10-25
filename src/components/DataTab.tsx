import React, { useEffect, useRef, useState } from 'react';
import { RunNoteField } from './RunNoteField';
import { SessionSaveBar } from './SessionSaveBar';
import { Session, SelectedCarSlot, Sector, ControlLine } from '../types/telemetry';
import { CIRCUIT_PRESETS } from '../services/circuitDatabase';
import {
  FileText,
  Trash2,
  Trophy,
  CheckCircle2,
  Circle,
  MapPin,
  Settings2,
  Layers,
  Edit3,
  FolderOpen,
  Globe,
  Repeat,
  X,
  ListOrdered,
  Pencil,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import { LapHistoryPanel } from './LapHistoryPanel';
import { formatMinSec } from '../utils/timeFormat';
import { useCompactLayout } from '../hooks/useCompactLayout';
import { GFilterLevel } from '../services/physics';
import { circuitLabel, useLang, useT } from '../utils/i18n';
import type { GSource } from '../services/imuG';

interface DataTabProps {
  sessions: Session[];
  /** ラップタイムの記録から、走行のファイル (.bon4) を解析で開く (デスクトップ版) */
  onOpenLapRun?: (file: File, run: { folder: string; file: string }) => void;
  selectedCars: SelectedCarSlot[];
  onSelectCarSlot: (slotIndex: number, sessionId: string, lapNumber: number) => void;
  // スロットの割り当てを解除する
  onClearCarSlot: (slotIndex: number) => void;
  onSetDistanceOffset: (slotIndex: number, offsetM: number) => void;
  alignLapLength: boolean;
  onSetAlignLapLength: (value: boolean) => void;
  // 基準車のスロット (Car 1 が空のときは割り当てのある一番若いスロット)。基準車には距離補正を出さない
  baseSlot?: number;
  // 登録済みのユーザーコースの数
  userCircuitCount: number;
  /** コースフォルダー一括設置で読み込んだコースデータを外す (読み込んだものがあるときだけ) */
  onClearCircuitFolder?: () => void;
  onRemoveSession: (sessionId: string) => void;
  onOpenInConvert: (sessionId: string) => void;
  onEditSessionName: (sessionId: string, newName: string) => void;
  /** 走行のメモを変えた (PLAN-33) */
  onEditSessionNote?: (sessionId: string, note: string) => void;
  /** 今の Car の割り当てを、解析用のセッションとして保存する (PLAN-18)。エラーなら文、できたら null */
  onSaveSession?: (name: string) => Promise<string | null>;
  /** ブラウザ版: 書き出した比べ方を読み込む */
  onImportSession?: (file: File) => Promise<string | null>;
  /** 保存するときの名前の既定 */
  sessionDefaultName?: string;
  // ログの時計の補正 (秒) を変える / 同じ時間のほかのログとの比べから見積もる (BUG-08)
  onSetClockOffset?: (sessionId: string, sec: number) => void;
  onEstimateClockOffset?: (sessionId: string) => Promise<ClockEstimateResult | string>;
  /** 当てはめなかったとき (確かめてやめたとき) は false */
  onSelectCircuitPreset: (presetId: string) => boolean;
  onOpenCircuitEditor: () => void;
  onLoadPthFile: () => void;
  onLoadClnFile: () => void;
  onLoadCircuitFolder?: () => void;
  // 走行データのファイルを選ぶ (データがないときの案内をタップ・クリックしたとき)
  onOpenFile?: () => void;
  // G のならし方 (解析の設定)
  gFilterLevel: GFilterLevel;
  onChangeGFilterLevel: (level: GFilterLevel) => void;
  /** iPhone の G センサーの値がある走行を開いているか */
  hasImu?: boolean;
  gSource?: GSource;
  onChangeGSource?: (s: GSource) => void;
}

/** 時計の補正の見積もり。applied: 確かな見積もりなので入れた。入れていないもの (quality 'suggest') は「入れる」で入れる */
export interface ClockEstimateResult {
  refName: string;
  offsetSec: number;
  medianDistanceM: number;
  quality: 'auto' | 'suggest' | 'reject';
  applied: boolean;
}

/**
 * ログの時計の補正 (BUG-08)。ロガーごとの GPS の受信・記録の遅れを直す。動画との同期と、同じ時間のほかのログとの時刻の換算に効く。
 * 「自動」は、同じ時間に記録したほかのログ (基準車のログ、なければ記録の細かいログ) と位置を比べて見積もる
 */
const ClockOffsetControl: React.FC<{
  session: Session;
  onSet: (sessionId: string, sec: number) => void;
  onEstimate?: (sessionId: string) => Promise<ClockEstimateResult | string>;
}> = ({ session, onSet, onEstimate }) => {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  // 確かでない見積もり (案)。「入れる」で入れる
  const [suggestion, setSuggestion] = useState<number | null>(null);
  const value = session.clockOffsetSec ?? 0;
  // 入力中の文字はそのまま持つ (「-」や「0.」を打った途中で 0 に戻さないため)。外から値が変わったら入れ直す
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (parseFloat(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span
      className="flex items-center gap-1 text-[11px] text-slate-400"
      title={t('このログの時計の補正 (秒)。ロガーごとの GPS の遅れを直します。+ ならこのログの時刻を早めます。動画との同期と、同じ時間のほかのログとの時刻合わせに効きます', 'Clock correction for this log (seconds). Fixes the GPS delay of each logger; + moves this log earlier. Affects video sync and time matching with other logs of the same session')}
    >
      <span>{t('時計の補正', 'Clock')}</span>
      <input
        type="number"
        step={0.01}
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onSet(session.id, v);
          setNote('');
        }}
        onBlur={() => setDraft(String(value))}
        className="w-16 bg-surface-0 border border-line-3 rounded px-1 text-right font-mono text-slate-200"
      />
      <span>{t('秒', 's')}</span>
      {onEstimate && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setSuggestion(null);
            setNote(t('見積もり中…', 'Estimating…'));
            const r = await onEstimate(session.id);
            if (typeof r === 'string') setNote(r);
            else {
              const sec = `${r.offsetSec >= 0 ? '+' : ''}${r.offsetSec.toFixed(3)}`;
              setNote(r.applied
                ? t(`${r.refName} と比べて ${sec} 秒 (位置の差 ${r.medianDistanceM} m)`, `${sec} s against ${r.refName} (position gap ${r.medianDistanceM} m)`)
                : t(`${r.refName} と比べると ${sec} 秒。位置の差が大きいか、ずれがはっきりしないので入れていません (位置の差 ${r.medianDistanceM} m)`, `${sec} s against ${r.refName}, not applied: the position gap is large or the offset is unclear (gap ${r.medianDistanceM} m)`));
              if (!r.applied) setSuggestion(r.offsetSec);
            }
            setBusy(false);
          }}
          className="px-1.5 rounded border border-line-3 hover:text-slate-200 disabled:opacity-50"
          title={t('同じ時間に記録したほかのログと位置を比べて、時計のずれを見積もって入れます', 'Estimate the clock offset by comparing positions with another log of the same time')}
        >
          {t('自動', 'Auto')}
        </button>
      )}
      {note && <span className="text-slate-500">{note}</span>}
      {suggestion !== null && (
        <button
          onClick={() => { onSet(session.id, suggestion); setSuggestion(null); setNote(''); }}
          className="px-1.5 rounded border border-amber-500/60 text-amber-300 hover:text-amber-200"
        >
          {t('入れる', 'Apply')}
        </button>
      )}
    </span>
  );
};

/**
 * 走行の名前。ふだんは文字だけで出し、鉛筆のボタンを押したときだけ書き換えられる (触っただけで書き換わらないように。2026-10-22)。
 * Enter か欄の外を押すと決める。Esc でやめる。空にしたら前の名前のまま
 */
const SessionNameField: React.FC<{ name: string; compact: boolean; onSave: (name: string) => void }> = ({ name, compact, onSave }) => {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // 決めた・やめたあとに来る blur (入力欄が消えるときに来ることがある) では何もしない。Esc のあとに決めてしまわないように
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const v = draft.trim();
    if (save && v && v !== name) onSave(v);
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        type="text"
        value={draft}
        autoFocus
        onFocus={e => e.target.select()}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={e => {
          // 日本語入力の変換を確定する Enter・候補を閉じる Esc では決めない (漢字を確定した途端に閉じないように)
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
        }}
        aria-label={t('走行の名前', 'Run name')}
        data-testid="session-name-input"
        className={`bg-surface-1 border border-red-500 text-sm font-bold text-slate-100 rounded px-2.5 py-1 outline-none min-w-0 ${compact ? 'flex-1' : 'w-72'}`}
      />
    );
  }
  return (
    <span className={`flex items-center gap-1 min-w-0 ${compact ? 'flex-1' : 'max-w-full'}`}>
      <span className="text-sm font-bold text-slate-100 truncate" title={name}>{name}</span>
      <button
        type="button"
        onClick={() => { setDraft(name); finished.current = false; setEditing(true); }}
        title={t('名前を変える', 'Rename')}
        aria-label={t('名前を変える', 'Rename')}
        data-testid="session-rename"
        className="shrink-0 p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-surface-4 transition-colors cursor-pointer"
      >
        <Pencil size={13} />
      </button>
    </span>
  );
};

export const DataTab: React.FC<DataTabProps> = ({
  sessions,
  onOpenLapRun,
  selectedCars,
  onSelectCarSlot,
  onClearCarSlot,
  onSetDistanceOffset,
  alignLapLength,
  onSetAlignLapLength,
  baseSlot,
  userCircuitCount,
  onClearCircuitFolder,
  onRemoveSession,
  onOpenInConvert,
  onEditSessionName,
  onEditSessionNote,
  onSaveSession,
  onImportSession,
  sessionDefaultName,
  onSetClockOffset,
  onEstimateClockOffset,
  onSelectCircuitPreset,
  onOpenCircuitEditor,
  onLoadPthFile,
  onLoadClnFile,
  onLoadCircuitFolder,
  onOpenFile,
  gFilterLevel,
  onChangeGFilterLevel,
  hasImu,
  gSource,
  onChangeGSource
}) => {
  // スマートフォン向けの配置では、ラップ一覧を表でなく 1 周ずつのカードで出す
  const compact = useCompactLayout();
  const t = useT();
  const lang = useLang();
  // スマートフォンでは、コースの設定はたたんでおき、見出しをタップして開く (ラップ一覧を先に見せる)
  const [courseOpen, setCourseOpen] = useState(false);
  // ラップタイムの記録 (デスクトップ版だけ。保管場所のフォルダから過去の周を一覧にする)
  const [lapHistoryOpen, setLapHistoryOpen] = useState(false);
  const showCourseTools = !compact || courseOpen;
  // たたんだ走行の枠 (見出しだけ出す)。走行をたくさん読み込んだときに、見たいものへ早くたどり着けるように (2026-10-22)
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggleFold = (id: string) => setFolded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const formatTime = (sec: number) => {
    if (!sec || isNaN(sec)) return '--:--.---';
    return formatMinSec(sec, 3);
  };

  const slotColors = [
    { slot: 0, label: t('Car 1 (基準車: 赤)', 'Car 1 (reference: red)'), hex: '#ef4444', bg: 'bg-red-600' },
    { slot: 1, label: t('Car 2 (青)', 'Car 2 (blue)'), hex: '#3b82f6', bg: 'bg-blue-600' },
    { slot: 2, label: t('Car 3 (緑)', 'Car 3 (green)'), hex: '#10b981', bg: 'bg-emerald-600' },
    { slot: 3, label: t('Car 4 (橙)', 'Car 4 (orange)'), hex: '#f59e0b', bg: 'bg-amber-500' }
  ];

  return (
    <div className={`flex flex-col h-full bg-surface-1 text-slate-200 overflow-y-auto overflow-x-hidden ${compact ? 'p-2 space-y-3' : 'p-4 space-y-6'}`}>
      {/* 今の Car の割り当てを保存する (保管場所の走行を比べているとき。PLAN-18) */}
      {onSaveSession && (selectedCars.length > 0 || onImportSession) && (
        <SessionSaveBar defaultName={sessionDefaultName ?? ''} onSave={onSaveSession} onImport={onImportSession} canSave={selectedCars.length > 0} />
      )}
      {/* 上部: コース設定 & プリセット切り替えバー */}
      <div className={`bg-surface-2 border border-line-2 rounded-xl shadow-md flex flex-wrap items-center justify-between ${compact ? 'p-3 gap-3' : 'p-4 gap-4'}`}>
        <div
          className={`flex items-center gap-3 ${compact ? 'w-full cursor-pointer' : ''}`}
          onClick={compact ? () => setCourseOpen(o => !o) : undefined}
          aria-expanded={compact ? courseOpen : undefined}
        >
          <div className="p-2 bg-red-600/20 text-red-500 rounded-lg">
            <MapPin size={22} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-slate-100">{t('コース / コントロールライン設定', 'Course / timing line')}</h2>
            <p className="text-xs text-slate-400">{t('全国主要サーキットのプリセット、または独自コースの定義', 'Presets for major circuits in Japan, or your own course definition')}</p>
          </div>
          {compact && <span className="text-slate-400 text-lg">{courseOpen ? '−' : '+'}</span>}
        </div>

        <div className={`items-center gap-2 flex-wrap ${showCourseTools ? 'flex' : 'hidden'}`}>
          {/* サーキットプリセット選択 */}
          <select
            onChange={e => {
              // やめたときは、選んだ表示を戻す (次に同じコースを選んでも変化が起きるように)
              if (!onSelectCircuitPreset(e.target.value)) e.target.value = '';
            }}
            // 選択肢の名前が長いと、選択肢に合わせて広がって枠からはみ出すので、どの幅でも枠いっぱいにする (パソコンでもはみ出していた)
            className="w-full max-w-full min-w-0 truncate bg-surface-0 border border-line-3 text-xs text-slate-200 rounded-lg px-3 py-2 outline-none focus:border-red-500 transition-colors"
          >
            <option value="">{t('-- サーキットプリセット選択 --', '-- Select a circuit preset --')}</option>
            {/* 国内と海外に分ける (数が多いので) */}
            {[[t('国内', 'Japan'), CIRCUIT_PRESETS.filter(c => c.country === 'JP')], [t('海外', 'Overseas'), CIRCUIT_PRESETS.filter(c => c.country !== 'JP')]].map(([label, list]) => (
              <optgroup key={label as string} label={label as string}>
                {(list as typeof CIRCUIT_PRESETS).map(c => (
                  <option key={c.id} value={c.id}>
                    {circuitLabel(c.name, lang)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {/* ユーザーコースフォルダ一括設置 */}
          {onLoadCircuitFolder && (
            <button
              onClick={onLoadCircuitFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700/80 hover:bg-emerald-600 text-xs text-white font-medium transition-colors shadow"
              title={t('公式アプリや自前の Circuit/ControlLine フォルダを選択して一括登録', 'Select a Circuit/ControlLine folder (from the official app or your own) to install every course in it')}
            >
              <FolderOpen size={13} />
              {t('コースフォルダ一括設置', 'Install course folder')}
              {userCircuitCount > 0 && (
                <span className="bg-emerald-900 text-emerald-200 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
                  {userCircuitCount}
                </span>
              )}
            </button>
          )}
          {/* 一括設置したコースデータを外す (内蔵のコースに戻す) */}
          {onClearCircuitFolder && (
            <button
              onClick={onClearCircuitFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 hover:bg-surface-4 border border-line-3 text-xs text-slate-300 font-medium transition-colors"
              title={t('コースフォルダ一括設置で読み込んだコースデータを外して、内蔵のコースに戻す', 'Remove the course data installed from a folder and go back to the built-in courses')}
              data-testid="clear-course-folder"
            >
              <X size={13} />
              {t('一括設置を外す', 'Remove installed courses')}
            </button>
          )}

          {/* コース図読込 */}
          <button
            onClick={onLoadPthFile}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-4 hover:bg-surface-5 text-xs text-slate-300 border border-line-4 transition-colors"
          >
            <Layers size={13} />
            {t('コース図 (.pth)', 'Track map (.pth)')}
          </button>

          {/* コントロールライン読込 */}
          <button
            onClick={onLoadClnFile}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-4 hover:bg-surface-5 text-xs text-slate-300 border border-line-4 transition-colors"
          >
            <FileText size={13} />
            {t('計測線 (.cln)', 'Timing line (.cln)')}
          </button>

          {/* コース編集モーダルを開く */}
          <button
            onClick={onOpenCircuitEditor}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-xs text-white font-medium transition-colors"
          >
            <Edit3 size={13} />
            {t('コース編集', 'Course editor')}
          </button>

          {/* ラップタイムの記録 (デスクトップ版だけ) */}
          {window.electronAPI?.laps && (
            <button
              onClick={() => setLapHistoryOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-4 hover:bg-surface-5 text-xs text-slate-300 border border-line-4 transition-colors"
              data-testid="open-lap-history"
            >
              <ListOrdered size={13} />
              {t('ラップタイムの記録', 'Lap time records')}
            </button>
          )}
        </div>
      </div>
      {lapHistoryOpen && <LapHistoryPanel onClose={() => setLapHistoryOpen(false)} onOpenRun={onOpenLapRun && ((f, run) => { setLapHistoryOpen(false); onOpenLapRun(f, run); })} />}

      {/* 比較スロット (Car 1〜4) の選択状態バー */}
      <div className="bg-surface-2 border border-line-2 rounded-xl p-3 shadow-md @container">
        {/* 狭い幅では、見出しと説明を 2 行に分ける (横に並べると 1 つの文のように読めた) */}
        <div className="text-xs font-bold text-slate-300 mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span>{t('比較スロット割り当て (最大4台 同時比較)', 'Comparison slots (up to 4 cars)')}</span>
          <span className="text-[11px] text-slate-400 font-normal">
            {t('下のラップ表のボタンを押して割り当てます', 'Assign laps with the buttons in the lap tables below')}
          </span>
        </div>
        {/* 列の数は、画面の幅ではなくこの枠の幅で決める (引き出しの中では、画面が広くても 4 列に詰め込まれて切れていた) */}
        <div className="grid grid-cols-1 @md:grid-cols-2 @5xl:grid-cols-4 gap-2">
          {slotColors.map(slot => {
            const assigned = selectedCars.find(c => c.slot === slot.slot);
            return (
              <div
                key={slot.slot}
                className="flex items-center justify-between p-2.5 rounded-lg border bg-surface-1"
                style={{ borderColor: assigned ? slot.hex : 'var(--ds-line-2)' }}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-3 h-3 rounded-full ${slot.bg}`} />
                  <div>
                    <div className="text-xs font-bold text-slate-200">{slot.label}</div>
                    <div className="text-[11px] text-slate-400 font-mono">
                      {assigned ? assigned.label : t('未割り当て', 'Not assigned')}
                    </div>
                    {/* 比較車両の距離の手動補正 (基準車は補正しない) */}
                    {assigned && slot.slot !== baseSlot && (
                      <div
                        className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"
                        title={t('重ねたときの前後のずれを補正します。+ で基準車より前（グラフの右）へずらします。Shift を押しながらクリックで 10 m 単位', 'Corrects the along-track offset when overlaying. + moves this car ahead of the reference car (to the right on the graph). Shift-click for 10 m steps')}
                      >
                        <span>{t('距離補正', 'Offset')}</span>
                        <button
                          onClick={e => onSetDistanceOffset(slot.slot, (assigned.distanceOffsetM || 0) - (e.shiftKey ? 10 : 1))}
                          className="px-1.5 rounded border border-line-3 hover:text-slate-200"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          step={1}
                          value={assigned.distanceOffsetM || 0}
                          onChange={e => {
                            const v = parseFloat(e.target.value);
                            onSetDistanceOffset(slot.slot, Number.isFinite(v) ? v : 0);
                          }}
                          className="w-14 bg-surface-0 border border-line-3 rounded px-1 text-right font-mono text-slate-200"
                        />
                        <span>m</span>
                        <button
                          onClick={e => onSetDistanceOffset(slot.slot, (assigned.distanceOffsetM || 0) + (e.shiftKey ? 10 : 1))}
                          className="px-1.5 rounded border border-line-3 hover:text-slate-200"
                        >
                          ＋
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {assigned && (
                  <button
                    onClick={() => onClearCarSlot(slot.slot)}
                    title={t(`${slot.label} の割り当てを解除`, `Unassign ${slot.label}`)}
                    className="self-start flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-line-3 text-[11px] text-slate-400 hover:text-slate-100 hover:border-slate-500 transition-colors"
                  >
                    <X size={11} />
                    {t('解除', 'Clear')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <label
          className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer w-fit"
          title={t('ロガーごとの 1 周の距離の差（1〜2% 程度）を、比較車両のラップを伸縮して基準車の 1 周の長さに合わせて吸収します。計測線から計測線までの 1 周どうしのときだけ効きます', 'Absorbs the difference in lap distance between loggers (about 1–2%) by stretching the compared laps to the reference lap length. Only works between full laps from timing line to timing line')}
        >
          <input type="checkbox" checked={alignLapLength} onChange={e => onSetAlignLapLength(e.target.checked)} />
          {t('1 周の長さを基準車にそろえる', 'Match lap length to the reference car')}
        </label>
      </div>

      {/* 解析の設定 */}
      <div className={`bg-surface-2 border border-line-2 rounded-xl shadow-md space-y-2 ${compact ? 'p-3' : 'p-4'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-bold text-slate-300">{t('G のならし方', 'G smoothing')}</span>
          <div className="flex bg-surface-1 rounded p-0.5 border border-line-3" role="radiogroup" aria-label={t('G のならし方', 'G smoothing')}>
            {([['weak', t('弱', 'Light')], ['standard', t('標準（推奨）', 'Standard (recommended)')], ['strong', t('強', 'Strong')]] as const).map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={gFilterLevel === value}
                onClick={() => onChangeGFilterLevel(value)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  gFilterLevel === value ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {hasImu && onChangeGSource && (
          <div className="flex flex-wrap items-center gap-3" data-testid="g-source">
            <span className="text-xs font-bold text-slate-300">{t('G の出どころ', 'G source')}</span>
            <div className="flex bg-surface-1 rounded p-0.5 border border-line-3" role="radiogroup" aria-label={t('G の出どころ', 'G source')}>
              {([['sensor', t('iPhone の G センサー', 'iPhone sensor')], ['calc', t('計算', 'Calculated')]] as const).map(([value, label]) => (
                <button key={value} role="radio" aria-checked={gSource === value} onClick={() => onChangeGSource(value)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${gSource === value ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                  {label}
                </button>
              ))}
            </div>
            <p className="w-full text-[11px] text-slate-400 leading-relaxed">
              {t('iPhone のラップタイマーで測った走行は、iPhone の G センサーの値も記録しています。「G センサー」にすると、ゆっくりした変化は計算した G、速い変化 (ブレーキの踏み始め・切り返し) は G センサーから取って合わせます。坂や iPhone の付け方のずれは残りません。',
                'Runs timed with the iPhone lap timer also record the iPhone G sensor. With "iPhone sensor", slow changes come from the calculated G and fast changes (start of braking, direction changes) from the sensor. Slopes and mounting angle do not leak in.')}
            </p>
          </div>
        )}
        <p className="text-[11px] text-slate-400 leading-relaxed">
          {t('G（加減速 G・横 G・合算 G）と旋回半径は、GPS の位置と車速の変化からアプリが計算しています（ロガーが G を測っているわけではありません）。 GPS の位置はわずかに揺れるので、計算した G も細かく揺れます。「ならし方」は、その揺れをどれだけ平らにするかの設定です。 強くするほど速度グラフの G 表示やフリクションサークルが落ち着きますが、急な変化（ブレーキの踏み始めなど）は鈍く、小さく出ます。 「標準」は記録レートに合わせてならし方を変えます。読み込み済みのログにもすぐ反映され、変換画面で書き出す「走行データCSV」・DTB の G もこの値になります。元のログファイルは変わりません。',
            'G (longitudinal, lateral and combined) and the turning radius are calculated by the app from changes in GPS position and speed (the logger does not measure G). GPS positions jitter slightly, so the calculated G jitters too. "Smoothing" sets how much of that jitter is flattened. Stronger smoothing calms the G display on the speed graph and the friction circle, but sudden changes (such as the start of braking) appear slower and smaller. "Standard" adapts to the logging rate. Changes apply immediately to loaded logs and to the G in the telemetry CSV and DTB exported on the convert page. The original log files are not changed.')}
        </p>
      </div>

      {/* セッション & ラップ一覧 */}
      {sessions.length === 0 ? (
        // タップ・クリックでファイルの選択画面を出す
        <button
          type="button"
          onClick={onOpenFile}
          disabled={!onOpenFile}
          className="w-full bg-surface-2 border border-line-2 rounded-xl p-12 text-center text-slate-400 transition-colors hover:border-red-500/60 hover:bg-surface-3 cursor-pointer disabled:cursor-default"
        >
          <FileText size={48} className="mx-auto mb-3 text-slate-600" />
          <p className="text-sm font-medium">{t('走行データが読み込まれていません', 'No driving data loaded')}</p>
          <p className="text-xs text-slate-500 mt-1">
            {t('ここをタップ（クリック）するか、画面の上の「ファイルを開く」（スマートフォンは「開く」）から、デジスパイス生ログ (.bnx4, .binx) や .dtb, .csv, .nmea などのログファイルを開いてください。', 'Tap (click) here or use "Open file" at the top to open a log file such as a DigSpice raw log (.bnx4, .binx), .dtb, .csv or .nmea.')}
          </p>
        </button>
      ) : (
        sessions.map(session => {
          const isFolded = folded.has(session.id);
          return (
          <div
            key={session.id}
            data-testid="session-card"
            className={`bg-surface-2 border border-line-2 rounded-xl shadow-md ${compact ? 'p-2 space-y-2' : 'p-4 space-y-4'}`}
          >
            {/* セッションヘッダー */}
            <div className={`flex flex-wrap items-center justify-between gap-2 ${isFolded ? '' : 'border-b border-line-2 pb-3'}`}>
              {/* 狭い枠 (解析の引き出し) でも名前や時計の補正が潰れないよう、入らなければ折り返す */}
              <div className={compact ? 'flex flex-wrap items-center gap-2 w-full' : 'flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0'}>
                <span className={`flex items-center gap-1 min-w-0 ${compact ? 'w-full' : 'shrink-0 max-w-full'}`}>
                  <button
                    type="button"
                    onClick={() => toggleFold(session.id)}
                    aria-expanded={!isFolded}
                    title={isFolded ? t('開く', 'Expand') : t('たたむ', 'Collapse')}
                    aria-label={isFolded ? t('開く', 'Expand') : t('たたむ', 'Collapse')}
                    data-testid="session-fold"
                    className="shrink-0 p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-surface-4 transition-colors cursor-pointer"
                  >
                    {isFolded ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </button>
                  <SessionNameField name={session.sessionName} compact={compact} onSave={name => onEditSessionName(session.id, name)} />
                </span>
                <span className="text-xs bg-surface-4 text-slate-300 px-2.5 py-0.5 rounded font-mono">
                  {session.circuitName ? circuitLabel(session.circuitName, lang) : t('一般コース', 'Unknown course')}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {session.samplingRate}Hz | {t(`計${session.laps.length}周`, `${session.laps.length} lap${(session.laps.length) === 1 ? '' : 's'}`)} | {session.totalDistance.toFixed(2)}km
                </span>
                {onSetClockOffset && (
                  <ClockOffsetControl session={session} onSet={onSetClockOffset} onEstimate={onEstimateClockOffset} />
                )}
              </div>
              {onEditSessionNote && <RunNoteField note={session.runNote} onSave={note => onEditSessionNote(session.id, note)} testId="session-note" />}

              {/* 変換画面へ・削除 */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => onOpenInConvert(session.id)}
                  title={t('このログを変換画面で開き、NMEA・GPX・CSV・.dtb などに書き出す', 'Open this log on the convert page to export it to NMEA, GPX, CSV, .dtb and more')}
                  data-testid="open-in-convert"
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-4 hover:bg-surface-5 text-xs text-slate-300 border border-line-4 transition-colors"
                >
                  <Repeat size={12} />
                  {t('変換画面で開く', 'Open in converter')}
                </button>
                <button
                  onClick={() => onRemoveSession(session.id)}
                  title={t('セッションを削除', 'Delete session')}
                  className="p-1.5 rounded hover:bg-red-900/40 text-slate-400 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            {!isFolded && (<>
            {/* 周回を区切れていないときは、その理由と対処を示す (全体が 1 周として表示されるため) */}
            {(!session.controlLine || session.laps.some(l => l.isWholeSession)) && (
              <div className="px-4 py-2 text-xs text-amber-300 bg-amber-500/10 border-b border-amber-500/30">
                {session.controlLine
                  ? t('計測線を 2 回以上通過していないため、周回を区切れていません。計測線の位置が合っているか確認してください。', 'The timing line was not crossed twice or more, so laps could not be split. Check that the timing line is in the right place.')
                  : t('計測線が未設定のため、周回を区切れません。', 'No timing line is set, so laps cannot be split.')}
                {t('「コースフォルダ一括設置」でコースデータを読み込むか、「コース編集」で計測線を設定してください。', ' Load course data with "Install course folder", or set a timing line in "Course editor".')}
              </div>
            )}

            {session.laps.some(l => l.isPartialLap) && (
              <div className="px-4 py-2 text-xs text-amber-300 bg-amber-500/10 border-b border-amber-500/30">
                {t('計測線の通過が 1 回のため、通過した点から末尾までを 1 周（途中まで）として扱っています。計測線より前の部分は使っていません。', 'The timing line was crossed only once, so the part from that crossing to the end is treated as one (partial) lap. The part before the timing line is not used.')}
              </div>
            )}

            {compact ? (
              // ラップ一覧 (スマートフォン): 1 周ずつのカード。タイムの下にベストとの差、ベストには BEST を出す
              <LapCards
                session={session}
                selectedCars={selectedCars}
                slotColors={slotColors}
                formatTime={formatTime}
                onSelectCarSlot={onSelectCarSlot}
              />
            ) : (
              // ラップ一覧テーブル
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-surface-1 text-slate-400 font-mono uppercase text-[11px] border-b border-line-2">
                    <tr>
                      <th className="py-2 px-3">Lap</th>
                      <th className="py-2 px-3">{t('ラップタイム', 'Lap time')}</th>
                      <th className="py-2 px-3">{t('最高速', 'Top speed')}</th>
                      <th className="py-2 px-3">{t('最低速', 'Min speed')}</th>
                      <th className="py-2 px-3">{t('平均速度', 'Avg speed')}</th>
                      <th className="py-2 px-3">{t('距離', 'Distance')}</th>
                      {session.sectors.map(sec => (
                        <th key={sec.id} className="py-2 px-3 text-amber-400">
                          {sec.name}
                        </th>
                      ))}
                      <th className="py-2 px-3 text-center">{t('スロット選択', 'Slot')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-1 font-mono">
                    {session.laps.map(lap => {
                      const isSelectedAny = selectedCars.some(
                        c => c.sessionId === session.id && c.lapNumber === lap.lapNumber
                      );

                      return (
                        <tr
                          key={lap.lapNumber}
                          className={`transition-colors hover:bg-surface-4 ${
                            lap.isBestLap ? 'bg-amber-950/20' : ''
                          }`}
                        >
                          {/* td 自体を flex にすると、表の行の中で縦の位置がずれる (ほかの欄より上に寄る) ので、中で並べる */}
                          <td className="py-2.5 px-3 font-bold">
                            <span className="inline-flex items-center gap-1.5">
                              {lap.isBestLap && <Trophy size={13} className="text-amber-400" />}
                              Lap {lap.lapNumber}
                            </span>
                          </td>
                          <td
                            className={`py-2.5 px-3 font-bold ${
                              lap.isBestLap ? 'text-amber-400 text-sm' : 'text-slate-100'
                            }`}
                          >
                            {formatTime(lap.lapTime)}
                            {lap.isPartialLap && (
                              <span className="ml-1.5 text-[10px] text-amber-300" title={t('次の計測線の通過までログがないため、実際のラップタイムではありません', 'The log ends before the next timing line crossing, so this is not a real lap time')}>
                                {t('(途中まで)', '(partial)')}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-slate-200">{lap.topSpeed.toFixed(1)} km/h</td>
                          <td className="py-2.5 px-3 text-slate-200">{lap.bottomSpeed.toFixed(1)} km/h</td>
                          <td className="py-2.5 px-3 text-slate-300">{lap.avgSpeed.toFixed(1)} km/h</td>
                          <td className="py-2.5 px-3 text-slate-400">{lap.distance.toFixed(3)} km</td>

                          {/* セクタータイム */}
                          {lap.sectors.map((secRes, sIdx) => (
                            <td
                              key={sIdx}
                              className={`py-2.5 px-3 ${
                                secRes.isBest ? 'text-amber-400 font-bold' : secRes.isEstimated ? 'text-slate-500' : 'text-slate-300'
                              }`}
                              title={secRes.isEstimated ? t('セクター線の通過を検出できなかったため推定値です（セクターベスト・理論ベストには使いません）', 'Estimated because the sector line crossing was not detected (not used for sector bests or the theoretical best)') : undefined}
                            >
                              {secRes.isEstimated ? '~' : ''}{secRes.time.toFixed(3)}s
                            </td>
                          ))}

                          {/* 車両スロット割り当てボタン (Car 1..4) */}
                          <td className="py-2.5 px-3 text-center">
                            <div className="flex items-center justify-center gap-1">
                              {slotColors.map(slot => {
                                const isCurrentSlot = selectedCars.some(
                                  c =>
                                    c.slot === slot.slot &&
                                    c.sessionId === session.id &&
                                    c.lapNumber === lap.lapNumber
                                );

                                return (
                                  <button
                                    key={slot.slot}
                                    onClick={() => onSelectCarSlot(slot.slot, session.id, lap.lapNumber)}
                                    title={t(`${slot.label} に割り当て`, `Assign to ${slot.label}`)}
                                    className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold transition-all ${
                                      isCurrentSlot
                                        ? `${slot.bg} text-white shadow`
                                        : 'bg-surface-4 text-slate-400 hover:text-fg hover:bg-surface-5'
                                    }`}
                                  >
                                    {slot.slot + 1}
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>

                  {/* 仮想ベストラップ行 */}
                  {session.theoreticalBestTime > 0 && session.sectors.length > 0 && (
                    <tfoot className="bg-surface-1 text-amber-300 font-mono font-bold text-[11px] border-t-2 border-amber-500/40">
                      <tr>
                        <td className="py-2 px-3">
                          <span className="inline-flex items-center gap-1 whitespace-nowrap">
                            <Trophy size={13} className="text-amber-400" />
                            {t('仮想ベスト', 'Theoretical best')}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-amber-400 text-sm">
                          {formatTime(session.theoreticalBestTime)}
                        </td>
                        <td colSpan={4} className="py-2 px-3 text-slate-400 font-normal">
                          {t('(各セクターのベストタイム合算値)', '(sum of the best time in each sector)')}
                        </td>
                        {session.sectors.map((sec, sIdx) => {
                          // セクターベストの印 (isBest) が付いた実測値だけを出す
                          const best = session.laps.map(l => l.sectors[sIdx]).find(r => r?.isBest);
                          return (
                            <td key={sec.id} className="py-2 px-3 text-amber-400">
                              {best ? `${best.time.toFixed(3)}s` : '--'}
                            </td>
                          );
                        })}
                        <td></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
            </>)}
          </div>
          );
        })
      )}
    </div>
  );
};

/** スマートフォン向けのラップ一覧 (1 周ずつのカード) */
const LapCards: React.FC<{
  session: Session;
  selectedCars: SelectedCarSlot[];
  slotColors: { slot: number; label: string; bg: string }[];
  formatTime: (sec: number) => string;
  onSelectCarSlot: (slotIndex: number, sessionId: string, lapNumber: number) => void;
}> = ({ session, selectedCars, slotColors, formatTime, onSelectCarSlot }) => {
  const t = useT();
  const bestLap = session.laps[session.bestLapIndex];
  // セクターごとのベスト (実測値のうち isBest が付いたもの)
  const bestSectors = session.sectors.map((_, sIdx) => session.laps.map(l => l.sectors[sIdx]).find(r => r?.isBest)?.time);
  // ベストとの差。ベストの対象外の周・区間 (短すぎるものなど) はベストより速いことがあるので、符号を付けて出す
  const delta = (v: number, best?: number) => {
    if (best === undefined) return '';
    const d = v - best;
    return `${d >= 0 ? '+' : ''}${d.toFixed(3)}`;
  };

  return (
    <div className="p-2 flex flex-col gap-2">
      {session.laps.map(lap => {
        const isBest = !!lap.isBestLap;
        return (
          <div
            key={lap.lapNumber}
            className={`rounded-lg border px-3 py-2.5 ${isBest ? 'border-red-500 bg-red-500/10' : 'border-line-2 bg-surface-1'}`}
          >
            <div className="flex items-start gap-3">
              <span className={`font-mono text-sm pt-1 w-8 shrink-0 ${isBest ? 'text-red-400 font-bold' : 'text-slate-500'}`}>
                L{String(lap.lapNumber).padStart(2, '0')}
              </span>
              <div className="flex-1 min-w-0">
                <div className={`font-mono text-xl font-bold leading-tight ${isBest ? 'text-emerald-400' : 'text-slate-100'}`}>
                  {formatTime(lap.lapTime)}
                </div>
                <div className={`font-mono text-[11px] ${isBest ? 'text-emerald-400 font-bold' : 'text-slate-500'}`}>
                  {lap.isPartialLap ? (isBest ? t('BEST（途中まで）', 'BEST (partial)') : t('途中まで', 'Partial')) : isBest ? 'BEST' : bestLap ? delta(lap.lapTime, bestLap.lapTime) : ''}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] font-bold text-slate-500 tracking-wider">MAX SPEED</div>
                <div className="font-mono text-sm text-slate-200">
                  {lap.topSpeed.toFixed(1)} <span className="text-[10px] text-slate-400">km/h</span>
                </div>
              </div>
            </div>

            {lap.sectors.length > 0 && (
              <div className="grid grid-cols-4 gap-x-2 gap-y-1.5 mt-2 pl-11">
                {lap.sectors.map((sec, sIdx) => (
                  <div
                    key={sIdx}
                    title={sec.isEstimated ? t('セクター線の通過を検出できなかったため推定値です（セクターベスト・理論ベストには使いません）', 'Estimated because the sector line crossing was not detected (not used for sector bests or the theoretical best)') : undefined}
                  >
                    <div className="text-[10px] font-bold text-slate-500">{session.sectors[sIdx]?.name ?? `S${sIdx + 1}`}</div>
                    <div className={`font-mono text-sm leading-tight ${sec.isBest ? 'text-emerald-400' : sec.isEstimated ? 'text-slate-500' : 'text-slate-200'}`}>
                      {sec.isEstimated ? '~' : ''}{sec.time.toFixed(3)}
                    </div>
                    <div className={`font-mono text-[10px] ${sec.isBest ? 'text-emerald-400 font-bold' : 'text-slate-500'}`}>
                      {sec.isBest ? 'BEST' : sec.isEstimated ? t('推定', 'Est.') : delta(sec.time, bestSectors[sIdx])}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 比較スロットへの割り当て (Car 1..4) */}
            <div className="flex items-center justify-end gap-1.5 mt-2">
              {slotColors.map(slot => {
                const isCurrentSlot = selectedCars.some(
                  c => c.slot === slot.slot && c.sessionId === session.id && c.lapNumber === lap.lapNumber
                );
                return (
                  <button
                    key={slot.slot}
                    onClick={() => onSelectCarSlot(slot.slot, session.id, lap.lapNumber)}
                    aria-label={t(`${slot.label} に割り当て`, `Assign to ${slot.label}`)}
                    className={`w-9 h-8 rounded text-xs font-bold ${
                      isCurrentSlot ? `${slot.bg} text-white shadow` : 'bg-surface-4 text-slate-400'
                    }`}
                  >
                    {slot.slot + 1}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {session.theoreticalBestTime > 0 && session.sectors.length > 0 && (
        <div className="flex items-center justify-between border-t border-line-2 mt-1 pt-3 px-1">
          <span className="text-xs font-bold text-slate-400 tracking-wider">{t('理論ベスト', 'Theoretical best')}</span>
          <span className="font-mono text-lg font-bold text-emerald-400">{formatTime(session.theoreticalBestTime)}</span>
        </div>
      )}
    </div>
  );
};
