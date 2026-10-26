/**
 * Bluetooth LE の機器の登録 (2026-10-20、PLAN-21・22)。ロガー設定の、デジスパイスの登録の下に出す。
 * 位置 (RaceBox)・センサー (心拍計・OBD-II)・カメラ (GoPro) のタブで分ける。
 * 機器ごとに、表示名と、記録の .csv に使うファイル名用の名前を付ける (あとから変えられる)
 */

import React, { useEffect, useRef, useState } from 'react';
import { Bluetooth, Plus, Trash2, Search, Activity } from 'lucide-react';
import { getBleCentral, type BleCentral, type BleDeviceInfo } from '../services/bleCentral';
import { shareSppLog, sppAvailable, sppCentral } from '../services/sppCentral';
import {
  DEVICE_KINDS, RENAME_NOTICE, checkDeviceFileName, devicesOfGenre, loadDevices, removeDevice, saveDevices, suggestFileName, upsertDevice,
  type DeviceGenre, type DeviceKind, type RegisteredDevice
} from '../services/devices/deviceRegistry';
import { DeviceLink, type DeviceSample } from '../services/devices/deviceLink';
import { RACEBOX_NAME_PREFIXES, RACEBOX_UART_SERVICE } from '../services/devices/raceboxProtocol';
import { DROGGER_NAME_PREFIXES, DROGGER_SERVICE } from '../services/devices/droggerProtocol';
import { HEART_RATE_SERVICE } from '../services/devices/heartRateProtocol';
import { GOPRO_NAME_PREFIXES, GOPRO_SERVICE } from '../services/devices/goproBle';
import { DIGSPICE_NAME_PREFIXES } from '../services/bleLoggerLink';
import { getLang, useT } from '../utils/i18n';

/** 探し方 (名前の頭・広告のサービス・つないだあとに使うサービス) */
const SCAN: Record<DeviceKind, { names: string[]; advertised: string[]; services: string[] }> = {
  racebox: { names: RACEBOX_NAME_PREFIXES, advertised: [], services: [RACEBOX_UART_SERVICE] },
  // Drogger は BLE のファームウェアを書き込んだもの (RWS. / RZS. / DG-PRO1RWS)
  drogger: { names: DROGGER_NAME_PREFIXES, advertised: [], services: [DROGGER_SERVICE] },
  // デジスパイスも広告に 180D を載せているので、探した結果から除く
  hr: { names: [], advertised: [HEART_RATE_SERVICE], services: [HEART_RATE_SERVICE] },
  obd: { names: ['OBD', 'IOS-Vlink', 'V-LINK', 'Vlink', 'vLinker', 'Veepeak', 'OBDLink'], advertised: ['fff0', 'ffe0'], services: ['fff0', 'ffe0'] },
  gopro: { names: GOPRO_NAME_PREFIXES, advertised: [GOPRO_SERVICE], services: [GOPRO_SERVICE] }
};

const GENRES: Array<{ id: DeviceGenre; ja: string; en: string }> = [
  { id: 'position', ja: '位置', en: 'Position' },
  { id: 'sensor', ja: 'センサー', en: 'Sensors' },
  { id: 'camera', ja: 'カメラ', en: 'Cameras' }
];

const msg = (m: { ja: string; en: string }) => (getLang() === 'en' ? m.en : m.ja);

export const DevicesCard: React.FC = () => {
  const t = useT();
  const [genre, setGenre] = useState<DeviceGenre>('position');
  const [devices, setDevices] = useState<RegisteredDevice[]>(loadDevices);
  const [adding, setAdding] = useState<DeviceKind | null>(null);
  const [found, setFound] = useState<BleDeviceInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [draft, setDraft] = useState<RegisteredDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trial, setTrial] = useState<{ id: string; state: string; last: string } | null>(null);
  const trialLink = useRef<DeviceLink | null>(null);
  // Bluetooth Classic (Android のアプリ。Drogger DG-PRO1S など) を使えるか・その形で追加しているか
  const [sppOk, setSppOk] = useState(false);
  const [addingSpp, setAddingSpp] = useState(false);
  useEffect(() => { void sppAvailable().then(setSppOk); }, []);
  const centralOf = (spp: boolean | undefined): Promise<BleCentral | null> => (spp ? Promise.resolve(sppCentral) : getBleCentral());

  useEffect(() => () => { void trialLink.current?.disconnect(); }, []);

  const save = (list: RegisteredDevice[]) => { setDevices(list); saveDevices(list); };

  const startScan = async (kind: DeviceKind, spp = false) => {
    setAdding(kind);
    setAddingSpp(spp);
    setFound([]);
    setError(null);
    const central = await centralOf(spp);
    if (!central) { setError(t('この環境では Bluetooth を使えません', 'Bluetooth is not available here')); return; }
    const s = SCAN[kind];
    setScanning(true);
    try {
      await central.scan(
        // Bluetooth Classic は OS の選ぶ画面で、名前で絞らずに出す (機種ごとに名前がまちまちなため)
        { namePrefixes: spp ? [] : s.names, services: s.services, advertisedServices: s.advertised },
        d => {
          if (kind === 'hr' && DIGSPICE_NAME_PREFIXES.some(p => d.name.startsWith(p))) return;
          setFound(list => (list.some(x => x.id === d.id) ? list : [...list, d]));
        },
        () => setScanning(false)
      );
    } catch (e) {
      setScanning(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pick = (kind: DeviceKind, d: BleDeviceInfo) => {
    void centralOf(addingSpp).then(c => c?.stopScan());
    setScanning(false);
    setDraft({ id: d.id, kind, bleName: d.name, displayName: d.name || DEVICE_KINDS[kind].ja, fileName: suggestFileName(kind, devices.filter(x => x.id !== d.id)), addedAt: Date.now(), ...(addingSpp ? { transport: 'spp' as const } : {}) });
  };

  const draftError = draft ? checkDeviceFileName(draft.fileName, devices, draft.id) : null;

  const commit = () => {
    if (!draft || draftError) return;
    save(upsertDevice(devices, { ...draft, displayName: draft.displayName.trim() || draft.bleName }));
    setDraft(null);
    setAdding(null);
    setFound([]);
  };

  const tryDevice = async (d: RegisteredDevice) => {
    await trialLink.current?.disconnect().catch(() => {});
    const central = await centralOf(d.transport === 'spp');
    if (!central) return;
    const link = new DeviceLink(d, central);
    trialLink.current = link;
    setTrial({ id: d.id, state: 'connecting', last: '' });
    // つなぎ直しているときは、つながらない理由も出す (確かめてもらうとき、記録を送ってもらわなくても分かるように)
    link.onState(s => setTrial(v => (v && v.id === d.id ? { ...v, state: s, last: s === 'reconnecting' && link.error ? link.error : v.last } : v)));
    link.onSample((s: DeviceSample) => {
      const text = s.type === 'fix'
        ? `${s.fix.valid ? '' : t('(測位待ち) ', '(no fix) ')}${s.fix.speedKmh.toFixed(1)} km/h ${s.fix.latitude.toFixed(5)}, ${s.fix.longitude.toFixed(5)}`
        : s.type === 'values'
          ? Object.entries(s.values).map(([k, v]) => `${k} ${v}`).join(' · ')
          : `${s.status.encoding ? t('録画中', 'Recording') : t('止まっている', 'Idle')}${s.status.batteryPercent !== undefined ? ` · ${t('電池', 'battery')} ${s.status.batteryPercent}%` : ''}`;
      setTrial(v => (v && v.id === d.id ? { ...v, last: text } : v));
    });
    try {
      await link.connect();
    } catch (e) {
      setTrial({ id: d.id, state: 'disconnected', last: e instanceof Error ? e.message : String(e) });
    }
  };

  const list = devicesOfGenre(devices, genre);
  const kindsHere = (Object.keys(DEVICE_KINDS) as DeviceKind[]).filter(k => DEVICE_KINDS[k].genre === genre);
  const inputCls = 'w-full bg-surface-0 border border-line-3 rounded-lg px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-red-500';

  return (
    <div className="bg-surface-2 border border-line-2 rounded-xl p-4 space-y-3" data-testid="devices-card">
      <div className="flex items-center gap-2">
        <Bluetooth size={16} className="text-sky-400" />
        <h3 className="text-sm font-bold text-slate-100 flex-1">{t('機器の登録 (Bluetooth)', 'Devices (Bluetooth)')}</h3>
      </div>
      <div className="flex gap-1">
        {GENRES.map(g => (
          <button key={g.id} onClick={() => { setGenre(g.id); setAdding(null); setDraft(null); }}
            className={`px-3 py-1 rounded-lg text-xs font-bold ${genre === g.id ? 'bg-sky-600 text-white' : 'bg-surface-4 text-slate-300'}`}>
            {t(g.ja, g.en)}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        {genre === 'position' && t('ラップタイマーの位置の出どころ (デジスパイスは上の欄で登録)。1 回の走行でどれか 1 つ。', 'Position source for the lap timer (register a DigSpice above). One per run.')}
        {genre === 'sensor' && t('走っている間の値を、走行と同じ名前の .csv に記録します。いくつでも。', 'Values are recorded to a .csv with the same name as the run. Any number.')}
        {genre === 'camera' && t('ラップタイマーで測り始めたら録画を始め、止めたら止めます。初めてつなぐときは、カメラをペアリングの状態にしてください (端末が 1 回だけ確認を出します)。', 'Recording starts and stops with the lap timer. When connecting for the first time, put the camera in pairing mode (the iPhone asks once).')}
      </p>

      {list.length === 0 && !adding && <div className="text-xs text-slate-500">{t('まだありません', 'None yet')}</div>}
      {list.map(d => (
        <div key={d.id} className="rounded-lg bg-surface-3/60 px-3 py-2 space-y-1.5" data-testid="device-row">
          <div className="flex items-center gap-2 text-xs min-w-0">
            {/* 名前と種類は 2 行にして、狭い画面でもボタンの場所を空ける */}
            <span className="flex flex-col min-w-0 flex-1">
              <span className="font-bold text-slate-100 truncate">{d.displayName}</span>
              <span className="text-[11px] text-slate-500 truncate">{t(DEVICE_KINDS[d.kind].ja, DEVICE_KINDS[d.kind].en)}{d.transport === 'spp' ? ' (Bluetooth Classic)' : ''} · {d.bleName}</span>
            </span>
            <span className="ml-auto flex gap-1 shrink-0 whitespace-nowrap">
              {d.transport === 'spp' && (
                <button onClick={() => { void shareSppLog().catch(e => setError(e instanceof Error ? e.message : String(e))); }} className="px-2 py-0.5 rounded bg-surface-4 hover:bg-surface-5 border border-line-4 text-[11px]" data-testid="device-share-log">
                  {t('記録を送る', 'Send log')}
                </button>
              )}
              <button onClick={() => { void tryDevice(d); }} className="flex items-center gap-1 px-2 py-0.5 rounded bg-surface-4 hover:bg-surface-5 border border-line-4 text-[11px]"><Activity size={11} />{t('試す', 'Test')}</button>
              <button onClick={() => { if (window.confirm(t(`「${d.displayName}」の登録を消しますか？ (記録したファイルは残ります)`, `Remove "${d.displayName}"? (Recorded files are kept)`))) save(removeDevice(devices, d.id)); }}
                className="p-1 rounded text-slate-400 hover:text-red-400" aria-label={t('消す', 'Remove')}><Trash2 size={13} /></button>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-slate-400">{t('表示名', 'Display name')}
              <input className={inputCls} value={d.displayName} onChange={e => save(upsertDevice(devices, { ...d, displayName: e.target.value }))} />
            </label>
            <label className="text-[11px] text-slate-400">{t('ファイル名用の名前', 'Name for files')}
              <input className={`${inputCls} font-mono`} defaultValue={d.fileName}
                onBlur={e => {
                  const v = e.target.value.replace(/[A-Z]/g, c => c.toLowerCase());
                  const problem = checkDeviceFileName(v, devices, d.id);
                  if (problem) { setError(msg(problem)); e.target.value = d.fileName; return; }
                  setError(null);
                  if (v !== d.fileName) save(upsertDevice(devices, { ...d, fileName: v }));
                }} />
            </label>
          </div>
          <div className="text-[10px] text-slate-500">{msg(RENAME_NOTICE)} ({t('ファイル', 'file')}: <span className="font-mono">&lt;{t('走行', 'run')}&gt;.{d.fileName}.csv</span>)</div>
          {trial?.id === d.id && (
            <div className="text-[11px] font-mono text-sky-300">{trial.state}{trial.last ? ` · ${trial.last}` : ''}</div>
          )}
        </div>
      ))}

      {!adding && (
        <div className="flex flex-wrap gap-2">
          {kindsHere.map(k => (
            <button key={k} onClick={() => { void startScan(k); }} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-4 hover:bg-surface-5 border border-line-4 text-xs text-slate-200">
              <Plus size={13} />{t(`${DEVICE_KINDS[k].ja}を追加`, `Add ${DEVICE_KINDS[k].en}`)}
            </button>
          ))}
          {genre === 'position' && sppOk && (
            <button onClick={() => { void startScan('drogger', true); }} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-4 hover:bg-surface-5 border border-line-4 text-xs text-slate-200" data-testid="device-add-drogger-spp">
              <Plus size={13} />{t('Drogger (Bluetooth Classic・DG-PRO1S など) を追加', 'Add Drogger (Bluetooth Classic, DG-PRO1S etc.)')}
            </button>
          )}
        </div>
      )}

      {adding && !draft && (
        <div className="rounded-lg border border-line-3 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Search size={13} />{scanning ? t('探しています…', 'Searching…') : t('探し終えました', 'Search finished')}
            <button onClick={() => { void centralOf(addingSpp).then(c => c?.stopScan()); setAdding(null); setScanning(false); }} className="ml-auto text-slate-400 hover:text-fg">{t('やめる', 'Cancel')}</button>
          </div>
          {found.length === 0 && !scanning && <div className="text-[11px] text-slate-500">{t('見つかりませんでした。機器の電源を入れ、近くで探してください。', 'Nothing found. Turn the device on and search nearby.')}</div>}
          {found.map(d => (
            <button key={d.id} onClick={() => pick(adding, d)} className="w-full text-left px-3 py-2 rounded-lg bg-surface-3 hover:bg-surface-4 text-xs" data-testid="device-found">
              {d.name || d.id}{d.rssi !== undefined ? <span className="text-slate-500"> · {d.rssi} dBm</span> : null}
            </button>
          ))}
        </div>
      )}

      {draft && (
        <div className="rounded-lg border border-sky-700 p-3 space-y-2" data-testid="device-draft">
          <div className="text-xs text-slate-300">{t(DEVICE_KINDS[draft.kind].ja, DEVICE_KINDS[draft.kind].en)} · {draft.bleName}</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-slate-400">{t('表示名', 'Display name')}
              <input className={inputCls} value={draft.displayName} onChange={e => setDraft({ ...draft, displayName: e.target.value })} />
            </label>
            <label className="text-[11px] text-slate-400">{t('ファイル名用の名前', 'Name for files')}
              <input className={`${inputCls} font-mono ${draftError ? 'border-red-500' : ''}`} value={draft.fileName}
                onChange={e => setDraft({ ...draft, fileName: e.target.value.replace(/[A-Z]/g, c => c.toLowerCase()) })} data-testid="device-file-name" />
            </label>
          </div>
          {draftError && <div className="text-[11px] text-red-400">{msg(draftError)}</div>}
          <div className="text-[10px] text-slate-500">{msg(RENAME_NOTICE)}</div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setDraft(null); setAdding(null); }} className="px-3 py-1.5 rounded-lg border border-line-3 text-xs text-slate-300">{t('やめる', 'Cancel')}</button>
            <button onClick={commit} disabled={!!draftError} className="px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-bold disabled:opacity-40">{t('登録する', 'Register')}</button>
          </div>
        </div>
      )}
      {error && <div className="text-[11px] text-amber-400">{error}</div>}
    </div>
  );
};
