/**
 * ラップタイマーで使う Bluetooth LE の機器 (画面用の薄い包み)。中身は services/timer/lapDeviceSet.ts (2026-10-21 に切り出した)。
 * ラップタイマーを開いている間、登録した機器につなぐ (今までどおり。つなぐ時を測定開始に替えるのは作る順番の 4 の続き)
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { LapDeviceSet, type LapDeviceStatus } from '../services/timer/lapDeviceSet';
import type { LiveFix } from '../services/liveLapTimer';

export type { LapDeviceStatus };

export function useLapDevices(opts: {
  /** 位置の出どころにする Bluetooth の機器の種類 (RaceBox・Drogger。デジスパイス・端末の GPS なら null) */
  position: 'racebox' | 'drogger' | null;
  onFix: (fix: LiveFix) => void;
  /** 今の走行のファイルの名前 (拡張子なし。まだ無ければ null) */
  runBase: () => string | null;
}) {
  const onFixRef = useRef(opts.onFix);
  onFixRef.current = opts.onFix;
  const runBaseRef = useRef(opts.runBase);
  runBaseRef.current = opts.runBase;
  const setRef = useRef<LapDeviceSet | null>(null);
  setRef.current ??= new LapDeviceSet({ onFix: f => onFixRef.current(f), runBase: () => runBaseRef.current() });
  const set = setRef.current;
  const statuses = useSyncExternalStore(set.subscribe, set.getSnapshot);

  useEffect(() => {
    void set.connect(opts.position);
    return () => { void set.disconnect(); };
  }, [set, opts.position]);

  return {
    devices: set.devices,
    racebox: set.racebox,
    drogger: set.drogger,
    statuses,
    flush: () => set.flush(),
    startRun: (at: Date) => set.startRun(at),
    lap: () => set.lap(),
    stopRun: () => set.stopRun()
  };
}
