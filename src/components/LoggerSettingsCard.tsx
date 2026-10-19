import React, { useState, useEffect } from 'react';
import { Cpu, RefreshCw, Gauge, Timer, CheckCircle, AlertTriangle } from 'lucide-react';
import {
  DigSpiceDevice, DeviceConfig, SamplingRateHz, AUTO_LOG_SPEED_MIN, AUTO_LOG_SPEED_MAX
} from '../services/digspiceDevice';
import { tr, useT } from '../utils/i18n';

interface LoggerSettingsCardProps {
  device: DigSpiceDevice;
  isConnected: boolean;
  isBusy: boolean;
  config: DeviceConfig | null;
  runBusy: (fn: () => Promise<void>) => Promise<void>;
  onConfigChange: (config: DeviceConfig | null) => void;
}

type Notice = { type: 'ok' | 'err'; text: string } | null;

const RATE_OPTIONS: Array<{ hz: SamplingRateHz; label: [string, string] }> = [
  { hz: 20, label: ['高密度 (50 ms)', 'High detail (50 ms)'] },
  { hz: 10, label: ['標準 (100 ms)', 'Standard (100 ms)'] },
  { hz: 5, label: ['長時間 (200 ms)', 'Long duration (200 ms)'] }
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
  const t = useT();
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
      setInfoNotice({ type: 'err', text: `${tr('設定取得エラー', 'Could not read settings')}: ${err.message}` });
    }
  });

  const handleSetRate = (hz: SamplingRateHz) => runBusy(async () => {
    setRateNotice(null);
    try {
      const next = await device.setSamplingRate(hz);
      onConfigChange(next);
      setRateNotice({ type: 'ok', text: tr(`本体の応答で ${next.samplingRateHz} Hz (${next.fixIntervalMs} ms) への変更を確認しました。`, `The logger confirmed the change to ${next.samplingRateHz} Hz (${next.fixIntervalMs} ms).`) });
    } catch (err: any) {
      setRateNotice({ type: 'err', text: `${tr('レート変更失敗', 'Could not change the rate')}: ${err.message}` });
      await resyncConfig();
    }
  });

  const handleSetSpeed = (kmh: number) => runBusy(async () => {
    setSpeedNotice(null);
    try {
      const confirmed = await device.setAutoLogSpeed(kmh);
      if (config) onConfigChange({ ...config, autoLogSpeedKmh: confirmed });
      else await resyncConfig();
      setSpeedNotice({ type: 'ok', text: tr(`本体の応答で ${confirmed} km/h への変更を確認しました。`, `The logger confirmed the change to ${confirmed} km/h.`) });
    } catch (err: any) {
      setSpeedNotice({ type: 'err', text: `${tr('速度設定失敗', 'Could not set the speed')}: ${err.message}` });
      await resyncConfig();
    }
  });

  const handleCustomSpeed = () => {
    const value = Number(customSpeed);
    if (customSpeed.trim() === '' || !Number.isInteger(value) || value < AUTO_LOG_SPEED_MIN || value > AUTO_LOG_SPEED_MAX) {
      setSpeedNotice({ type: 'err', text: tr(`${AUTO_LOG_SPEED_MIN}〜${AUTO_LOG_SPEED_MAX} km/h の整数を入力してください。`, `Enter a whole number from ${AUTO_LOG_SPEED_MIN} to ${AUTO_LOG_SPEED_MAX} km/h.`) });
      return;
    }
    handleSetSpeed(value);
  };

  const currentHz = config ? config.samplingRateHz : null;
  const currentSpeed = config ? config.autoLogSpeedKmh : null;

  return (
    <div className="bg-surface-2 border border-line-2 rounded-2xl p-5 shadow-lg space-y-5" data-testid="logger-settings-card">
      <div className="flex items-center justify-between border-b border-line-2 pb-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <Cpu size={16} className="text-red-500" />
          {t('ロガー本体設定', 'Logger settings')}
        </h3>
        {isConnected && (
          <button
            onClick={handleRefresh}
            disabled={disabled}
            className="text-slate-400 hover:text-slate-200 text-[11px] flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
          >
            <RefreshCw size={12} className={isBusy ? 'animate-spin' : ''} />
            {t('本体から再取得', 'Read again from logger')}
          </button>
        )}
      </div>

      {!isConnected && (
        <p className="text-xs text-slate-400 leading-relaxed">
          {t('デジスパイスIV を接続すると、サンプリングレート・ログ記録開始速度などの本体設定を確認・変更できます。', 'Connect a DigSpice IV to view and change its settings, such as the sampling rate and the logging start speed.')}
        </p>
      )}

      {isConnected && (
        <>
          {/* システム情報 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] font-mono">
            <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1">
              <span className="text-slate-500 block text-[10px]">{t('モデル', 'Model')}</span>
              <span className="text-slate-200 font-semibold" data-testid="cfg-model">{config?.model || '---'}</span>
            </div>
            <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1">
              <span className="text-slate-500 block text-[10px]">{t('ファームウェア', 'Firmware')}</span>
              <span className="text-slate-200 font-semibold" data-testid="cfg-firmware">{config?.firmwareVersion ? `v${config.firmwareVersion}` : '---'}</span>
            </div>
            <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1">
              <span className="text-slate-500 block text-[10px]">{t('内部ステータスコード', 'Internal status code')}</span>
              <span className="text-slate-200 font-semibold">{config?.statusCode ?? '---'}</span>
            </div>
            <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1">
              <span className="text-slate-500 block text-[10px]">{t('記録フォーマット / フラッシュ状態', 'Log format / flash status')}</span>
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
                  {t('サンプリングレート', 'Sampling rate')}
                </label>
                <span className="text-[11px] font-mono text-slate-400">
                  {t('現在', 'Current')}: <span className="text-slate-100 font-bold" data-testid="cfg-rate">{currentHz !== null ? `${currentHz} Hz` : '---'}</span>
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
                          : 'bg-surface-0 border-line-3 text-slate-300 hover:border-red-500 disabled:opacity-40'
                      }`}
                    >
                      {opt.hz} Hz
                      <span className={`block text-[10px] font-normal ${active ? 'text-white/80' : 'text-slate-500'}`}>{t(...opt.label)}</span>
                    </button>
                  );
                })}
              </div>
              {/* BUG-27: スイッチが BLE のときは、10 Hz・5 Hz にしても記録も BLE の送信も 20 Hz だった。LOG のときは設定どおり (2026-10-19、DS4 v1.01) */}
              <p className="text-[11px] text-amber-300 leading-relaxed" data-testid="rate-fixed-note">
                {t('本体のスイッチが BLE のときは、設定によらず 20 Hz で記録・送信します。設定の周期で記録するのは LOG のときです。', 'When the logger\'s switch is set to BLE, it records and transmits at 20 Hz regardless of this setting. The chosen rate applies in LOG mode.')}
              </p>
              <p className="text-[10px] text-slate-500 leading-relaxed" data-testid="rate-note">
                {t('公式ソフトでレートを変えたときと同じ命令を送るため、記録する項目などの本体の記録設定も標準の値に書き直されます。', 'This sends the same commands as changing the rate in the official software, so the logger\'s other recording settings (such as which items are logged) are also reset to their standard values.')}
              </p>
              <NoticeLine notice={rateNotice} />
            </div>

            {/* ログ記録開始速度 */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                  <Gauge size={13} className="text-amber-500" />
                  {t('ログ記録開始速度 (Auto Log Speed)', 'Logging start speed (Auto Log Speed)')}
                </label>
                <span className="text-[11px] font-mono text-slate-400">
                  {t('現在', 'Current')}: <span className="text-slate-100 font-bold" data-testid="cfg-speed">{currentSpeed !== null ? `${currentSpeed} km/h` : '---'}</span>
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
                          : 'bg-surface-0 border-line-3 text-slate-300 hover:border-red-500 disabled:opacity-40'
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
                    placeholder={t('任意', 'Custom')}
                    aria-label={t('ログ記録開始速度 (km/h)', 'Logging start speed (km/h)')}
                    className="w-20 bg-surface-0 border border-line-3 text-xs text-slate-200 rounded-lg p-2 outline-none focus:border-red-500 transition-colors disabled:opacity-40"
                  />
                  <button
                    onClick={handleCustomSpeed}
                    disabled={disabled}
                    className="py-2 px-3 rounded-lg bg-surface-4 hover:bg-surface-5 text-slate-200 text-xs font-semibold border border-line-4 transition-all cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {t('設定', 'Set')}
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
