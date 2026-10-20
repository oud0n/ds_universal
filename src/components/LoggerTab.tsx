import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { 
  Usb, WifiOff, RefreshCw, Trash2, Download, Save, 
  PlayCircle, AlertTriangle, CheckCircle, Terminal, 
  Settings, Cpu, HardDrive, ShieldCheck, ChevronRight, ChevronDown
} from 'lucide-react';
import { DigSpiceDevice, LogInfo, DownloadProgress, DeviceConfig } from '../services/digspiceDevice';
import { LoggerSettingsCard } from './LoggerSettingsCard';
import { BleLoggerCard } from './BleLoggerCard';
import { canUseLoggerBle, canUseLoggerUsb } from '../utils/device';
import { tr, useT } from '../utils/i18n';
import { desktopDownloadUrl, isBrowserVersionOnPc } from '../utils/desktopApp';
import { openExternalUrl } from '../utils/url';

// 開発サーバーで `?sim=1` を付けると、実機の代わりにシミュレーターへ接続する
function isSimulatorRequested(): boolean {
  return new URLSearchParams(window.location.search).has('sim');
}

interface LoggerTabProps {
  onLoadSession?: (fileName: string, buffer: ArrayBuffer) => void;
  onNavigateToGraph?: () => void;
  /** このタブを開いているか (開いたときに、登録してあるデジスパイスへ Bluetooth でつなぐ) */
  active?: boolean;
  onOpenLapTimer?: () => void;
}

export const LoggerTab: React.FC<LoggerTabProps> = ({ onLoadSession, onNavigateToGraph, active = true, onOpenLapTimer }) => {
  const t = useT();
  const [device] = useState<DigSpiceDevice>(() => new DigSpiceDevice());
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  // ログを消している間 (始めた時刻)。画面全体に「操作しないで」を出し、閉じるのを止める
  const [erasingSince, setErasingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [logInfo, setLogInfo] = useState<LogInfo | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadedData, setDownloadedData] = useState<{ buffer: Uint8Array; fileName: string } | null>(null);
  const [logs, setLogs] = useState<Array<{ type: 'tx' | 'rx' | 'sys' | 'err'; msg: string; time: string }>>([]);
  // 通信コンソールを開いているか (ふだんはたたんでおく)
  const [consoleOpen, setConsoleOpen] = useState(false);
  // 開発版だけ: 通信コンソールから命令を 1 行送る (本体の動きを調べるため)
  const [rawCommand, setRawCommand] = useState('');

  const [config, setConfig] = useState<DeviceConfig | null>(null);
  const busyRef = useRef<boolean>(false);

  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    device.onLogMessage = (type, msg) => {
      const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
      setLogs(prev => [...prev.slice(-150), { type, msg, time }]);
    };

    device.onConnectionLost = () => {
      setIsConnected(false);
      setLogInfo(null);
      setConfig(null);
    };

    return () => {
      if (device.isConnected()) {
        device.disconnect().catch(console.warn);
      }
    };
  }, [device]);

  // 本体設定カード / モニター用の排他実行 (二重クリック防止)
  const runBusy = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setIsBusy(false);
    }
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // 接続
  const handleConnect = async () => {
    try {
      setIsBusy(true);
      if (import.meta.env.DEV && isSimulatorRequested()) {
        const { createSimulatedPort } = await import('../services/digspiceSimulator');
        await device.connect(async () => createSimulatedPort());
      } else {
        await device.connect();
      }
      setIsConnected(true);
      // 自動でメモリ情報・本体設定を取得
      try {
        const info = await device.getLogInfo();
        setLogInfo(info);
        setConfig(await device.getDeviceConfig());
      } catch (e) {
        console.warn('メモリ情報・本体設定の自動取得スキップ:', e);
      }
    } catch (err: any) {
      alert(`${tr('デジスパイスIV 接続エラー', 'DigSpice IV connection error')}:\n${err.message}`);
      setIsConnected(false);
    } finally {
      setIsBusy(false);
    }
  };

  // 切断
  const handleDisconnect = () => runBusy(async () => {
    try {
      await device.disconnect();
      setIsConnected(false);
      setLogInfo(null);
      setConfig(null);
    } catch (e) {
      console.warn(e);
    }
  });

  // メモリ情報更新
  const handleRefreshInfo = async () => {
    if (!isConnected || isBusy) return;
    try {
      setIsBusy(true);
      const info = await device.getLogInfo();
      setLogInfo(info);
    } catch (err: any) {
      alert(`${tr('情報取得エラー', 'Could not read logger information')}: ${err.message}`);
    } finally {
      setIsBusy(false);
    }
  };

  // ログ消去
  // 消している間は、ウインドウを閉じる・読み直すのを止める (途中で切ると本体の記録が中途半端になるおそれがある)。
  // 経過の秒を出すため 1 秒ごとに時刻を進める
  useEffect(() => {
    if (erasingSince === null) return;
    const block = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', block);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('beforeunload', block); clearInterval(timer); };
  }, [erasingSince]);

  const handleErase = async () => {
    if (!isConnected || isBusy) return;
    const ok = window.confirm(
      tr('⚠️ 【警告】デジスパイスIV 本体の全走行ログを消去します。\n消去したデータは復元できません。\n\n消去には 1〜2 分かかります。その間は、画面を閉じたり、USB を抜いたり、ほかの操作をしたりしないでください。\n\n本当に消去しますか？', '⚠️ WARNING: this erases every driving log on the DigSpice IV.\nErased data cannot be recovered.\n\nErasing takes 1-2 minutes. Do not close this window, unplug the USB cable or do anything else until it finishes.\n\nErase anyway?')
    );
    if (!ok) return;

    try {
      setIsBusy(true);
      setNow(Date.now());
      setErasingSince(Date.now());
      await device.eraseLogs();
      setErasingSince(null);
      alert(tr('ロガーの全ログ消去が完了しました。', 'All logs on the logger have been erased.'));
      // 消去後の容量と本体設定を読み直す (書き込み位置が先頭に戻る)
      setLogInfo(await device.getLogInfo());
      setConfig(await device.getDeviceConfig());
    } catch (err: any) {
      setErasingSince(null);
      alert(`${tr('消去エラー', 'Erase error')}: ${err.message}`);
    } finally {
      setErasingSince(null);
      setIsBusy(false);
    }
  };

  // ダウンロード実行
  const handleDownload = async () => {
    if (!isConnected || isBusy) return;
    try {
      setIsBusy(true);
      setProgress({
        receivedBytes: 0,
        totalBytes: 1,
        percent: 0,
        receivedBlocks: 0,
        totalBlocks: 0,
        statusText: tr('ダウンロード準備中...', 'Preparing download...')
      });
      setDownloadedData(null);

      const result = await device.downloadLogs(p => setProgress(p));
      setDownloadedData(result);
      setProgress(null);
    } catch (err: any) {
      alert(`${tr('ダウンロードエラー', 'Download error')}:\n${err.message}`);
      setProgress(null);
    } finally {
      setIsBusy(false);
    }
  };

  // ファイル保存
  const handleSaveFile = async () => {
    if (!downloadedData) return;
    const nav = window as any;

    // Electron IPC による保存
    if (nav.electronAPI && nav.electronAPI.saveBinaryFile) {
      const res = await nav.electronAPI.saveBinaryFile({
        defaultName: downloadedData.fileName,
        dataArray: downloadedData.buffer
      });
      if (res.success) {
        alert(`${tr('ファイルを保存しました', 'File saved')}:\n${res.filePath}`);
      }
      return;
    }

    // ブラウザ標準ダウンロード
    const blob = new Blob([downloadedData.buffer as unknown as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadedData.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [isOpeningAnalyser, setIsOpeningAnalyser] = useState<boolean>(false);

  // ダウンロードしたデータを解析画面で開く
  const handleOpenInAnalyser = async () => {
    if (!downloadedData || !onLoadSession || isOpeningAnalyser) return;
    try {
      setIsOpeningAnalyser(true);
      await onLoadSession(downloadedData.fileName, downloadedData.buffer.buffer as ArrayBuffer);
      if (onNavigateToGraph) {
        onNavigateToGraph();
      }
    } catch (err: any) {
      alert(`${tr('解析画面での展開エラー', 'Could not open in the analysis screen')}: ${err?.message || err}`);
    } finally {
      setIsOpeningAnalyser(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-surface-0 text-slate-200 overflow-y-auto p-4 sm:p-6 space-y-6 max-w-5xl mx-auto select-none">
      {/* Bluetooth でのつなぎ (iPhone のアプリ・Android の Chrome など)。USB でもつなげる環境では、USB の操作の下に出す */}
      {canUseLoggerBle && !canUseLoggerUsb && <BleLoggerCard active={active} onOpenLapTimer={onOpenLapTimer} />}

      {/* ここから USB (Web Serial) でのつなぎ */}
      {canUseLoggerUsb && (<>
      {/* 上部ステータスバー */}
      <div className="bg-gradient-to-r from-surface-3 via-surface-3 to-surface-2 border border-line-3 rounded-2xl p-5 shadow-xl flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className={`p-3.5 rounded-xl ${isConnected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700/30 text-slate-400'}`}>
            <Usb size={32} />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-bold text-slate-100">{t('DigSpice IV コントロール', 'DigSpice IV control')}</h2>
              <span className={`text-[11px] font-mono px-2.5 py-0.5 rounded-full border ${
                isConnected 
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' 
                  : 'bg-slate-700/40 text-slate-400 border-slate-600'
              }`}>
                {isConnected ? t('接続中 (CONNECTED)', 'CONNECTED') : t('未接続 (OFFLINE)', 'OFFLINE')}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {t('デジスパイスIV（VID: 0x2DCF / PID: 0x6002）USBシリアル直接通信 & 公式完全準拠ダウンロード', 'DigSpice IV (VID: 0x2DCF / PID: 0x6002) direct USB serial communication and official-compatible download')}
            </p>
            {!('serial' in navigator) && !(import.meta.env.DEV && isSimulatorRequested()) && (
              <p className="text-xs text-amber-400 mt-1" data-testid="logger-unsupported">
                {t('このブラウザはロガーとの USB 通信に対応していません。パソコンの Chrome または Edge で開いてください。', 'This browser cannot talk to the logger over USB. Open this page in Chrome or Edge on a PC.')}
                {/* Safari・Firefox などのパソコンでは、デスクトップ版でもつなげる */}
                {isBrowserVersionOnPc() && (
                  <>
                    {t(' または、', ' Or use the ')}
                    <button onClick={() => openExternalUrl(desktopDownloadUrl())} className="underline hover:text-amber-300 cursor-pointer">
                      {t('デスクトップ版（Mac・Windows）', 'desktop app (Mac / Windows)')}
                    </button>
                    {t(' を使ってください。', '.')}
                  </>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {!isConnected ? (
            <button
              onClick={handleConnect}
              disabled={isBusy}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs tracking-wider transition-all shadow-lg hover:shadow-red-600/30 disabled:opacity-50 cursor-pointer"
            >
              <Usb size={16} />
              {t('デジスパイスIV に接続', 'Connect to DigSpice IV')}
            </button>
          ) : (
            <button
              onClick={handleDisconnect}
              disabled={isBusy}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold transition-all cursor-pointer"
            >
              <WifiOff size={15} />
              {t('切断', 'Disconnect')}
            </button>
          )}
        </div>
      </div>

      {/* メイングリッド (ロガー操作 & メモリ情報) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* メモリ情報カード */}
        <div className="bg-surface-2 border border-line-2 rounded-2xl p-5 shadow-lg space-y-4">
          <div className="flex items-center justify-between border-b border-line-2 pb-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
              <HardDrive size={16} className="text-red-500" />
              {t('内部フラッシュメモリ', 'Internal flash memory')}
            </h3>
            {isConnected && (
              <button
                onClick={handleRefreshInfo}
                disabled={isBusy}
                className="text-slate-400 hover:text-slate-200 text-[11px] flex items-center gap-1 transition-colors cursor-pointer"
              >
                <RefreshCw size={12} className={isBusy ? 'animate-spin' : ''} />
                {t('更新', 'Refresh')}
              </button>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-slate-400">{t('記録ログ容量', 'Logged data')}</span>
                <span className="font-mono font-bold text-slate-200">
                  {logInfo ? `${Math.round(logInfo.usedBytes / 1024)} KB` : isConnected ? t('確認中...', 'Checking...') : '---'}
                </span>
              </div>
              <div className="w-full bg-surface-0 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-red-500 h-full rounded-full transition-all duration-500"
                  style={{
                    width: logInfo ? `${Math.min(100, Math.round((logInfo.usedBytes / logInfo.logCapacityBytes) * 100))}%` : '0%'
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 text-[11px] font-mono">
              <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1">
                <span className="text-slate-500 block text-[10px]">{t('書き込みポインタ', 'Write pointer')}</span>
                <span className="text-slate-300 font-semibold">{logInfo?.writePointerHex ? `0x${logInfo.writePointerHex}` : '---'}</span>
              </div>
              <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1">
                <span className="text-slate-500 block text-[10px]">{t('ステータス', 'Status')}</span>
                <span className="text-emerald-400 font-semibold">{logInfo
                    // 状態の文言は、表示するときに今の言語で作る (取得したときの言語のまま残らないように)
                    ? (logInfo.usedBytes > 0 ? t(`記録あり (${Math.round(logInfo.usedBytes / 1024)} KB)`, `Logs present (${Math.round(logInfo.usedBytes / 1024)} KB)`) : t('ログ空', 'Empty'))
                    : (isConnected ? t('正常', 'OK') : t('未接続', 'Not connected'))}</span>
              </div>
            </div>
          </div>

          {isConnected && (
            <div className="pt-2">
              <button
                onClick={handleErase}
                disabled={isBusy}
                className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-red-500/30 bg-red-950/20 hover:bg-red-900/30 text-red-400 text-xs font-semibold transition-all cursor-pointer disabled:opacity-50"
              >
                <Trash2 size={14} />
                {t('本体ログの全消去', 'Erase all logs on the logger')}
              </button>
            </div>
          )}
        </div>

        {/* ダウンロード操作カード */}
        <div className="md:col-span-2 bg-surface-2 border border-line-2 rounded-2xl p-5 shadow-lg space-y-4 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="border-b border-line-2 pb-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                <Download size={16} className="text-red-500" />
                {t('走行ログ ダウンロード', 'Download driving logs')}
              </h3>
            </div>

            {/* ダウンロード進行状況 */}
            {progress && (
              <div className="bg-surface-0 border border-line-2 rounded-xl p-4 space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-300 font-semibold flex items-center gap-2">
                    <RefreshCw size={13} className="animate-spin text-red-500" />
                    {progress.statusText}
                  </span>
                  <span className="font-mono text-red-400 font-bold">{progress.percent}%</span>
                </div>
                <div className="w-full bg-surface-2 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-red-600 to-amber-500 h-full rounded-full transition-all duration-150"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] font-mono text-slate-400">
                  <span>{t('ブロック', 'Blocks')}: {progress.receivedBlocks} / {progress.totalBlocks}</span>
                  <span>{Math.round(progress.receivedBytes / 1024)} KB {t('受信済', 'received')}</span>
                </div>
              </div>
            )}

            {/* ダウンロード完了時アクション */}
            {downloadedData && !progress && (
              <div className="bg-emerald-950/20 border border-emerald-500/40 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2.5 text-emerald-400 text-xs font-bold">
                  <CheckCircle size={18} />
                  {t(`ダウンロード完了！ (${downloadedData.buffer.length.toLocaleString()} バイト - 公式メタデータ付加済)`, `Download complete! (${downloadedData.buffer.length.toLocaleString()} bytes, official metadata added)`)}
                </div>
                <div className="text-[11px] text-slate-300 font-mono">
                  {t('ファイル名', 'File name')}: <span className="text-amber-400">{downloadedData.fileName}</span>
                </div>

                <div className="flex flex-wrap gap-2.5 pt-1">
                  <button
                    onClick={handleOpenInAnalyser}
                    disabled={isOpeningAnalyser}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition-all shadow-md cursor-pointer disabled:opacity-50"
                  >
                    {isOpeningAnalyser ? (
                      <>
                        <RefreshCw size={16} className="animate-spin" />
                        {t('解析データ展開中...', 'Opening...')}
                      </>
                    ) : (
                      <>
                        <PlayCircle size={16} />
                        {t('このデータを即座に解析する (グラフへ移動)', 'Analyse this data now (go to graph)')}
                      </>
                    )}
                  </button>
                  <button
                    onClick={handleSaveFile}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-4 hover:bg-surface-5 text-slate-200 text-xs font-semibold border border-line-4 transition-all cursor-pointer"
                  >
                    <Save size={15} />
                    {t('.bnx4 ファイルを保存', 'Save .bnx4 file')}
                  </button>
                </div>
              </div>
            )}

            {!progress && !downloadedData && (
              <p className="text-xs text-slate-400 leading-relaxed">
                {t('デジスパイスIV 本体の走行ログデータを高速ストリーミングで吸い出します。 ダウンロード完了後、自動的に公式完全一致のメタデータ（0x0100..0x0109）が付加され、そのままワンクリックで解析画面へ読み込むことができます。', 'Streams the driving logs off the DigSpice IV. After the download, metadata identical to the official software (0x0100..0x0109) is added automatically, and you can open the data in the analysis screen with one click.')}
              </p>
            )}
          </div>

          <div>
            <button
              onClick={handleDownload}
              disabled={!isConnected || isBusy}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold uppercase tracking-wider transition-all shadow-lg hover:shadow-red-600/30 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              <Download size={16} />
              {t('ダウンロード実行 (Download)', 'Download')}
            </button>
          </div>
        </div>
      </div>

      {/* ロガー本体設定 */}
      <LoggerSettingsCard
        device={device}
        isConnected={isConnected}
        isBusy={isBusy}
        config={config}
        runBusy={runBusy}
        onConfigChange={setConfig}
      />

      {/* 通信ログコンソール (不具合を調べるとき以外は見ないので、ふだんはたたんでおく) */}
      <div className="bg-surface-1 border border-line-1 rounded-2xl p-4 shadow-lg space-y-2">
        <div className={`flex items-center justify-between ${consoleOpen ? 'border-b border-line-1 pb-2' : ''}`}>
          <button
            onClick={() => setConsoleOpen(o => !o)}
            aria-expanded={consoleOpen}
            className="text-[11px] font-bold text-slate-400 hover:text-slate-200 uppercase tracking-wider flex items-center gap-1.5 cursor-pointer"
          >
            {consoleOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Terminal size={14} className="text-amber-500" />
            {t('NMEA / Serial 通信コンソール', 'NMEA / serial console')}
            {!consoleOpen && logs.length > 0 && <span className="normal-case font-normal text-slate-500">{t(`（${logs.length} 件）`, ` (${logs.length})`)}</span>}
          </button>
          {consoleOpen && (
            <button
              onClick={() => setLogs([])}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
            >
              {t('ログ消去', 'Clear')}
            </button>
          )}
        </div>

        {consoleOpen && import.meta.env.DEV && (
          <form
            className="flex gap-2"
            onSubmit={e => {
              e.preventDefault();
              // 先頭の $ と末尾のチェックサムは付けなくてよい (sendCommand が付ける)
              const body = rawCommand.trim().replace(/^\$/, '').replace(/\*[0-9A-F]{2}$/i, '');
              if (!body || !isConnected) return;
              // ログを消す命令は送らせない (消したログは戻らない)
              if (/^PMTK184\b|^PMTK182,6\b/i.test(body)) {
                alert(t('ログを消す命令は、ここからは送れません。', 'Commands that erase logs cannot be sent from here.'));
                return;
              }
              void runBusy(async () => {
                try {
                  await device.sendCommand(body);
                } catch (err: any) {
                  alert(err.message);
                }
              });
            }}
          >
            <input
              value={rawCommand}
              onChange={e => setRawCommand(e.target.value)}
              placeholder={t('開発用: 本体に送る命令 (例: PMTK220,100)', 'Dev: command to send (e.g. PMTK220,100)')}
              className="flex-1 bg-surface-0 border border-line-2 rounded px-2 py-1 font-mono text-[11px] text-slate-200 select-text"
              spellCheck={false}
            />
            <button type="submit" disabled={!isConnected || isBusy || !rawCommand.trim()} className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-bold disabled:opacity-40 cursor-pointer">
              {t('送る', 'Send')}
            </button>
          </form>
        )}

        {consoleOpen && (
        <div className="h-44 bg-surface-0 rounded-lg p-3 font-mono text-[11px] overflow-y-auto space-y-1 select-text">
          {logs.length === 0 ? (
            <div className="text-slate-600 italic">{t('通信ログはまだありません', 'No messages yet')}</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-slate-600 shrink-0 text-[10px]">{l.time}</span>
                <span className={`shrink-0 font-bold ${
                  l.type === 'tx' ? 'text-blue-400' :
                  l.type === 'rx' ? 'text-emerald-400' :
                  l.type === 'err' ? 'text-red-400' : 'text-amber-400'
                }`}>
                  [{l.type.toUpperCase()}]
                </span>
                <span className={`break-all ${
                  l.type === 'err' ? 'text-red-300' :
                  l.type === 'sys' ? 'text-slate-300' : 'text-slate-400'
                }`}>
                  {l.msg}
                </span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
        )}
      </div>
      </>)}
      {canUseLoggerBle && canUseLoggerUsb && <BleLoggerCard active={active} onOpenLapTimer={onOpenLapTimer} />}
      {/* G のならし方の設定は、ロガーを使わなくても選べるようデータ管理タブに置く */}

      {/* ログを消している間: 画面全体を覆って、ほかの操作をできなくする */}
      {erasingSince !== null && createPortal(
        <div className="fixed inset-0 z-[200] bg-black/80 flex items-center justify-center p-6" role="alertdialog" aria-modal="true" data-testid="erase-overlay">
          <div className="max-w-md w-full bg-surface-2 border border-red-500/50 rounded-2xl p-6 shadow-2xl text-center space-y-4">
            <div className="mx-auto w-10 h-10 rounded-full border-4 border-red-500/30 border-t-red-500 animate-spin" />
            <h2 className="text-lg font-bold text-red-300">{t('本体のログを消去しています', 'Erasing the logs on the logger')}</h2>
            <p className="text-sm text-slate-200 leading-relaxed">
              {t('1〜2 分かかります。終わるまで、画面を閉じたり、USB を抜いたり、ほかの操作をしたりしないでください。', 'This takes 1-2 minutes. Until it finishes, do not close this window, unplug the USB cable or do anything else.')}
            </p>
            <p className="text-xs font-mono text-slate-400">{t(`経過 ${Math.max(0, Math.floor((now - erasingSince) / 1000))} 秒`, `${Math.max(0, Math.floor((now - erasingSince) / 1000))} s elapsed`)}</p>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
