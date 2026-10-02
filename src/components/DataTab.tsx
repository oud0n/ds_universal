import React from 'react';
import { Session, SelectedCarSlot, Sector, ControlLine } from '../types/telemetry';
import { exportDigispiceCsv, exportLapListCsv } from '../services/csvParser';
import { exportNmea, exportGpx } from '../services/nmeaParser';
import { exportDtb } from '../services/dtbParser';
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
                  </div>
                </div>
              </div>
            );
          })}
        </div>
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
                              secRes.isBest ? 'text-amber-400 font-bold' : 'text-slate-300'
                            }`}
                          >
                            {secRes.time.toFixed(3)}s
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
                        const bestSecTime = Math.min(
                          ...session.laps.map(l => l.sectors[sIdx]?.time || 9999).filter(t => t < 9000)
                        );
                        return (
                          <td key={sec.id} className="py-2 px-3 text-amber-400">
                            {bestSecTime.toFixed(3)}s
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
