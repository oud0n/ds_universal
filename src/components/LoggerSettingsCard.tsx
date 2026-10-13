import React, { useState, useEffect } from 'react';
import { Cpu, RefreshCw, Gauge, Timer, CheckCircle, AlertTriangle } from 'lucide-react';
import {
  DigSpiceDevice, DeviceConfig, SamplingRateHz, AUTO_LOG_SPEED_MIN, AUTO_LOG_SPEED_MAX
} from '../services/digspiceDevice';

interface LoggerSettingsCardProps {
  device: DigSpiceDevice;
  isConnected: boolean;
  isBusy: boolean;
  config: DeviceConfig | null;
  runBusy: (fn: () => Promise<void>) => Promise<void>;
  onConfigChange: (config: DeviceConfig | null) => void;
}

type Notice = { type: 'ok' | 'err'; text: string } | null;

const RATE_OPTIONS: Array<{ hz: SamplingRateHz; label: string }> = [
  { hz: 20, label: '高密度 (50 ms)' },
  { hz: 10, label: '標準 (100 ms)' },
  { hz: 5, label: '長時間 (200 ms)' }
];

const SPEED_PRESETS = [10, 20, 30];

const NoticeLine: React.FC<{ notice: Notice }> = ({ notice }) => {
  if (!notice) return null;
  return (
    <div
      role="status"
      className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${notice.type === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}
    >
      {notice.type === 'ok' ? <CheckCircle size={13} className="shrink-0 mt-0.5" /> : <AlertTriangle size={13} className="shrink-0 mt-0.5" />}
      <span className="break-all">{notice.text}</span>
    </div>
  );
};

export const LoggerSettingsCard: React.FC<LoggerSettingsCardProps> = ({
  device, isConnected, isBusy, config, runBusy, onConfigChange
}) => {
  const [rateNotice, setRateNotice] = useState<Notice>(null);
  const [speedNotice, setSpeedNotice] = useState<Notice>(null);
  const [infoNotice, setInfoNotice] = useState<Notice>(null);
  const [customSpeed, setCustomSpeed] = useState<string>('');

  const disabled = !isConnected || isBusy;

  useEffect(() => {
    if (!isConnected) {
      setRateNotice(null);
      setSpeedNotice(null);
      setInfoNotice(null);
      setCustomSpeed('');
    }
  }, [isConnected]);

  // 設定変更が途中で失敗すると本体の状態が分からなくなるため、本体から読み直す。
  // 読み直せなければ「不明」として表示する (古い値を現在値として見せない)
  const resyncConfig = async () => {
    try {
      onConfigChange(await device.getDeviceConfig());
    } catch {
      onConfigChange(null);
    }
  };

  const handleRefresh = () => runBusy(async () => {
    try {
      onConfigChange(await device.getDeviceConfig());
      setInfoNotice(null);
    } catch (err: any) {
      setInfoNotice({ type: 'err', text: `設定取得エラー: ${err.message}` });
    }
  });

  const handleSetRate = (hz: SamplingRateHz) => runBusy(async () => {
    setRateNotice(null);
    try {
      const next = await device.setSamplingRate(hz);
      onConfigChange(next);
      setRateNotice({ type: 'ok', text: `本体の応答で ${next.samplingRateHz} Hz (${next.fixIntervalMs} ms) への変更を確認しました。` });
    } catch (err: any) {
      setRateNotice({ type: 'err', text: `レート変更失敗: ${err.message}` });
      await resyncConfig();
    }
  });

  const handleSetSpeed = (kmh: number) => runBusy(async () => {
    setSpeedNotice(null);
    try {
      const confirmed = await device.setAutoLogSpeed(kmh);
      if (config) onConfigChange({ ...config, autoLogSpeedKmh: confirmed });
      else await resyncConfig();
      setSpeedNotice({ type: 'ok', text: `本体の応答で ${confirmed} km/h への変更を確認しました。` });
    } catch (err: any) {
      setSpeedNotice({ type: 'err', text: `速度設定失敗: ${err.message}` });
      await resyncConfig();
    }
  });

  const handleCustomSpeed = () => {
    const value = Number(customSpeed);
    if (customSpeed.trim() === '' || !Number.isInteger(value) || value < AUTO_LOG_SPEED_MIN || value > AUTO_LOG_SPEED_MAX) {
      setSpeedNotice({ type: 'err', text: `${AUTO_LOG_SPEED_MIN}〜${AUTO_LOG_SPEED_MAX} km/h の整数を入力してください。` });
      return;
    }
    handleSetSpeed(value);
  };

  const currentHz = config ? config.samplingRateHz : null;
  const currentSpeed = config ? config.autoLogSpeedKmh : null;

  return (
    <div className="bg-[#181c26] border border-[#272f42] rounded-2xl p-5 shadow-lg space-y-5" data-testid="logger-settings-card">
      <div className="flex items-center justify-between border-b border-[#272f42] pb-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <Cpu size={16} className="text-red-500" />
          ロガー本体設定
        </h3>
        {isConnected && (
          <button
            onClick={handleRefresh}
            disabled={disabled}
            className="text-slate-400 hover:text-slate-200 text-[11px] flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
          >
            <RefreshCw size={12} className={isBusy ? 'animate-spin' : ''} />
            本体から再取得
          </button>
        )}
      </div>

      {!isConnected && (
        <p className="text-xs text-slate-400 leading-relaxed">
          デジスパイスIV を接続すると、サンプリングレート・ログ記録開始速度などの本体設定を確認・変更できます。
        </p>
      )}

      {isConnected && (
        <>
          {/* システム情報 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] font-mono">
            <div className="bg-[#10131a] p-2.5 rounded-lg border border-[#22293a]">
              <span className="text-slate-500 block text-[10px]">モデル</span>
              <span className="text-slate-200 font-semibold" data-testid="cfg-model">{config?.model || '---'}</span>
            </div>
            <div className="bg-[#10131a] p-2.5 rounded-lg border border-[#22293a]">
              <span className="text-slate-500 block text-[10px]">ファームウェア</span>
              <span className="text-slate-200 font-semibold" data-testid="cfg-firmware">{config?.firmwareVersion ? `v${config.firmwareVersion}` : '---'}</span>
            </div>
            <div className="bg-[#10131a] p-2.5 rounded-lg border border-[#22293a]">
              <span className="text-slate-500 block text-[10px]">内部ステータスコード</span>
              <span className="text-slate-200 font-semibold">{config?.statusCode ?? '---'}</span>
            </div>
            <div className="bg-[#10131a] p-2.5 rounded-lg border border-[#22293a]">
              <span className="text-slate-500 block text-[10px]">記録フォーマット / フラッシュ状態</span>
              <span className="text-slate-200 font-semibold">
                {config ? `0x${config.logFormatMaskHex} / 0x${config.flashStatusHex}` : '---'}
              </span>
            </div>
          </div>
          <NoticeLine notice={infoNotice} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* サンプリングレート */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                  <Timer size={13} className="text-amber-500" />
                  サンプリングレート
                </label>
                <span className="text-[11px] font-mono text-slate-400">
                  現在: <span className="text-slate-100 font-bold" data-testid="cfg-rate">{currentHz !== null ? `${currentHz} Hz` : '---'}</span>
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {RATE_OPTIONS.map(opt => {
                  const active = currentHz === opt.hz;
                  return (
                    <button
                      key={opt.hz}
                      onClick={() => handleSetRate(opt.hz)}
                      disabled={disabled || active}
                      aria-pressed={active}
                      className={`py-2 px-2 rounded-lg border text-xs font-bold transition-all cursor-pointer disabled:pointer-events-none ${
                        active
                          ? 'bg-red-600 border-red-500 text-white'
                          : 'bg-[#10131a] border-[#2d364c] text-slate-300 hover:border-red-500 disabled:opacity-40'
                      }`}
                    >
                      {opt.hz} Hz
                      <span className={`block text-[10px] font-normal ${active ? 'text-red-100' : 'text-slate-500'}`}>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
              <NoticeLine notice={rateNotice} />
            </div>

            {/* ログ記録開始速度 */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                  <Gauge size={13} className="text-amber-500" />
                  ログ記録開始速度 (Auto Log Speed)
                </label>
                <span className="text-[11px] font-mono text-slate-400">
                  現在: <span className="text-slate-100 font-bold" data-testid="cfg-speed">{currentSpeed !== null ? `${currentSpeed} km/h` : '---'}</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {SPEED_PRESETS.map(kmh => {
                  const active = currentSpeed === kmh;
                  return (
                    <button
                      key={kmh}
                      onClick={() => handleSetSpeed(kmh)}
                      disabled={disabled || active}
                      aria-pressed={active}
                      className={`py-2 px-3 rounded-lg border text-xs font-bold transition-all cursor-pointer disabled:pointer-events-none ${
                        active
                          ? 'bg-red-600 border-red-500 text-white'
                          : 'bg-[#10131a] border-[#2d364c] text-slate-300 hover:border-red-500 disabled:opacity-40'
                      }`}
                    >
                      {kmh} km/h
                    </button>
                  );
                })}
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={AUTO_LOG_SPEED_MIN}
                    max={AUTO_LOG_SPEED_MAX}
                    step={1}
                    value={customSpeed}
                    onChange={e => setCustomSpeed(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !disabled) handleCustomSpeed(); }}
                    disabled={disabled}
                    placeholder="任意"
                    aria-label="ログ記録開始速度 (km/h)"
                    className="w-20 bg-[#10131a] border border-[#2d364c] text-xs text-slate-200 rounded-lg p-2 outline-none focus:border-red-500 transition-colors disabled:opacity-40"
                  />
                  <button
                    onClick={handleCustomSpeed}
                    disabled={disabled}
                    className="py-2 px-3 rounded-lg bg-[#1e2738] hover:bg-[#273248] text-slate-200 text-xs font-semibold border border-[#374561] transition-all cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                  >
                    設定
                  </button>
                </div>
              </div>
              <NoticeLine notice={speedNotice} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};
