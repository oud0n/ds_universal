import React, { useState, useEffect, useRef } from 'react';
import { 
  Usb, WifiOff, RefreshCw, Trash2, Download, Save, 
  PlayCircle, AlertTriangle, CheckCircle, Terminal, 
  Settings, Cpu, HardDrive, ShieldCheck
} from 'lucide-react';
import { DigSpiceDevice, LogInfo, DownloadProgress } from '../services/digspiceDevice';

interface LoggerTabProps {
  onLoadSession?: (fileName: string, buffer: ArrayBuffer) => void;
  onNavigateToGraph?: () => void;
}

export const LoggerTab: React.FC<LoggerTabProps> = ({ onLoadSession, onNavigateToGraph }) => {
  const [device] = useState<DigSpiceDevice>(() => new DigSpiceDevice());
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [logInfo, setLogInfo] = useState<LogInfo | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadedData, setDownloadedData] = useState<{ buffer: Uint8Array; fileName: string } | null>(null);
  const [logs, setLogs] = useState<Array<{ type: 'tx' | 'rx' | 'sys' | 'err'; msg: string; time: string }>>([]);

  // 設定用ステート
  const [samplingRate, setSamplingRate] = useState<string>('20');
  const [speedUnit, setSpeedUnit] = useState<string>('kmh');
  const [filterStrength, setFilterStrength] = useState<string>('medium');

  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    device.onLogMessage = (type, msg) => {
      const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
      setLogs(prev => [...prev.slice(-150), { type, msg, time }]);
    };

    return () => {
      if (device.isConnected()) {
        device.disconnect().catch(console.warn);
      }
    };
  }, [device]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // 接続
  const handleConnect = async () => {
    try {
      setIsBusy(true);
      await device.connect();
      setIsConnected(true);
      // 自動でメモリ情報取得
      try {
        const info = await device.getLogInfo();
        setLogInfo(info);
      } catch (e) {
        console.warn('メモリ情報自動取得スキップ:', e);
      }
    } catch (err: any) {
      alert(`デジスパイスIV 接続エラー:\n${err.message}`);
      setIsConnected(false);
    } finally {
      setIsBusy(false);
    }
  };

  // 切断
  const handleDisconnect = async () => {
    try {
      await device.disconnect();
      setIsConnected(false);
      setLogInfo(null);
    } catch (e) {
      console.warn(e);
    }
  };

  // メモリ情報更新
  const handleRefreshInfo = async () => {
    if (!isConnected || isBusy) return;
    try {
      setIsBusy(true);
      const info = await device.getLogInfo();
      setLogInfo(info);
    } catch (err: any) {
      alert(`情報取得エラー: ${err.message}`);
    } finally {
      setIsBusy(false);
    }
  };

  // ログ消去
  const handleErase = async () => {
    if (!isConnected || isBusy) return;
    const ok = window.confirm(
      '⚠️ 【警告】デジスパイスIV 本体の全走行ログを消去します。\n消去したデータは復元できません。\n本当に消去しますか？'
    );
    if (!ok) return;

    try {
      setIsBusy(true);
      await device.eraseLogs();
      alert('ロガーの全ログ消去が完了しました。');
      await handleRefreshInfo();
    } catch (err: any) {
      alert(`消去エラー: ${err.message}`);
    } finally {
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
        statusText: 'ダウンロード準備中...'
      });
      setDownloadedData(null);

      const result = await device.downloadLogs(p => setProgress(p));
      setDownloadedData(result);
      setProgress(null);
    } catch (err: any) {
      alert(`ダウンロードエラー:\n${err.message}`);
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
        dataArray: Array.from(downloadedData.buffer)
      });
      if (res.success) {
        alert(`ファイルを保存しました:\n${res.filePath}`);
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

  // ダウンロードしたデータを解析画面で開く
  const handleOpenInAnalyser = () => {
    if (!downloadedData || !onLoadSession) return;
    onLoadSession(downloadedData.fileName, downloadedData.buffer.buffer as ArrayBuffer);
    if (onNavigateToGraph) {
      onNavigateToGraph();
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#10131a] text-slate-200 overflow-y-auto p-6 space-y-6 max-w-5xl mx-auto select-none">
      {/* 上部ステータスバー */}
      <div className="bg-gradient-to-r from-[#18202d] via-[#1c2436] to-[#181c26] border border-[#2d364c] rounded-2xl p-5 shadow-xl flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className={`p-3.5 rounded-xl ${isConnected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700/30 text-slate-400'}`}>
            <Usb size={32} />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-bold text-slate-100">DigSpice IV コントロール</h2>
              <span className={`text-[11px] font-mono px-2.5 py-0.5 rounded-full border ${
                isConnected 
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' 
                  : 'bg-slate-700/40 text-slate-400 border-slate-600'
              }`}>
                {isConnected ? '接続中 (CONNECTED)' : '未接続 (OFFLINE)'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              デジスパイスIV（VID: 0x2DCF / PID: 0x6002）USBシリアル直接通信 & 公式完全準拠ダウンロード
            </p>
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
              デジスパイスIV に接続
            </button>
          ) : (
            <button
              onClick={handleDisconnect}
              disabled={isBusy}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold transition-all cursor-pointer"
            >
              <WifiOff size={15} />
              切断
            </button>
          )}
        </div>
      </div>

      {/* メイングリッド (ロガー操作 & メモリ情報) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* メモリ情報カード */}
        <div className="bg-[#181c26] border border-[#272f42] rounded-2xl p-5 shadow-lg space-y-4">
          <div className="flex items-center justify-between border-b border-[#272f42] pb-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
              <HardDrive size={16} className="text-red-500" />
              内部フラッシュメモリ
            </h3>
            {isConnected && (
              <button
                onClick={handleRefreshInfo}
                disabled={isBusy}
                className="text-slate-400 hover:text-slate-200 text-[11px] flex items-center gap-1 transition-colors cursor-pointer"
              >
                <RefreshCw size={12} className={isBusy ? 'animate-spin' : ''} />
                更新
              </button>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-slate-400">記録ログ容量</span>
                <span className="font-mono font-bold text-slate-200">
                  {logInfo ? `${Math.round(logInfo.usedBytes / 1024)} KB` : isConnected ? '確認中...' : '---'}
                </span>
              </div>
              <div className="w-full bg-[#10131a] rounded-full h-2 overflow-hidden">
                <div
                  className="bg-red-500 h-full rounded-full transition-all duration-500"
                  style={{
                    width: logInfo ? `${Math.min(100, Math.round((logInfo.usedBytes / 0x400000) * 100))}%` : '0%'
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 text-[11px] font-mono">
              <div className="bg-[#10131a] p-2.5 rounded-lg border border-[#22293a]">
                <span className="text-slate-500 block text-[10px]">書き込みポインタ</span>
                <span className="text-slate-300 font-semibold">{logInfo?.writePointerHex ? `0x${logInfo.writePointerHex}` : '---'}</span>
              </div>
              <div className="bg-[#10131a] p-2.5 rounded-lg border border-[#22293a]">
                <span className="text-slate-500 block text-[10px]">ステータス</span>
                <span className="text-emerald-400 font-semibold">{logInfo?.status || (isConnected ? '正常' : '未接続')}</span>
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
                本体ログの全消去
              </button>
            </div>
          )}
        </div>

        {/* ダウンロード操作カード */}
        <div className="md:col-span-2 bg-[#181c26] border border-[#272f42] rounded-2xl p-5 shadow-lg space-y-4 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="border-b border-[#272f42] pb-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                <Download size={16} className="text-red-500" />
                走行ログ ダウンロード
              </h3>
            </div>

            {/* ダウンロード進行状況 */}
            {progress && (
              <div className="bg-[#10131a] border border-[#272f42] rounded-xl p-4 space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-300 font-semibold flex items-center gap-2">
                    <RefreshCw size={13} className="animate-spin text-red-500" />
                    {progress.statusText}
                  </span>
                  <span className="font-mono text-red-400 font-bold">{progress.percent}%</span>
                </div>
                <div className="w-full bg-[#181c26] rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-red-600 to-amber-500 h-full rounded-full transition-all duration-150"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] font-mono text-slate-400">
                  <span>ブロック: {progress.receivedBlocks} / {progress.totalBlocks}</span>
                  <span>{Math.round(progress.receivedBytes / 1024)} KB 受信済</span>
                </div>
              </div>
            )}

            {/* ダウンロード完了時アクション */}
            {downloadedData && !progress && (
              <div className="bg-emerald-950/20 border border-emerald-500/40 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2.5 text-emerald-400 text-xs font-bold">
                  <CheckCircle size={18} />
                  ダウンロード完了！ ({downloadedData.buffer.length.toLocaleString()} バイト - 公式メタデータ付加済)
                </div>
                <div className="text-[11px] text-slate-300 font-mono">
                  ファイル名: <span className="text-amber-400">{downloadedData.fileName}</span>
                </div>

                <div className="flex flex-wrap gap-2.5 pt-1">
                  <button
                    onClick={handleOpenInAnalyser}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition-all shadow-md cursor-pointer"
                  >
                    <PlayCircle size={16} />
                    このデータを即座に解析する (グラフへ移動)
                  </button>
                  <button
                    onClick={handleSaveFile}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#1e2738] hover:bg-[#273248] text-slate-200 text-xs font-semibold border border-[#374561] transition-all cursor-pointer"
                  >
                    <Save size={15} />
                    .bnx4 ファイルを保存
                  </button>
                </div>
              </div>
            )}

            {!progress && !downloadedData && (
              <p className="text-xs text-slate-400 leading-relaxed">
                デジスパイスIV 本体の走行ログデータを高速ストリーミングで吸い出します。
                ダウンロード完了後、自動的に公式完全一致のメタデータ（0x0100..0x0109）が付加され、そのままワンクリックで解析画面へ読み込むことができます。
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
              ダウンロード実行 (Download)
            </button>
          </div>
        </div>
      </div>

      {/* 通信ログコンソール */}
      <div className="bg-[#121620] border border-[#22293a] rounded-2xl p-4 shadow-lg space-y-2">
        <div className="flex items-center justify-between border-b border-[#22293a] pb-2">
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Terminal size={14} className="text-amber-500" />
            NMEA / Serial 通信コンソール
          </span>
          <button
            onClick={() => setLogs([])}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
          >
            ログ消去
          </button>
        </div>

        <div className="h-44 bg-[#0a0d14] rounded-lg p-3 font-mono text-[11px] overflow-y-auto space-y-1 select-text">
          {logs.length === 0 ? (
            <div className="text-slate-600 italic">通信ログはまだありません</div>
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
      </div>

      {/* 設定カード */}
      <div className="bg-[#181c26] border border-[#272f42] rounded-2xl p-5 shadow-lg space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 border-b border-[#272f42] pb-3">
          <Settings size={16} className="text-red-500" />
          解析 & 単位設定
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-slate-300">更新レート / サンプリング</label>
            <select
              value={samplingRate}
              onChange={e => setSamplingRate(e.target.value)}
              className="w-full bg-[#10131a] border border-[#2d364c] text-xs text-slate-200 rounded-lg p-2 outline-none focus:border-red-500 transition-colors"
            >
              <option value="20">20 Hz (0.05秒間隔 - デジスパイスIV 高密度)</option>
              <option value="10">10 Hz (0.1秒間隔 - デジスパイス標準)</option>
              <option value="5">5 Hz (0.2秒間隔)</option>
              <option value="1">1 Hz (1.0秒間隔)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-slate-300">速度単位</label>
            <select
              value={speedUnit}
              onChange={e => setSpeedUnit(e.target.value)}
              className="w-full bg-[#10131a] border border-[#2d364c] text-xs text-slate-200 rounded-lg p-2 outline-none focus:border-red-500 transition-colors"
            >
              <option value="kmh">km/h (キロメートル/時)</option>
              <option value="mph">mph (マイル/時)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-slate-300">Gフォース微小微分フィルタ</label>
            <select
              value={filterStrength}
              onChange={e => setFilterStrength(e.target.value)}
              className="w-full bg-[#10131a] border border-[#2d364c] text-xs text-slate-200 rounded-lg p-2 outline-none focus:border-red-500 transition-colors"
            >
              <option value="low">弱 (ダイレクト・反応重視)</option>
              <option value="medium">標準 (推奨 - バランス型)</option>
              <option value="high">強 (スパイク完全抑制)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
};
