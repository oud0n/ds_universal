import React, { useEffect, useMemo, useState } from 'react';
import { Download, FolderOpen, Repeat } from 'lucide-react';
import { Session } from '../types/telemetry';
import {
  ConvertRange, selectConvertPoints, toTelemetryPoints, hasRecordedClock, convertToNmea, convertToGpx, convertToCsv, convertToHtmlMap
} from '../services/logConverter';
import { exportDtb } from '../services/dtbParser';
import { triggerFileDownload } from '../services/nmeaExporter';

interface ConvertTabProps {
  sessions: Session[];
  onOpenFile: () => void;
  onDropFiles: (files: FileList) => void;
}

type RangeKind = 'all' | 'lap' | 'time';

const fmtTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 23);

// 走行ログを他の形式 (NMEA / GPX / CSV / DTB / 地図 HTML) に書き出すページ
export const ConvertTab: React.FC<ConvertTabProps> = ({ sessions, onOpenFile, onDropFiles }) => {
  const [sessionId, setSessionId] = useState<string>('');
  const [rangeKind, setRangeKind] = useState<RangeKind>('all');
  const [lapNumber, setLapNumber] = useState<number>(1);
  const [startSec, setStartSec] = useState<string>('0');
  const [endSec, setEndSec] = useState<string>('0');
  const [offsetHours, setOffsetHours] = useState<number>(0);
  const [talkerId, setTalkerId] = useState<'GP' | 'GN'>('GP');
  const [includeGga, setIncludeGga] = useState(true);
  const [dragOver, setDragOver] = useState(false);

  // 選択中のセッションが無くなったら、最後に読み込んだものを選ぶ
  const session = sessions.find(s => s.id === sessionId) ?? sessions[sessions.length - 1];
  useEffect(() => {
    if (session && session.id !== sessionId) setSessionId(session.id);
  }, [session, sessionId]);

  const duration = session && session.points.length > 0
    ? session.points[session.points.length - 1].time - session.points[0].time
    : 0;

  // セッションを切り替えたら範囲の入力を初期化する
  useEffect(() => {
    if (!session) return;
    setRangeKind('all');
    setLapNumber(session.laps[session.bestLapIndex]?.lapNumber ?? session.laps[0]?.lapNumber ?? 1);
    setStartSec('0');
    setEndSec(duration.toFixed(1));
  }, [session?.id]);

  const range: ConvertRange = useMemo(() => {
    if (rangeKind === 'lap') return { kind: 'lap', lapNumber };
    if (rangeKind === 'time') {
      const base = session?.points[0]?.time ?? 0;
      const a = parseFloat(startSec);
      const b = parseFloat(endSec);
      return {
        kind: 'time',
        startSec: base + (Number.isFinite(a) ? a : 0),
        endSec: base + (Number.isFinite(b) ? b : duration)
      };
    }
    return { kind: 'all' };
  }, [rangeKind, lapNumber, startSec, endSec, session, duration]);

  const points = useMemo(
    () => (session ? selectConvertPoints(session, range, offsetHours) : []),
    [session, range, offsetHours]
  );

  const summary = useMemo(() => {
    if (points.length === 0) return null;
    let maxSpeed = 0;
    for (const p of points) if (p.speed > maxSpeed) maxSpeed = p.speed;
    const first = points[0];
    const last = points[points.length - 1];
    return {
      start: fmtTime(first.time),
      end: fmtTime(last.time),
      seconds: (last.time.getTime() - first.time.getTime()) / 1000,
      distance: last.distance,
      maxSpeed,
      hasSatellites: points.some(p => p.satellites != null)
    };
  }, [points]);

  const baseName = session
    ? session.sessionName.replace(/[\\/:*?"<>|]/g, '_') + (rangeKind === 'lap' ? `_L${lapNumber}` : rangeKind === 'time' ? '_trim' : '')
    : 'log';

  const save = (ext: string, content: string, mime: string) => triggerFileDownload(`${baseName}.${ext}`, content, mime);

  const saveDtb = () => {
    if (!session || points.length === 0) return;
    const bytes = exportDtb(toTelemetryPoints(points), session.samplingRate, points[0].time);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.dtb`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const inputCls = 'bg-[#10131a] border border-[#2d364c] text-xs text-slate-200 rounded-lg px-3 py-2 outline-none focus:border-red-500';
  const btnCls = 'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#222838] hover:bg-[#2c344a] text-xs text-slate-200 border border-[#333d54] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const disabled = points.length === 0;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-3 pb-6">
        {/* 読み込み */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length > 0) onDropFiles(e.dataTransfer.files);
          }}
          className={`bg-[#181c26] border rounded-xl p-5 flex flex-col sm:flex-row items-center gap-4 ${dragOver ? 'border-red-500' : 'border-[#272f42]'}`}
        >
          <div className="p-2.5 rounded-lg bg-red-500/10 text-red-400"><Repeat size={20} /></div>
          <div className="flex-1 text-center sm:text-left">
            <h2 className="text-sm font-bold text-slate-100">ログ変換</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              走行ログ (.bnx4 / .bon4 / .dtb / NMEA / CSV / VBO) を読み込み、NMEA・GPX・CSV などに書き出します。
              ファイルをここにドロップしても読み込めます。処理はすべてこの端末内で行われます。
            </p>
          </div>
          <button onClick={onOpenFile} data-testid="convert-open" className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-xs text-white font-bold">
            <FolderOpen size={14} />
            ファイル読込
          </button>
        </div>

        {!session ? (
          <div className="bg-[#181c26] border border-[#272f42] rounded-xl p-8 text-center text-xs text-slate-500">
            まだログが読み込まれていません。
          </div>
        ) : (
          <>
            {/* 設定 */}
            <div className="bg-[#181c26] border border-[#272f42] rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span>対象のログ</span>
                  <select value={session.id} onChange={e => setSessionId(e.target.value)} className={`${inputCls} w-full`} data-testid="convert-session">
                    {sessions.map(s => (
                      <option key={s.id} value={s.id}>{s.sessionName}（{s.points.length} 点）</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span>書き出す範囲</span>
                  <select value={rangeKind} onChange={e => setRangeKind(e.target.value as RangeKind)} className={`${inputCls} w-full`} data-testid="convert-range">
                    <option value="all">ログ全体</option>
                    <option value="lap">ラップを 1 周</option>
                    <option value="time">時間で指定</option>
                  </select>
                </label>
              </div>

              {rangeKind === 'lap' && (
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span>ラップ</span>
                  <select value={lapNumber} onChange={e => setLapNumber(Number(e.target.value))} className={`${inputCls} w-full sm:w-1/2`} data-testid="convert-lap">
                    {session.laps.map(l => (
                      <option key={l.lapNumber} value={l.lapNumber}>
                        L{l.lapNumber}　{l.lapTime.toFixed(3)} 秒{l.isBestLap ? '（ベスト）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {rangeKind === 'time' && (
                <div className="flex items-end gap-2 flex-wrap">
                  <label className="text-xs text-slate-400 space-y-1 block">
                    <span>開始（先頭からの秒）</span>
                    <input type="number" min={0} step={0.1} value={startSec} onChange={e => setStartSec(e.target.value)} className={`${inputCls} w-36`} data-testid="convert-start" />
                  </label>
                  <label className="text-xs text-slate-400 space-y-1 block">
                    <span>終了（先頭からの秒）</span>
                    <input type="number" min={0} step={0.1} value={endSec} onChange={e => setEndSec(e.target.value)} className={`${inputCls} w-36`} data-testid="convert-end" />
                  </label>
                  <span className="text-[11px] text-slate-500 pb-2">ログの長さ: {duration.toFixed(1)} 秒</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span>時刻の調整（時間）</span>
                  <select value={offsetHours} onChange={e => setOffsetHours(Number(e.target.value))} className={`${inputCls} w-full`} data-testid="convert-offset">
                    {Array.from({ length: 27 }, (_, i) => i - 12).map(h => (
                      <option key={h} value={h}>{h === 0 ? '調整しない（UTC のまま）' : `${h > 0 ? '+' : ''}${h} 時間`}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span>NMEA の識別子</span>
                  <select value={talkerId} onChange={e => setTalkerId(e.target.value as 'GP' | 'GN')} className={`${inputCls} w-full`}>
                    <option value="GP">$GP（GPS）</option>
                    <option value="GN">$GN（GNSS）</option>
                  </select>
                </label>
                <label className="text-xs text-slate-300 flex items-center gap-2 sm:pt-6">
                  <input type="checkbox" checked={includeGga} onChange={e => setIncludeGga(e.target.checked)} />
                  NMEA に GGA（標高・衛星数）を含める
                </label>
              </div>
            </div>

            {/* 概要 */}
            <div className="bg-[#181c26] border border-[#272f42] rounded-xl p-4 text-xs text-slate-300 font-mono" data-testid="convert-summary">
              {summary ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                  <span>点数: {points.length}</span>
                  <span>長さ: {summary.seconds.toFixed(1)} 秒 / {summary.distance.toFixed(2)} km</span>
                  <span>開始: {summary.start}</span>
                  <span>終了: {summary.end}</span>
                  <span>最高速度: {summary.maxSpeed.toFixed(1)} km/h</span>
                  <span>衛星数の記録: {summary.hasSatellites ? 'あり' : 'なし（NMEA では 12 として出力）'}</span>
                </div>
              ) : (
                <span className="text-amber-400">この範囲に書き出せる点がありません。</span>
              )}
              {summary && !hasRecordedClock(session) && (
                <p className="text-amber-400 mt-2 font-sans" data-testid="convert-noclock">
                  このログには記録日時がありません。読み込んだ日の 0 時（UTC）を先頭とした仮の日時で書き出します。
                </p>
              )}
            </div>

            {/* 書き出し */}
            <div className="bg-[#181c26] border border-[#272f42] rounded-xl p-4">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                <button disabled={disabled} className={btnCls} data-testid="convert-nmea"
                  onClick={() => save('nmea', convertToNmea(points, talkerId, includeGga), 'text/plain')}>
                  <Download size={13} /> NMEA
                </button>
                <button disabled={disabled} className={btnCls} data-testid="convert-gpx"
                  onClick={() => save('gpx', convertToGpx(points, baseName), 'application/gpx+xml')}>
                  <Download size={13} /> GPX
                </button>
                <button disabled={disabled} className={btnCls} data-testid="convert-csv"
                  onClick={() => save('csv', convertToCsv(points), 'text/csv')}>
                  <Download size={13} /> CSV
                </button>
                <button disabled={disabled} className={btnCls} data-testid="convert-dtb" onClick={saveDtb}>
                  <Download size={13} /> DTB
                </button>
                <button disabled={disabled} className={btnCls} data-testid="convert-html"
                  onClick={() => save('html', convertToHtmlMap(points, baseName), 'text/html')}>
                  <Download size={13} /> 地図 HTML
                </button>
              </div>
              <p className="text-[11px] text-slate-500 mt-3">
                NMEA / GPX は RaceChrono などの解析アプリに読み込めます。地図 HTML は開くときにインターネット接続が必要です（地図は OpenStreetMap、表示用のスクリプトは unpkg.com から読み込みます）。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
