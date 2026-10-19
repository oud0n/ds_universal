import React, { useCallback, useEffect, useState } from 'react';
import { Circle, Square, Download, Share2, Trash2, FileText } from 'lucide-react';
import { bleLoggerLink, loggerSerial, type LoggerLinkSnapshot } from '../services/bleLoggerLink';
import { captureBackendFor, captureName, type CaptureStatus } from '../services/bleCapture';
import { decodeCapture, decodedCaptureCsv, type CaptureSummary } from '../services/bleCaptureDecode';
import type { RecordingFile } from '../native/contract';
import { useT } from '../utils/i18n';

const btn = 'flex items-center justify-center gap-1.5 whitespace-nowrap px-3 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer disabled:opacity-50';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * BLE の通知の記録 (仕様の確かめ用)。届いた通知をそのまま書き、あとで測位にして書き出す。
 * アプリでは画面を消しても続く。ブラウザでは、このページを開いている間だけ
 */
export const BleCapturePanel: React.FC<{ snap: LoggerLinkSnapshot }> = ({ snap }) => {
  const t = useT();
  const backend = captureBackendFor(bleLoggerLink);
  const [status, setStatus] = useState<CaptureStatus>({ recording: false });
  const [files, setFiles] = useState<RecordingFile[]>([]);
  const [summary, setSummary] = useState<{ fileName: string; s: CaptureSummary } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!backend) return;
    try {
      setStatus(await backend.status());
      setFiles((await backend.list()).sort((a, b) => b.modifiedMs - a.modifiedMs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [backend]);

  // 記録中は件数を 2 秒ごとに読み直す
  useEffect(() => {
    void refresh();
    if (!status.recording) return;
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [refresh, status.recording]);

  if (!backend) return null;
  const linked = snap.status === 'waiting' || snap.status === 'fixing' || snap.status === 'reconnecting';

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  };

  const start = () => run(async () => {
    const reg = snap.registered;
    if (!reg) return;
    const header = [
      `device=${reg.name}`,
      `started=${new Date().toISOString()}`,
      `user_agent=${navigator.userAgent}`,
      ...Object.entries(snap.deviceInfo).map(([k, v]) => `info.${k}=${v}`)
    ];
    await backend.start(captureName(loggerSerial(reg.name)), reg.id, header);
  });

  const decodeAndExport = (fileName: string) => run(async () => {
    const decoded = decodeCapture(await backend.read(fileName));
    setSummary({ fileName, s: decoded.summary });
    // 記録中のファイルは、その時点までの中身になる。止めたあとのものと取り違えないよう、名前と見出しに「途中まで」と時刻を入れる
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const partial = status.recording && status.fileName === fileName;
    const name = fileName.replace(/\.csv$/, '') + (partial ? `-partial-${hhmm}` : '') + '-decoded.csv';
    const note = partial ? `# partial: recording was still running; contents up to ${now.toISOString()}\n` : '';
    await backend.exportText(name, note + decodedCaptureCsv(decoded));
  });

  const showSummary = (fileName: string) => run(async () => {
    setSummary({ fileName, s: decodeCapture(await backend.read(fileName)).summary });
  });

  return (
    <div className="space-y-3 border-t border-line-2 pt-3" data-testid="ble-capture">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-slate-300">{t('通知の記録（仕様の確かめ用）', 'Notification capture (for protocol checks)')}</div>
          <div className="text-[11px] text-slate-500">
            {backend.continuesInBackground
              ? t('画面を消しても記録を続けます。速度と高度の単位、途切れ方を確かめるのに使います。', 'Keeps recording with the screen off. Used to check speed / altitude units and dropouts.')
              : t('このページを開いている間だけ記録します（閉じると消えます）。', 'Records only while this page is open (lost when closed).')}
          </div>
        </div>
        {status.recording ? (
          <button onClick={() => run(() => backend.stop())} className={`${btn} bg-slate-700 text-slate-100`} data-testid="ble-capture-stop">
            <Square size={13} />{t('記録を止める', 'Stop')}
          </button>
        ) : (
          <button onClick={start} disabled={!linked} className={`${btn} bg-red-600 hover:bg-red-500 text-white`} data-testid="ble-capture-start">
            <Circle size={13} />{t('記録を始める', 'Record')}
          </button>
        )}
      </div>

      {status.recording && (
        <div className="text-[11px] font-mono text-red-300 flex items-center gap-2" data-testid="ble-capture-status">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          {status.fileName} — {t(`通知 ${status.notifications ?? 0} 件`, `${status.notifications ?? 0} notifications`)}
        </div>
      )}

      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map(f => (
            <li key={f.fileName} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-0 border border-line-1">
              <span className="font-mono text-[11px] text-slate-300 break-all">
                {f.fileName} <span className="text-slate-500">{formatBytes(f.bytes)}</span>
              </span>
              <span className="flex gap-1.5">
                <button onClick={() => showSummary(f.fileName)} className={`${btn} border border-line-3 text-slate-300`} title={t('まとめを見る', 'Summary')}>
                  <FileText size={13} />
                </button>
                <button onClick={() => decodeAndExport(f.fileName)} className={`${btn} border border-line-3 text-slate-300`}>
                  <Download size={13} />{t('測位の CSV', 'Fixes CSV')}
                </button>
                <button onClick={() => run(() => backend.exportRaw(f.fileName))} className={`${btn} border border-line-3 text-slate-300`}>
                  <Share2 size={13} />{t('元のまま', 'Raw')}
                </button>
                {status.fileName !== f.fileName && (
                  <button onClick={() => window.confirm(t(`${f.fileName} を消しますか？`, `Delete ${f.fileName}?`)) && run(() => backend.remove(f.fileName))} className={`${btn} border border-line-3 text-slate-400`} title={t('消す', 'Delete')}>
                    <Trash2 size={13} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {summary && (
        <div className="text-[11px] font-mono bg-surface-0 border border-line-1 rounded-lg p-3 space-y-0.5 text-slate-300" data-testid="ble-capture-summary">
          <div className="text-slate-400">{summary.fileName}</div>
          <div>{t('通知', 'Notifications')} {summary.s.notifications} / {t('測位', 'fixes')} {summary.s.fixes}（{t('測位できている', 'valid')} {summary.s.validFixes}）</div>
          <div>{t('測位の間隔', 'Interval')} {summary.s.medianIntervalSec !== null ? `${(summary.s.medianIntervalSec * 1000).toFixed(0)} ms` : '---'} / {t('途切れ', 'gaps')} {summary.s.gaps}</div>
          <div>
            {t('速度の欄 ÷ 位置から求めた速さ', 'Speed field ÷ speed from positions')}:{' '}
            {summary.s.speedRatioMedian !== null ? summary.s.speedRatioMedian.toFixed(3) : '---'}
            <span className="text-slate-500">（{t(`動いている間の ${summary.s.speedRatioSamples} 点。1 に近ければ 0.01 m/s で合っている`, `${summary.s.speedRatioSamples} moving samples; near 1 means 0.01 m/s is right`)}）</span>
          </div>
          <div>{t('高度', 'Altitude')} {summary.s.altitudeRangeM ? `${summary.s.altitudeRangeM.min.toFixed(2)}〜${summary.s.altitudeRangeM.max.toFixed(2)} m` : '---'}</div>
          {summary.s.states.length > 0 && <div className="text-slate-500">{t('つなぎの変化', 'Link changes')}: {summary.s.states.map(s => `${s.receivedSec.toFixed(0)}s ${s.state}`).join(', ')}</div>}
        </div>
      )}

      {error && <div className="text-[11px] text-amber-300">{error}</div>}
    </div>
  );
};
