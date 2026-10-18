import React, { useEffect, useMemo, useState } from 'react';
import { Download, FolderOpen, Repeat } from 'lucide-react';
import { Session } from '../types/telemetry';
import {
  ConvertRange, selectConvertPoints, toTelemetryPoints, hasRecordedClock, convertToNmea, convertToGpx, convertToCsv, convertToHtmlMap, convertToKml, convertToTxt, convertToVbo
} from '../services/logConverter';
import { exportDtb } from '../services/dtbParser';
import { triggerFileDownload } from '../services/nmeaExporter';
import { exportDigispiceCsv, exportLapListCsv } from '../services/csvParser';
import { MOTEC_CSV_ENABLED, exportMotecCsv } from '../services/externalFormats';
import { circuitLabel, useT } from '../utils/i18n';
import { GFilterLevel } from '../services/physics';
import { TrimPreview } from './TrimPreview';

interface ConvertTabProps {
  sessions: Session[];
  // 書き出すログ (データ管理の「変換画面で開く」で選ばれる)。見つからなければ defaultSessionId のログ
  sessionId: string;
  defaultSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  gFilterLevel: GFilterLevel;
  onOpenFile: () => void;
  onDropFiles: (files: FileList) => void;
}

type RangeKind = 'all' | 'lap' | 'time';

const fmtTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 23);

// 走行ログを他の形式 (NMEA / GPX / CSV / DTB / 地図 HTML) に書き出すページ
const G_LEVEL_LABEL: Record<GFilterLevel, [string, string]> = { weak: ['弱', 'light'], standard: ['標準', 'standard'], strong: ['強', 'strong'] };

export const ConvertTab: React.FC<ConvertTabProps> = ({ sessions, sessionId, defaultSessionId, onSelectSession, gFilterLevel, onOpenFile, onDropFiles }) => {
  const t = useT();
  const [rangeKind, setRangeKind] = useState<RangeKind>('all');
  const [lapNumber, setLapNumber] = useState<number>(1);
  const [startSec, setStartSec] = useState<string>('0');
  const [endSec, setEndSec] = useState<string>('0');
  const [offsetHours, setOffsetHours] = useState<number>(0);
  const [talkerId, setTalkerId] = useState<'GP' | 'GN'>('GP');
  const [includeGga, setIncludeGga] = useState(true);
  const [dragOver, setDragOver] = useState(false);

  // 選ばれたログが無ければ (最初や、削除されたとき) 基準車のログ、それも無ければ最後に読み込んだもの
  const session = sessions.find(s => s.id === sessionId)
    ?? sessions.find(s => s.id === defaultSessionId)
    ?? sessions[sessions.length - 1];

  const duration = session && session.points.length > 0
    ? session.points[session.points.length - 1].time - session.points[0].time
    : 0;

  // セッションを切り替えたら範囲の入力を初期化する
  useEffect(() => {
    if (!session) return;
    setRangeKind('all');
    setLapNumber(session.laps[session.bestLapIndex]?.lapNumber ?? session.laps[0]?.lapNumber ?? 1);
    setStartSec('0');
    setEndSec(String(duration));
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

  // 切り出しのプレビューに出す範囲 (ログの先頭からの秒)。ラップ・ログ全体を選んでいるときは、その範囲を出す
  const t0 = session?.points[0]?.time ?? 0;
  const previewRange = useMemo((): [number, number] => {
    if (rangeKind === 'time') return [range.kind === 'time' ? range.startSec - t0 : 0, range.kind === 'time' ? range.endSec - t0 : duration];
    if (rangeKind === 'lap') {
      const lap = session?.laps.find(l => l.lapNumber === lapNumber);
      if (lap) return [Math.max(0, lap.startTime - t0), Math.min(duration, lap.endTime - t0)];
    }
    return [0, duration];
  }, [rangeKind, range, lapNumber, session, t0, duration]);
  // プレビューで範囲を動かしたら、時間での指定に切り替える
  const handleTrimChange = (a: number, b: number) => {
    setRangeKind('time');
    // (丸めない。丸めると、選んだ地点や最後の点が範囲から外れるため)
    setStartSec(String(a));
    setEndSec(String(b));
  };
  const handleTrimReset = () => {
    setRangeKind('all');
    setStartSec('0');
    setEndSec(String(duration));
  };

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
      // 平均車速: 距離 ÷ 時間 (止まっていた時間も含む)
      // (時間は経過秒数から求める。記録の時刻が秒単位までのログでも 0 にならないように)
      avgSpeed: last.elapsed > first.elapsed ? last.distance / ((last.elapsed - first.elapsed) / 3600) : 0,
      startPos: `${first.latitude.toFixed(6)}, ${first.longitude.toFixed(6)}`,
      endPos: `${last.latitude.toFixed(6)}, ${last.longitude.toFixed(6)}`,
      hasSatellites: points.some(p => p.satellites != null)
    };
  }, [points]);

  const baseName = session
    ? session.sessionName.replace(/[\\/:*?"<>|]/g, '_') + (rangeKind === 'lap' ? `_L${lapNumber}` : rangeKind === 'time' ? '_trim' : '')
    : 'log';

  // 時刻の入った書き出し (位置のログ) は、ファイル名に時差を付ける (_UTC / _JST / _UTC+5 など)。
  // 記録日時のないログは仮の日時なので付けない
  const tzSuffix = session && !hasRecordedClock(session) ? ''
    : offsetHours === 9 ? '_JST' : offsetHours === 0 ? '_UTC' : `_UTC${offsetHours > 0 ? '+' : ''}${offsetHours}`;
  const save = (ext: string, content: string, mime: string) => triggerFileDownload(`${baseName}${tzSuffix}.${ext}`, content, mime);

  const saveDtb = () => {
    if (!session || points.length === 0) return;
    // DTB は書き出す端末の時刻で記録する形式なので、時刻の調整は使わない (調整すると二重にずれる)
    const unshift = (d: Date) => new Date(d.getTime() - offsetHours * 3600000);
    const raw = points.map(p => ({ ...p, time: unshift(p.time) }));
    const bytes = exportDtb(toTelemetryPoints(raw), session.samplingRate, raw[0].time);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.dtb`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 範囲に入っている周 (ラップ一覧 CSV 用)
  const lapsInRange = useMemo(() => {
    if (!session) return [];
    if (rangeKind === 'all') return session.laps;
    if (rangeKind === 'lap') return session.laps.filter(l => l.lapNumber === lapNumber);
    if (range.kind !== 'time') return [];
    return session.laps.filter(l => l.startTime >= range.startSec - 1e-6 && l.endTime <= range.endSec + 1e-6);
  }, [session, rangeKind, lapNumber, range]);

  const inputCls = 'bg-surface-0 border border-line-3 text-xs text-slate-200 rounded-lg px-3 py-2 outline-none focus:border-red-500';
  const btnCls = 'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-surface-4 hover:bg-surface-5 text-xs text-slate-200 border border-line-4 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
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
          className={`bg-surface-2 border rounded-xl p-5 flex flex-col sm:flex-row items-center gap-4 ${dragOver ? 'border-red-500' : 'border-line-2'}`}
        >
          <div className="p-2.5 rounded-lg bg-red-500/10 text-red-400"><Repeat size={20} /></div>
          <div className="flex-1 text-center sm:text-left">
            <h2 className="text-sm font-bold text-slate-100">{t('ログ変換', 'Log conversion')}</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {t('走行ログ (.bnx4 / .bon4 / .dtb / NMEA / CSV / VBO / GPX / AiM / iRacing / GoPro の動画) を読み込み、NMEA・GPX・CSV などに書き出します。 ファイルをここにドロップしても読み込めます。処理はすべてこの端末内で行われます。',
                'Load a driving log (.bnx4 / .bon4 / .dtb / NMEA / CSV / VBO / GPX / AiM / iRacing / GoPro video) and export it to NMEA, GPX, CSV and more. You can also drop files here. Everything is processed on this device.')}
            </p>
          </div>
          <button onClick={onOpenFile} data-testid="convert-open" className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-xs text-white font-bold">
            <FolderOpen size={14} />
            {t('ファイル読込', 'Open file')}
          </button>
        </div>

        {!session ? (
          <div className="bg-surface-2 border border-line-2 rounded-xl p-8 text-center text-xs text-slate-500">
            {t('まだログが読み込まれていません。', 'No log loaded yet.')}
          </div>
        ) : (
          <>
            {/* 設定 */}
            <div className="bg-surface-2 border border-line-2 rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span>{t('対象のログ', 'Log')}</span>
                  <select value={session.id} onChange={e => onSelectSession(e.target.value)} className={`${inputCls} w-full`} data-testid="convert-session">
                    {sessions.map(s => (
                      <option key={s.id} value={s.id}>{s.fileName}{s.sessionName !== s.fileName.replace(/\.[^/.]+$/, '') ? `（${s.sessionName}）` : ''}　{s.date}　{s.circuitName ? circuitLabel(s.circuitName) : t('一般コース', 'Unknown course')}　{t(`${s.laps.length} 周（${s.points.length} 点）`, `${s.laps.length} laps (${s.points.length} points)`)}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span>{t('書き出す範囲', 'Range')}</span>
                  <select value={rangeKind} onChange={e => setRangeKind(e.target.value as RangeKind)} className={`${inputCls} w-full`} data-testid="convert-range">
                    <option value="all">{t('ログ全体', 'Whole log')}</option>
                    <option value="lap">{t('ラップを 1 周', 'One lap')}</option>
                    <option value="time">{t('時間で指定', 'Time range')}</option>
                  </select>
                </label>
              </div>

              {rangeKind === 'lap' && (
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span>{t('ラップ', 'Lap')}</span>
                  <select value={lapNumber} onChange={e => setLapNumber(Number(e.target.value))} className={`${inputCls} w-full sm:w-1/2`} data-testid="convert-lap">
                    {session.laps.map(l => (
                      <option key={l.lapNumber} value={l.lapNumber}>
                        L{l.lapNumber}　{l.lapTime.toFixed(3)} {t('秒', 's')}{l.isBestLap ? t('（ベスト）', ' (best)') : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {/* 時間で指定するときの範囲は、下の切り出しのプレビューで指定する */}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span className="flex items-center justify-between gap-2">
                    <span>{t('時刻の調整（時間）', 'Time offset (hours)')}</span>
                    <span className="flex gap-1">
                      {[{ h: 0, label: 'UTC' }, { h: 9, label: 'JST (+9)' }].map(o => (
                        <button key={o.h} type="button" onClick={() => setOffsetHours(o.h)} data-testid={`convert-tz-${o.h}`}
                          className={`px-1.5 py-0.5 rounded border text-[10px] ${offsetHours === o.h ? 'bg-red-600 border-red-500 text-white' : 'border-line-3 text-slate-400 hover:text-slate-200'}`}>
                          {o.label}
                        </button>
                      ))}
                    </span>
                  </span>
                  <select value={offsetHours} onChange={e => setOffsetHours(Number(e.target.value))} className={`${inputCls} w-full`} data-testid="convert-offset">
                    {Array.from({ length: 27 }, (_, i) => i - 12).map(h => (
                      <option key={h} value={h}>{h === 0 ? t('調整しない（UTC のまま）', 'None (keep UTC)') : t(`${h > 0 ? '+' : ''}${h} 時間`, `${h > 0 ? '+' : ''}${h} h`)}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-400 space-y-1 block">
                  <span>{t('NMEA の識別子', 'NMEA talker ID')}</span>
                  <select value={talkerId} onChange={e => setTalkerId(e.target.value as 'GP' | 'GN')} className={`${inputCls} w-full`}>
                    <option value="GP">$GP（GPS）</option>
                    <option value="GN">$GN（GNSS）</option>
                  </select>
                </label>
                <label className="text-xs text-slate-300 flex items-center gap-2 sm:pt-6">
                  <input type="checkbox" checked={includeGga} onChange={e => setIncludeGga(e.target.checked)} />
                  {t('NMEA に GGA（標高・衛星数）を含める', 'Include GGA in NMEA (altitude, satellites)')}
                </label>
              </div>
            </div>

            {/* 切り出し (範囲のプレビューと指定) */}
            <TrimPreview
              session={session}
              startSec={previewRange[0]}
              endSec={previewRange[1]}
              onChange={handleTrimChange}
              onReset={handleTrimReset}
              offsetHours={offsetHours}
            />

            {/* 概要 */}
            <div className="bg-surface-2 border border-line-2 rounded-xl p-4 text-xs text-slate-300 font-mono" data-testid="convert-summary">
              {summary ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                  <span>{t('点数', 'Points')}: {points.length}</span>
                  <span>{t('長さ', 'Length')}: {summary.seconds.toFixed(1)} {t('秒', 's')} / {summary.distance.toFixed(2)} km</span>
                  <span>{t('開始', 'Start')}: {summary.start}</span>
                  <span>{t('終了', 'End')}: {summary.end}</span>
                  <span>{t('最高速度', 'Top speed')}: {summary.maxSpeed.toFixed(1)} km/h / {t('平均', 'avg')}: {summary.avgSpeed.toFixed(1)} km/h</span>
                  <span>{t('衛星数の記録', 'Satellite count')}: {summary.hasSatellites ? t('あり', 'recorded') : t('なし（NMEA では空欄）', 'not recorded (blank in NMEA)')}</span>
                  <span>{t('開始位置', 'Start position')}: {summary.startPos}</span>
                  <span>{t('終了位置', 'End position')}: {summary.endPos}</span>
                </div>
              ) : (
                <span className="text-amber-400">{t('この範囲に書き出せる点がありません。', 'There are no points to export in this range.')}</span>
              )}
              {summary && !hasRecordedClock(session) && (
                <p className="text-amber-400 mt-2 font-sans" data-testid="convert-noclock">
                  {t('このログには記録日時がありません。読み込んだ日の 0 時（UTC）を先頭とした仮の日時で書き出します。', 'This log has no recorded date and time. It will be exported with placeholder times starting at 00:00 (UTC) on the day it was loaded.')}
                </p>
              )}
            </div>

            {/* 書き出し */}
            <div className="bg-surface-2 border border-line-2 rounded-xl p-4 space-y-4">
              <div>
                <h3 className="text-xs font-bold text-slate-300 mb-2">{t('位置のログ', 'Position logs')}</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <button disabled={disabled} className={btnCls} data-testid="convert-nmea"
                    onClick={() => save('nmea', convertToNmea(points, talkerId, includeGga), 'text/plain')}>
                    <Download size={13} /> NMEA
                  </button>
                  <button disabled={disabled} className={btnCls} data-testid="convert-gpx"
                    onClick={() => save('gpx', convertToGpx(points, baseName, offsetHours), 'application/gpx+xml')}>
                    <Download size={13} /> GPX
                  </button>
                  <button disabled={disabled} className={btnCls} data-testid="convert-csv"
                    onClick={() => save('csv', convertToCsv(points, offsetHours), 'text/csv')}>
                    <Download size={13} /> CSV
                  </button>
                  <button disabled={disabled} className={btnCls} data-testid="convert-vbo"
                    onClick={() => save('vbo', convertToVbo(points), 'text/plain')}
                    title={t('Racelogic の VBO 形式（Circuit Tools・RaceChrono などで読めます）', 'Racelogic VBO (opens in Circuit Tools, RaceChrono and others)')}>
                    <Download size={13} /> VBO
                  </button>
                  <button disabled={disabled} className={btnCls} data-testid="convert-txt"
                    onClick={() => save('txt', convertToTxt(points), 'text/plain')}
                    title={t('時刻・緯度・経度・車速・方位の空白区切りのテキスト（ds4_convert の RAW GPS TXT と同じ形）', 'Space-separated text of time, latitude, longitude, speed and heading (same as RAW GPS TXT in ds4_convert)')}>
                    <Download size={13} /> TXT
                  </button>
                  <button disabled={disabled} className={btnCls} data-testid="convert-kml"
                    onClick={() => save('kml', convertToKml(points, baseName, offsetHours), 'application/vnd.google-earth.kml+xml')}
                    title={t('Google Earth で開ける KML（線の色は車速）', 'KML for Google Earth (line coloured by speed)')}>
                    <Download size={13} /> KML
                  </button>
                  <button disabled={disabled} className={btnCls} data-testid="convert-html"
                    onClick={() => save('html', convertToHtmlMap(points, baseName), 'text/html')}>
                    <Download size={13} /> {t('地図 HTML', 'Map HTML')}
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 mt-2">
                  {t('NMEA / GPX は RaceChrono などの解析アプリに読み込めます。CSV は位置・速度・方位・衛星数の表、TXT は同じ内容の空白区切りです。ファイル名の末尾は時刻の調整（_UTC / _JST など）です。記録されていない項目（標高・衛星数）は空欄にします。 KML は Google Earth で開けます（線の色は車速）。地図 HTML は開くときにインターネット接続が必要です（地図は OpenStreetMap、表示用のスクリプトは unpkg.com から読み込みます）。',
                    'NMEA / GPX can be loaded into analysis apps such as RaceChrono. CSV is a table of position, speed, heading and satellites; TXT is the same, space-separated. The end of the file name shows the time offset (_UTC / _JST etc.). Fields that were not recorded (altitude, satellites) are left blank. KML opens in Google Earth (line coloured by speed). Map HTML needs an internet connection when opened (maps from OpenStreetMap, display script from unpkg.com).')}
                </p>
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-300 mb-2">{t('解析データ（G などの計算値を含む）', 'Analysis data (includes calculated values such as G)')}</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <button disabled={disabled} className={btnCls} data-testid="convert-dscsv"
                    onClick={() => triggerFileDownload(`${baseName}_telemetry.csv`, exportDigispiceCsv(toTelemetryPoints(points)), 'text/csv;charset=utf-8')}
                    title={t('デジスパイス公式ソフトと同じ列の CSV（旋回半径・G 付き）', 'CSV with the same columns as the official DigSpice software (with turning radius and G)')}>
                    <Download size={13} /> {t('走行データCSV', 'Telemetry CSV')}
                  </button>
                  <button disabled={lapsInRange.length === 0} className={btnCls} data-testid="convert-lapcsv"
                    onClick={() => triggerFileDownload(`${baseName}_lap_list.csv`, exportLapListCsv(lapsInRange), 'text/csv;charset=utf-8')}
                    title={t('範囲に入っている周のラップタイム一覧', 'Lap times of the laps within the range')}>
                    <Download size={13} /> {t('ラップ一覧CSV', 'Lap list CSV')}
                  </button>
                  <button disabled={disabled} className={btnCls} data-testid="convert-dtb" onClick={saveDtb}
                    title={t('デジスパイスの .dtb 形式', 'DigSpice .dtb format')}>
                    <Download size={13} /> DTB
                  </button>
                  {MOTEC_CSV_ENABLED && (
                    <button disabled={disabled} className={btnCls} data-testid="convert-motec" onClick={() => triggerFileDownload(`${session.sessionName.replace(/[\\/:*?"<>|]/g, '_')}_motec.csv`, exportMotecCsv(session), 'text/csv;charset=utf-8')}
                      title={t('MoTeC CSV 形式 (i2 の CSV エクスポートと同じ書式)。範囲によらずログ全体', 'MoTeC CSV (same layout as the i2 CSV export). Always the whole log, regardless of the range')}>
                      <Download size={13} /> MoTeC CSV
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 mt-2" data-testid="convert-gnote">
                  {t(`G・旋回半径は、いまの「G のならし方」（${G_LEVEL_LABEL[gFilterLevel][0]}）で計算した値です。ならし方はデータ管理で変えられます。 ラップ一覧は、書き出す範囲に収まる周だけを出します（${lapsInRange.length} 周）。`,
                    `G and turning radius are calculated with the current G smoothing (${G_LEVEL_LABEL[gFilterLevel][1]}); change it on the data tab. The lap list only includes laps that fit within the range (${lapsInRange.length} laps).`)}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
