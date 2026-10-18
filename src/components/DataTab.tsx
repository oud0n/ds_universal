import React, { useState } from 'react';
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
  X
} from 'lucide-react';
import { formatMinSec } from '../utils/timeFormat';
import { useCompactLayout } from '../hooks/useCompactLayout';
import { GFilterLevel } from '../services/physics';
import { circuitLabel, useLang, useT } from '../utils/i18n';

interface DataTabProps {
  sessions: Session[];
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
  onRemoveSession: (sessionId: string) => void;
  onOpenInConvert: (sessionId: string) => void;
  onEditSessionName: (sessionId: string, newName: string) => void;
  onSelectCircuitPreset: (presetId: string) => void;
  onOpenCircuitEditor: () => void;
  onLoadPthFile: () => void;
  onLoadClnFile: () => void;
  onLoadCircuitFolder?: () => void;
  // 走行データのファイルを選ぶ (データがないときの案内をタップ・クリックしたとき)
  onOpenFile?: () => void;
  // G のならし方 (解析の設定)
  gFilterLevel: GFilterLevel;
  onChangeGFilterLevel: (level: GFilterLevel) => void;
}

export const DataTab: React.FC<DataTabProps> = ({
  sessions,
  selectedCars,
  onSelectCarSlot,
  onClearCarSlot,
  onSetDistanceOffset,
  alignLapLength,
  onSetAlignLapLength,
  baseSlot,
  userCircuitCount,
  onRemoveSession,
  onOpenInConvert,
  onEditSessionName,
  onSelectCircuitPreset,
  onOpenCircuitEditor,
  onLoadPthFile,
  onLoadClnFile,
  onLoadCircuitFolder,
  onOpenFile,
  gFilterLevel,
  onChangeGFilterLevel
}) => {
  // スマートフォン向けの配置では、ラップ一覧を表でなく 1 周ずつのカードで出す
  const compact = useCompactLayout();
  const t = useT();
  const lang = useLang();
  // スマートフォンでは、コースの設定はたたんでおき、見出しをタップして開く (ラップ一覧を先に見せる)
  const [courseOpen, setCourseOpen] = useState(false);
  const showCourseTools = !compact || courseOpen;

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
            onChange={e => onSelectCircuitPreset(e.target.value)}
            className="bg-surface-0 border border-line-3 text-xs text-slate-200 rounded-lg px-3 py-2 outline-none focus:border-red-500 transition-colors"
          >
            <option value="">{t('-- サーキットプリセット選択 --', '-- Select a circuit preset --')}</option>
            {CIRCUIT_PRESETS.map(c => (
              <option key={c.id} value={c.id}>
                {circuitLabel(c.name, lang)}
              </option>
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
        </div>
      </div>

      {/* 比較スロット (Car 1〜4) の選択状態バー */}
      <div className="bg-surface-2 border border-line-2 rounded-xl p-3 shadow-md">
        <div className="text-xs font-bold text-slate-300 mb-2 flex items-center justify-between">
          <span>{t('比較スロット割り当て (最大4台 同時比較)', 'Comparison slots (up to 4 cars)')}</span>
          <span className="text-[11px] text-slate-400 font-normal">
            {t('下のラップ表のボタンをクリックして割り当ててください', 'Assign laps with the buttons in the lap tables below')}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
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
            {t('ここをタップ（クリック）するか、上部の「ファイル読込」から、デジスパイス生ログ (.bnx4, .binx) や .dtb, .csv, .nmea などのログファイルを開いてください。', 'Tap (click) here or use "Open file" at the top to open a log file such as a DigSpice raw log (.bnx4, .binx), .dtb, .csv or .nmea.')}
          </p>
        </button>
      ) : (
        sessions.map(session => (
          <div
            key={session.id}
            className={`bg-surface-2 border border-line-2 rounded-xl shadow-md ${compact ? 'p-2 space-y-2' : 'p-4 space-y-4'}`}
          >
            {/* セッションヘッダー */}
            <div className="flex flex-wrap items-center justify-between border-b border-line-2 pb-3 gap-2">
              <div className={compact ? 'flex flex-wrap items-center gap-2 w-full' : 'flex items-center gap-3'}>
                <input
                  type="text"
                  value={session.sessionName}
                  onChange={e => onEditSessionName(session.id, e.target.value)}
                  className={`bg-surface-1 border border-line-3 text-sm font-bold text-slate-100 rounded px-2.5 py-1 focus:border-red-500 outline-none min-w-0 ${compact ? 'w-full' : ''}`}
                  title={t('クリックして名前を変更', 'Click to rename')}
                />
                <span className="text-xs bg-surface-4 text-slate-300 px-2.5 py-0.5 rounded font-mono">
                  {session.circuitName ? circuitLabel(session.circuitName, lang) : t('一般コース', 'Unknown course')}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {session.samplingRate}Hz | {t(`計${session.laps.length}周`, `${session.laps.length} laps`)} | {session.totalDistance.toFixed(2)}km
                </span>
              </div>

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
                          <td className="py-2.5 px-3 font-bold flex items-center gap-1.5">
                            {lap.isBestLap && <Trophy size={13} className="text-amber-400" />}
                            Lap {lap.lapNumber}
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
                        <td className="py-2 px-3 flex items-center gap-1">
                          <Trophy size={13} className="text-amber-400" />
                          {t('仮想ベスト', 'Theoretical best')}
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
          </div>
        ))
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
