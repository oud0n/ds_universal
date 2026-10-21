import React, { useEffect, useSyncExternalStore } from 'react';
import { Bluetooth, BluetoothSearching, Unlink, RefreshCw, Settings, Signal, Timer } from 'lucide-react';
import { bleLoggerLink, loggerSerial, type LoggerLinkStatus } from '../services/bleLoggerLink';
import { useT } from '../utils/i18n';
import { hasNative } from '../native/bridge';
import { usePositionSource } from '../services/positionSource';
import { loadDevices } from '../services/devices/deviceRegistry';
import { Smartphone } from 'lucide-react';
import { BleCapturePanel } from './BleCapturePanel';

export function useLoggerLink() {
  return useSyncExternalStore(bleLoggerLink.subscribe, bleLoggerLink.getSnapshot);
}

const STATUS_CLASS: Record<LoggerLinkStatus, string> = {
  unsupported: 'bg-slate-700/40 text-slate-400 border-slate-600',
  none: 'bg-slate-700/40 text-slate-400 border-slate-600',
  idle: 'bg-slate-700/40 text-slate-300 border-slate-600',
  connecting: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  reconnecting: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  waiting: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  fixing: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
};

export function useStatusLabel(): (status: LoggerLinkStatus, rateHz: number) => string {
  const t = useT();
  return (status, rateHz) => {
    switch (status) {
      case 'unsupported': return t('使えません', 'Unavailable');
      case 'none': return t('未登録', 'Not registered');
      case 'idle': return t('未接続', 'Not connected');
      case 'connecting': return t('接続中…', 'Connecting…');
      case 'reconnecting': return t('つなぎ直し中…', 'Reconnecting…');
      case 'waiting': return t('測位待ち', 'Waiting for GPS');
      case 'fixing': return t(`測位中 ${rateHz} Hz`, `GPS ${rateHz} Hz`);
    }
  };
}

/** 登録した機器の名前から、短い機種名 (DS4B… → デジスパイスIV)。何につないでいるか分かるように出す */
export function loggerModel(name: string | undefined): string {
  if (!name) return 'DigSpice';
  if (/^DS4/.test(name)) return 'DigSpice IV';
  if (/^DS3/.test(name)) return 'DigSpice III';
  return name;
}

/** 画面の上にいつも出す、デジスパイスとのつなぎの状態 (登録していないときは出さない)。機種名と、測位が届いていれば何 Hz か */
export const BleStatusPill: React.FC<{ onClick?: () => void }> = ({ onClick }) => {
  const snap = useLoggerLink();
  const label = useStatusLabel();
  const t = useT();
  // ラップタイマーで選んだ位置の出どころを出す (RaceBox・端末の GPS を選んでいれば、デジスパイスの状態は出さない)。
  // RaceBox と端末の GPS は、ラップタイマーを開いている間だけ使うので、ほかの画面では名前だけ
  const source = usePositionSource();
  if (source === 'racebox' || source === 'drogger' || source === 'phone') {
    // 上のバーは狭いので短く (スマートフォンの解析の画面で、ほかのボタンと並んでも切れないように)
    const name = source === 'phone'
      ? (hasNative() ? t('iPhone GPS', 'Phone GPS') : t('端末の GPS', 'Device GPS'))
      : (loadDevices().find(d => d.kind === source)?.displayName ?? (source === 'racebox' ? 'RaceBox' : 'Drogger'));
    return (
      <button
        type="button"
        onClick={onClick}
        data-testid="ble-status-pill"
        className="flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-full border whitespace-nowrap min-w-0 border-line-3 text-slate-300"
        title={name}
      >
        {source === 'phone' ? <Smartphone size={12} /> : <Bluetooth size={12} />}
        <span className="font-sans font-bold truncate">{name}</span>
      </button>
    );
  }
  if (snap.status === 'unsupported' || snap.status === 'none') return null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="ble-status-pill"
      className={`flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-full border whitespace-nowrap ${STATUS_CLASS[snap.status]}`}
    >
      <Bluetooth size={12} />
      <span className="font-sans font-bold">{loggerModel(snap.registered?.name)}</span>
      <span>{snap.status === 'fixing' ? `${snap.rateHz} Hz` : label(snap.status, snap.rateHz)}</span>
    </button>
  );
};

const btn = 'flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer disabled:opacity-50';

/** ロガー設定のタブの、Bluetooth でのデジスパイスとのつなぎ (探す・登録・状態・届いた測位) */
export const BleLoggerCard: React.FC<{ active?: boolean; onOpenLapTimer?: () => void }> = ({ active = true, onOpenLapTimer }) => {
  const t = useT();
  const snap = useLoggerLink();
  const label = useStatusLabel();

  // この画面を開いたときに、登録してある機器へつなぐ (アプリを開いただけではつながない)
  useEffect(() => { if (active) void bleLoggerLink.startAndConnect(); }, [active]);

  if (snap.status === 'unsupported') return null;
  const { registered, lastFix } = snap;
  const linked = snap.status === 'connecting' || snap.status === 'reconnecting' || snap.status === 'waiting' || snap.status === 'fixing';

  return (
    <div className="bg-surface-2 border border-line-2 rounded-2xl p-5 shadow-lg space-y-4" data-testid="ble-logger-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-2 pb-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <Bluetooth size={16} className="text-sky-400" />
          {t('デジスパイス (Bluetooth)', 'DigSpice (Bluetooth)')}
        </h3>
        <span className={`text-[11px] font-mono px-2.5 py-0.5 rounded-full border ${STATUS_CLASS[snap.status]}`} data-testid="ble-status">
          {label(snap.status, snap.rateHz)}
        </span>
      </div>

      {onOpenLapTimer && (
        <button
          onClick={onOpenLapTimer}
          data-testid="open-lap-timer"
          className={`${btn} w-full bg-red-600 hover:bg-red-500 text-white text-sm py-3`}
        >
          <Timer size={16} />{t('ラップタイマーを開く', 'Open lap timer')}
        </button>
      )}

      {registered && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] text-slate-500">{t('登録した機器', 'Registered device')}</div>
              <div className="font-mono text-sm text-slate-100">{registered.name}</div>
              <div className="text-[11px] text-slate-400">{t('シリアル番号', 'Serial')}: <span className="font-mono">{loggerSerial(registered.name)}</span></div>
              {Object.keys(snap.deviceInfo).length > 0 && (
                <div className="text-[10px] text-slate-500 font-mono" data-testid="ble-device-info">
                  {Object.entries(snap.deviceInfo).map(([k, v]) => `${k}: ${v}`).join(' / ')}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              {linked ? (
                <button onClick={() => bleLoggerLink.disconnectByUser()} className={`${btn} bg-slate-700 hover:bg-slate-600 text-slate-200`}>
                  <Unlink size={14} />{t('切る', 'Disconnect')}
                </button>
              ) : (
                <button onClick={() => bleLoggerLink.connect()} className={`${btn} bg-sky-600 hover:bg-sky-500 text-white`}>
                  <RefreshCw size={14} />{t('つなぐ', 'Connect')}
                </button>
              )}
              <button onClick={() => bleLoggerLink.forget()} className={`${btn} border border-line-3 text-slate-300 hover:bg-surface-4`}>
                {t('登録を外す', 'Forget')}
              </button>
            </div>
          </div>

          {linked && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono" data-testid="ble-live">
              <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1 col-span-2 sm:col-span-1">
                <span className="text-slate-500 block text-[10px]">{t('速度', 'Speed')}</span>
                <span className="text-slate-100 text-2xl font-bold">{lastFix?.valid ? lastFix.speedKmh.toFixed(1) : '---'}</span>
                <span className="text-slate-500 ml-1">km/h</span>
              </div>
              <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1">
                <span className="text-slate-500 block text-[10px]">{t('位置', 'Position')}</span>
                <span className="text-slate-300">{lastFix?.valid ? `${lastFix.latitude.toFixed(6)}` : '---'}</span><br />
                <span className="text-slate-300">{lastFix?.valid ? `${lastFix.longitude.toFixed(6)}` : ''}</span>
              </div>
              <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1">
                <span className="text-slate-500 block text-[10px]">{t('GPS の時刻', 'GPS time')}</span>
                <span className="text-slate-300">{lastFix ? lastFix.timestamp.toLocaleTimeString() : '---'}</span>
              </div>
              <div className="bg-surface-0 p-2.5 rounded-lg border border-line-1">
                <span className="text-slate-500 block text-[10px]">{t('受信', 'Receiving')}</span>
                <span className="text-slate-300 flex items-center gap-1"><Signal size={11} />{snap.rateHz} Hz</span>
                <span className="text-slate-500">{t(`途切れ ${snap.gaps.length} 回`, `${snap.gaps.length} gaps`)}</span>
              </div>
            </div>
          )}

          <BleCapturePanel snap={snap} />
        </div>
      )}

      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          {registered
            ? t('別の機器にするときは、探して選び直してください。', 'To use another device, search and choose it.')
            : t('本体のスライドスイッチを BLE にして、探してください。次からは、この画面かラップタイマーを開くと自動でつなぎます。', 'Set the slide switch on the logger to BLE, then search. Next time it connects automatically when you open this screen or the lap timer.')}
          {snap.centralKind === 'web' && ' ' + t('ブラウザの選択画面で DS4B… を選んでください。', 'Choose DS4B… in the browser\'s device chooser.')}
        </p>
        <button
          onClick={() => (snap.scanning ? bleLoggerLink.stopScan() : bleLoggerLink.startScan())}
          className={`${btn} w-full sm:w-auto ${snap.scanning ? 'bg-slate-700 text-slate-200' : 'bg-red-600 hover:bg-red-500 text-white'}`}
          data-testid="ble-scan"
        >
          <BluetoothSearching size={15} className={snap.scanning ? 'animate-pulse' : ''} />
          {snap.scanning ? t('探すのをやめる', 'Stop searching') : t('探す', 'Search')}
        </button>

        {snap.found.length > 0 && (
          <ul className="space-y-1.5" data-testid="ble-found">
            {snap.found.map(d => (
              <li key={d.id}>
                <button
                  onClick={() => bleLoggerLink.register(d)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-surface-0 border border-line-2 hover:border-sky-500/60 text-left cursor-pointer"
                >
                  <span>
                    <span className="block font-mono text-sm text-slate-100">{t('シリアル番号', 'Serial')} {loggerSerial(d.name)}</span>
                    <span className="block text-[10px] text-slate-500 font-mono">{d.name}</span>
                  </span>
                  <span className="flex items-center gap-2 text-[11px] text-slate-400">
                    {d.rssi !== undefined && <span className="font-mono">{d.rssi} dBm</span>}
                    <span className="text-sky-300 font-semibold">{t('登録してつなぐ', 'Register')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {snap.error && (
        <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-500/30 rounded-lg p-3 flex flex-wrap items-center justify-between gap-2" data-testid="ble-error">
          <span>{snap.error}</span>
          {snap.permissionDenied && snap.centralKind === 'native' && (
            <button onClick={() => bleLoggerLink.openSettings()} className={`${btn} py-1.5 bg-slate-700 text-slate-200`}>
              <Settings size={13} />{t('設定を開く', 'Open Settings')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
