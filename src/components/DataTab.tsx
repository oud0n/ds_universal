import React from 'react';
import { Session, SelectedCarSlot, Sector, ControlLine } from '../types/telemetry';
import { exportDigispiceCsv, exportLapListCsv } from '../services/csvParser';
import { exportNmea, exportGpx } from '../services/nmeaParser';
import { exportDtb } from '../services/dtbParser';
import { MOTEC_CSV_ENABLED, exportMotecCsv } from '../services/externalFormats';
import { CIRCUIT_PRESETS } from '../services/circuitDatabase';
import {
  FileText,
  Download,
  Trash2,
  Trophy,
  CheckCircle2,
  Circle,
  MapPin,
  Settings2,
  Layers,
  Edit3,
  FolderOpen,
  Globe
} from 'lucide-react';
import { userCircuitStorage } from '../services/userCircuitStorage';

interface DataTabProps {
  sessions: Session[];
  selectedCars: SelectedCarSlot[];
  onSelectCarSlot: (slotIndex: number, sessionId: string, lapNumber: number) => void;
  onSetDistanceOffset: (slotIndex: number, offsetM: number) => void;
  alignLapLength: boolean;
  onSetAlignLapLength: (value: boolean) => void;
  // 基準車のスロット (Car 1 が空のときは割り当てのある一番若いスロット)。基準車には距離補正を出さない
  baseSlot?: number;
  onRemoveSession: (sessionId: string) => void;
  onEditSessionName: (sessionId: string, newName: string) => void;
  onSelectCircuitPreset: (presetId: string) => void;
  onOpenCircuitEditor: () => void;
  onLoadPthFile: () => void;
  onLoadClnFile: () => void;
  onLoadCircuitFolder?: () => void;
}

export const DataTab: React.FC<DataTabProps> = ({
  sessions,
  selectedCars,
  onSelectCarSlot,
  onSetDistanceOffset,
  alignLapLength,
  onSetAlignLapLength,
  baseSlot,
  onRemoveSession,
  onEditSessionName,
  onSelectCircuitPreset,
  onOpenCircuitEditor,
  onLoadPthFile,
  onLoadClnFile,
  onLoadCircuitFolder
}) => {
  const formatTime = (sec: number) => {
    if (!sec || isNaN(sec)) return '--:--.---';
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(3).padStart(6, '0');
    return `${m}:${s}`;
  };

  const slotColors = [
    { slot: 0, label: 'Car 1 (基準車: 赤)', hex: '#ef4444', bg: 'bg-red-600' },
    { slot: 1, label: 'Car 2 (青)', hex: '#3b82f6', bg: 'bg-blue-600' },
    { slot: 2, label: 'Car 3 (緑)', hex: '#10b981', bg: 'bg-emerald-600' },
    { slot: 3, label: 'Car 4 (橙)', hex: '#f59e0b', bg: 'bg-amber-500' }
  ];

  // ダウンロードヘルパー
  const downloadFile = (content: string | Uint8Array, fileName: string, mimeType: string) => {
    const blob = new Blob([content as any], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // CSVエクスポート
  const handleExportCsv = (session: Session) => {
    const csv = exportDigispiceCsv(session.points);
    downloadFile(csv, `${session.sessionName}_telemetry.csv`, 'text/csv;charset=utf-8');
  };

  // ラップ一覧CSVエクスポート
  const handleExportLapListCsv = (session: Session) => {
    const csv = exportLapListCsv(session.laps);
    downloadFile(csv, `${session.sessionName}_lap_list.csv`, 'text/csv;charset=utf-8');
  };

  // NMEAエクスポート
  const handleExportNmea = (session: Session) => {
    const nmea = exportNmea(session.points);
    downloadFile(nmea, `${session.sessionName}.nmea`, 'text/plain;charset=utf-8');
  };

  // GPXエクスポート (RaceChrono等連携用)
  const handleExportGpx = (session: Session) => {
    const gpx = exportGpx(session.points, session.sessionName);
    downloadFile(gpx, `${session.sessionName}.gpx`, 'application/gpx+xml;charset=utf-8');
  };

  // MoTeC CSV エクスポート
  const handleExportMotecCsv = (session: Session) => {
    downloadFile(exportMotecCsv(session), `${session.sessionName}_motec.csv`, 'text/csv;charset=utf-8');
  };

  // .dtb エクスポート
  const handleExportDtb = (session: Session) => {
    const bytes = exportDtb(session.points, session.samplingRate);
    downloadFile(bytes, `${session.sessionName}.dtb`, 'application/octet-stream');
  };

  return (
    <div className="flex flex-col h-full bg-[#12141a] text-slate-200 overflow-y-auto p-4 space-y-6">
      {/* 上部: コース設定 & プリセット切り替えバー */}
      <div className="bg-[#181c26] border border-[#272f42] rounded-xl p-4 shadow-md flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-red-600/20 text-red-500 rounded-lg">
            <MapPin size={22} />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-100">コース / コントロールライン設定</h2>
            <p className="text-xs text-slate-400">全国主要サーキットのプリセット、または独自コースの定義</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* サーキットプリセット選択 */}
          <select
            onChange={e => onSelectCircuitPreset(e.target.value)}
            className="bg-[#10131a] border border-[#2d364c] text-xs text-slate-200 rounded-lg px-3 py-2 outline-none focus:border-red-500 transition-colors"
          >
            <option value="">-- サーキットプリセット選択 --</option>
            {CIRCUIT_PRESETS.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          {/* ユーザーコースフォルダ一括設置 */}
          {onLoadCircuitFolder && (
            <button
              onClick={onLoadCircuitFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700/80 hover:bg-emerald-600 text-xs text-white font-medium transition-colors shadow"
              title="公式アプリや自前の Circuit/ControlLine フォルダを選択して一括登録"
            >
              <FolderOpen size={13} />
              コースフォルダ一括設置
              {userCircuitStorage.getCircuitCount() > 0 && (
                <span className="bg-emerald-900 text-emerald-200 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
                  {userCircuitStorage.getCircuitCount()}
                </span>
              )}
            </button>
          )}

          {/* コース図読込 */}
          <button
            onClick={onLoadPthFile}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#222838] hover:bg-[#2c344a] text-xs text-slate-300 border border-[#333d54] transition-colors"
          >
            <Layers size={13} />
            コース図 (.pth)
          </button>

          {/* コントロールライン読込 */}
          <button
            onClick={onLoadClnFile}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#222838] hover:bg-[#2c344a] text-xs text-slate-300 border border-[#333d54] transition-colors"
          >
            <FileText size={13} />
            計測線 (.cln)
          </button>

          {/* コース編集モーダルを開く */}
          <button
            onClick={onOpenCircuitEditor}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-xs text-white font-medium transition-colors"
          >
            <Edit3 size={13} />
            コース編集
          </button>
        </div>
      </div>

      {/* 比較スロット (Car 1〜4) の選択状態バー */}
      <div className="bg-[#181c26] border border-[#272f42] rounded-xl p-3 shadow-md">
        <div className="text-xs font-bold text-slate-300 mb-2 flex items-center justify-between">
          <span>比較スロット割り当て (最大4台 同時比較)</span>
          <span className="text-[11px] text-slate-400 font-normal">
            下のラップ表のボタンをクリックして割り当ててください
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {slotColors.map(slot => {
            const assigned = selectedCars.find(c => c.slot === slot.slot);
            return (
              <div
                key={slot.slot}
                className="flex items-center justify-between p-2.5 rounded-lg border bg-[#12151f]"
                style={{ borderColor: assigned ? slot.hex : '#272f42' }}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-3 h-3 rounded-full ${slot.bg}`} />
                  <div>
                    <div className="text-xs font-bold text-slate-200">{slot.label}</div>
                    <div className="text-[11px] text-slate-400 font-mono">
                      {assigned ? assigned.label : '未割り当て'}
                    </div>
                    {/* 比較車両の距離の手動補正 (基準車は補正しない) */}
                    {assigned && slot.slot !== baseSlot && (
                      <div
                        className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"
                        title="重ねたときの前後のずれを補正します。+ で基準車より前（グラフの右）へずらします。Shift を押しながらクリックで 10 m 単位"
                      >
                        <span>距離補正</span>
                        <button
                          onClick={e => onSetDistanceOffset(slot.slot, (assigned.distanceOffsetM || 0) - (e.shiftKey ? 10 : 1))}
                          className="px-1.5 rounded border border-[#2e374c] hover:text-slate-200"
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
                          className="w-14 bg-[#0f121a] border border-[#2e374c] rounded px-1 text-right font-mono text-slate-200"
                        />
                        <span>m</span>
                        <button
                          onClick={e => onSetDistanceOffset(slot.slot, (assigned.distanceOffsetM || 0) + (e.shiftKey ? 10 : 1))}
                          className="px-1.5 rounded border border-[#2e374c] hover:text-slate-200"
                        >
                          ＋
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <label
          className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer w-fit"
          title="ロガーごとの 1 周の距離の差（1〜2% 程度）を、比較車両のラップを伸縮して基準車の 1 周の長さに合わせて吸収します。計測線から計測線までの 1 周どうしのときだけ効きます"
        >
          <input type="checkbox" checked={alignLapLength} onChange={e => onSetAlignLapLength(e.target.checked)} />
          1 周の長さを基準車にそろえる
        </label>
      </div>

      {/* セッション & ラップ一覧 */}
      {sessions.length === 0 ? (
        <div className="bg-[#181c26] border border-[#272f42] rounded-xl p-12 text-center text-slate-400">
          <FileText size={48} className="mx-auto mb-3 text-slate-600" />
          <p className="text-sm font-medium">走行データが読み込まれていません</p>
          <p className="text-xs text-slate-500 mt-1">
            上部の「ファイル読込」からデジスパイス生ログ (.bnx4, .binx) や .dtb, .csv, .nmea などのログファイルを開いてください。
          </p>
        </div>
      ) : (
        sessions.map(session => (
          <div
            key={session.id}
            className="bg-[#181c26] border border-[#272f42] rounded-xl p-4 shadow-md space-y-4"
          >
            {/* セッションヘッダー */}
            <div className="flex flex-wrap items-center justify-between border-b border-[#272f42] pb-3 gap-2">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={session.sessionName}
                  onChange={e => onEditSessionName(session.id, e.target.value)}
                  className="bg-[#12151f] border border-[#2d364c] text-sm font-bold text-slate-100 rounded px-2.5 py-1 focus:border-red-500 outline-none"
                  title="クリックして名前を変更"
                />
                <span className="text-xs bg-[#242c3d] text-slate-300 px-2.5 py-0.5 rounded font-mono">
                  {session.circuitName || '一般コース'}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {session.samplingRate}Hz | 計{session.laps.length}周 | {session.totalDistance.toFixed(2)}km
                </span>
              </div>

              {/* エクスポート・削除アクション */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => handleExportCsv(session)}
                  title="デジスパイス公式フォーマットでCSV保存"
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#222838] hover:bg-[#2c344a] text-xs text-slate-300 border border-[#333d54] transition-colors"
                >
                  <Download size={12} />
                  走行データCSV
                </button>
                <button
                  onClick={() => handleExportLapListCsv(session)}
                  title="全周のラップタイム一覧をCSV保存"
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#222838] hover:bg-[#2c344a] text-xs text-slate-300 border border-[#333d54] transition-colors"
                >
                  <Download size={12} />
                  ラップ一覧CSV
                </button>
                <button
                  onClick={() => handleExportNmea(session)}
                  title="NMEA形式 (.nmea) で出力 (公式ツール互換)"
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#222838] hover:bg-[#2c344a] text-xs text-slate-300 border border-[#333d54] transition-colors"
                >
                  <Download size={12} />
                  NMEA出力
                </button>
                <button
                  onClick={() => handleExportGpx(session)}
                  title="GPX形式 (.gpx) で出力 (RaceChrono等スマートフォンアプリ連携用)"
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#222838] hover:bg-[#2c344a] text-xs text-cyan-300 border border-cyan-800/40 transition-colors"
                >
                  <Download size={12} />
                  GPX出力
                </button>
                {MOTEC_CSV_ENABLED && (
                  <button
                    onClick={() => handleExportMotecCsv(session)}
                    title="MoTeC CSV 形式 (i2 の CSV エクスポートと同じ書式) で出力"
                    className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#222838] hover:bg-[#2c344a] text-xs text-slate-300 border border-[#333d54] transition-colors"
                  >
                    <Download size={12} />
                    MoTeC CSV
                  </button>
                )}
                <button
                  onClick={() => handleExportDtb(session)}
                  title="デジスパイス独自バイナリ (.dtb) として保存"
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-red-950/40 hover:bg-red-900/60 text-xs text-red-300 border border-red-800/40 transition-colors"
                >
                  <Download size={12} />
                  .dtb 保存
                </button>
                <button
                  onClick={() => onRemoveSession(session.id)}
                  title="セッションを削除"
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
                  ? '計測線を 2 回以上通過していないため、周回を区切れていません。計測線の位置が合っているか確認してください。'
                  : '計測線が未設定のため、周回を区切れません。'}
                「コースフォルダ一括設置」でコースデータを読み込むか、「コース編集」で計測線を設定してください。
              </div>
            )}

            {session.laps.some(l => l.isPartialLap) && (
              <div className="px-4 py-2 text-xs text-amber-300 bg-amber-500/10 border-b border-amber-500/30">
                計測線の通過が 1 回のため、通過した点から末尾までを 1 周（途中まで）として扱っています。計測線より前の部分は使っていません。
              </div>
            )}

            {/* ラップ一覧テーブル */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-[#12151f] text-slate-400 font-mono uppercase text-[11px] border-b border-[#272f42]">
                  <tr>
                    <th className="py-2 px-3">Lap</th>
                    <th className="py-2 px-3">ラップタイム</th>
                    <th className="py-2 px-3">最高速</th>
                    <th className="py-2 px-3">最低速</th>
                    <th className="py-2 px-3">平均速度</th>
                    <th className="py-2 px-3">距離</th>
                    {session.sectors.map(sec => (
                      <th key={sec.id} className="py-2 px-3 text-amber-400">
                        {sec.name}
                      </th>
                    ))}
                    <th className="py-2 px-3 text-center">スロット選択</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#202738] font-mono">
                  {session.laps.map(lap => {
                    const isSelectedAny = selectedCars.some(
                      c => c.sessionId === session.id && c.lapNumber === lap.lapNumber
                    );

                    return (
                      <tr
                        key={lap.lapNumber}
                        className={`transition-colors hover:bg-[#1f2636] ${
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
                            <span className="ml-1.5 text-[10px] text-amber-300" title="次の計測線の通過までログがないため、実際のラップタイムではありません">
                              (途中まで)
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
                            title={secRes.isEstimated ? 'セクター線の通過を検出できなかったため推定値です（セクターベスト・理論ベストには使いません）' : undefined}
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
                                  title={`${slot.label} に割り当て`}
                                  className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold transition-all ${
                                    isCurrentSlot
                                      ? `${slot.bg} text-white shadow`
                                      : 'bg-[#252d3f] text-slate-400 hover:text-white hover:bg-[#323c54]'
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
                  <tfoot className="bg-[#121622] text-amber-300 font-mono font-bold text-[11px] border-t-2 border-amber-500/40">
                    <tr>
                      <td className="py-2 px-3 flex items-center gap-1">
                        <Trophy size={13} className="text-amber-400" />
                        仮想ベスト
                      </td>
                      <td className="py-2 px-3 text-amber-400 text-sm">
                        {formatTime(session.theoreticalBestTime)}
                      </td>
                      <td colSpan={4} className="py-2 px-3 text-slate-400 font-normal">
                        (各セクターのベストタイム合算値)
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
          </div>
        ))
      )}
    </div>
  );
};
