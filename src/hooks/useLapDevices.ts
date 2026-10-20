/**
 * ラップタイマーで使う Bluetooth LE の機器 (2026-10-20、PLAN-21・22)。
 * ラップタイマーを開いている間、登録した機器につなぐ。
 * - RaceBox (位置の出どころに選んだとき): 測位を onFix に渡す
 * - センサー (心拍計・OBD-II): 走行のファイルができたら、同じ名前の .csv に値を書く (RaceBox の G・回転の速さも)
 * - カメラ (GoPro): 動き出したら時計を合わせて録画を始め、周を終えるたびに印を付け、止めたら録画を止める
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBleCentral } from '../services/bleCentral';
import { DeviceLink, type DeviceSample } from '../services/devices/deviceLink';
import { loadDevices, type RegisteredDevice } from '../services/devices/deviceRegistry';
import { SensorCsvRecorder } from '../services/sensorCsvRecorder';
import type { LiveFix } from '../services/liveLapTimer';

/** 画面に出す機器の様子 */
export interface LapDeviceStatus {
  device: RegisteredDevice;
  state: string;
  /** 直近の値 (心拍・回転数・録画中か など) */
  text: string;
  ok: boolean;
}

/** 列の名前 (機器の種類ごと) */
const COLUMNS: Record<string, string[]> = {
  hr: ['bpm'],
  obd: ['rpm', 'speed_kmh', 'throttle_pct', 'coolant_c', 'intake_c', 'load_pct'],
  racebox: ['g_x', 'g_y', 'g_z', 'roll_dps', 'pitch_dps', 'yaw_dps', 'satellites', 'battery_pct']
};

export function useLapDevices(opts: {
  /** RaceBox を位置の出どころにするか */
  useRacebox: boolean;
  onFix: (fix: LiveFix) => void;
  /** 今の走行のファイルの名前 (拡張子なし。まだ無ければ null) */
  runBase: () => string | null;
}) {
  const [devices] = useState<RegisteredDevice[]>(loadDevices);
  const [statuses, setStatuses] = useState<LapDeviceStatus[]>([]);
  const links = useRef<DeviceLink[]>([]);
  const recorders = useRef(new Map<string, SensorCsvRecorder>());
  const cameraRunning = useRef(false);
  const onFixRef = useRef(opts.onFix);
  onFixRef.current = opts.onFix;
  const runBaseRef = useRef(opts.runBase);
  runBaseRef.current = opts.runBase;

  const racebox = devices.find(d => d.kind === 'racebox') ?? null;

  useEffect(() => {
    let cancelled = false;
    // 位置の RaceBox は選んだときだけ、センサーとカメラはいつも
    const wanted = devices.filter(d => d.kind !== 'racebox' || (opts.useRacebox && d.id === racebox?.id));
    if (wanted.length === 0) return;
    const update = (id: string, patch: Partial<LapDeviceStatus>) =>
      setStatuses(list => list.map(s => (s.device.id === id ? { ...s, ...patch } : s)));
    setStatuses(wanted.map(device => ({ device, state: 'connecting', text: '', ok: false })));
    void (async () => {
      const central = await getBleCentral();
      if (!central || cancelled) return;
      for (const d of wanted) {
        const link = new DeviceLink(d, central);
        links.current.push(link);
        link.onState(s => update(d.id, { state: s, ok: s === 'connected' }));
        link.onSample((s: DeviceSample) => {
          if (s.type === 'fix') {
            onFixRef.current(s.fix);
            record(d, s.fix.tMs, s.values);
            update(d.id, { text: s.fix.valid ? `${s.values.satellites ?? ''} SV` : '測位待ち' });
          } else if (s.type === 'values') {
            record(d, s.tMs, s.values);
            const v = s.values;
            const text = v.bpm !== undefined ? `${v.bpm} bpm` : v.rpm !== undefined ? `${Math.round(v.rpm)} rpm` : '';
            if (text) update(d.id, { text });
          } else {
            update(d.id, { text: `${s.status.encoding ? 'REC' : '—'}${s.status.batteryPercent !== undefined ? ` · ${s.status.batteryPercent}%` : ''}`, ok: !!s.status.encoding || !cameraRunning.current });
          }
        });
        void link.connect().catch(e => update(d.id, { state: 'disconnected', text: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => {
      cancelled = true;
      // 閉じるときは、録画を止めてから切る
      const current = links.current;
      links.current = [];
      void (async () => {
        if (cameraRunning.current) {
          cameraRunning.current = false;
          await Promise.all(current.filter(l => l.device.kind === 'gopro').map(l => l.goproShutter(false).catch(() => {})));
        }
        await Promise.all([...recorders.current.values()].map(r => r.flush()));
        recorders.current.clear();
        await Promise.all(current.map(l => l.disconnect().catch(() => {})));
      })();
    };
    // 機器の一覧は開いている間は変えない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.useRacebox, racebox?.id]);

  /** センサーの値を、走行と同じ名前の .csv にためる (走行のファイルができてから) */
  function record(d: RegisteredDevice, tMs: number, values: Record<string, number>) {
    const base = runBaseRef.current();
    const columns = COLUMNS[d.kind];
    if (!base || !columns) return;
    const key = `${base}|${d.id}`;
    let rec = recorders.current.get(key);
    if (!rec) {
      rec = new SensorCsvRecorder(base, d.fileName, columns);
      recorders.current.set(key, rec);
    }
    rec.add(tMs, values);
  }

  /** ためたセンサーの値を書く (ラップタイマーの保存と一緒に) */
  const flush = useCallback(() => {
    for (const r of recorders.current.values()) void r.flush();
  }, []);

  /** 走り始めた: カメラの時計を合わせて録画を始める (1 回の走行で 1 回) */
  const startRun = useCallback((at: Date) => {
    if (cameraRunning.current) return;
    const cams = links.current.filter(l => l.device.kind === 'gopro' && l.state === 'connected');
    if (cams.length === 0) return;
    cameraRunning.current = true;
    for (const c of cams) void c.goproSetTime(at).catch(() => {}).then(() => c.goproShutter(true)).catch(() => {});
  }, []);

  /** 周を終えた: 動画に印を付ける */
  const lap = useCallback(() => {
    if (!cameraRunning.current) return;
    for (const c of links.current.filter(l => l.device.kind === 'gopro')) void c.goproHilight().catch(() => {});
  }, []);

  /** 走行を終えた (周を数え直す): 録画を止め、センサーの値を書き、次の走行の .csv に替える */
  const stopRun = useCallback(() => {
    if (cameraRunning.current) {
      cameraRunning.current = false;
      for (const c of links.current.filter(l => l.device.kind === 'gopro')) void c.goproShutter(false).catch(() => {});
    }
    for (const r of recorders.current.values()) void r.flush();
    recorders.current.clear();
  }, []);

  return { devices, racebox, statuses, flush, startRun, lap, stopRun };
}
