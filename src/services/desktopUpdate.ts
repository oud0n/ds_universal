/**
 * 版の番号と、デスクトップ版の更新の状態 (PLAN-44、2026-11-02)。
 * 更新の中身は electron/updater.cjs。ここは状態を画面に配るだけ
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { hasNative, nativeCapabilities } from '../native/bridge';

/** この画面 (Web) の版。iPhone・Android のアプリでは、アプリの版 (useAppVersion) と下の桁がずれることがある */
export const WEB_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** 画面に出す版の番号。アプリの中ではアプリの版 (前の版のアプリで分からなければ Web の版) */
export function useAppVersion(): string {
  const [v, setV] = useState(WEB_VERSION);
  useEffect(() => {
    if (!hasNative()) return;
    let alive = true;
    nativeCapabilities().then(c => { if (alive && c?.appVersion) setV(c.appVersion); });
    return () => { alive = false; };
  }, []);
  return v;
}

const api = () => (typeof window !== 'undefined' ? window.electronAPI?.update : undefined);

let state: DesktopUpdateState | null = null;
/** 知らせの帯を「あとで」で閉じた版 (開き直すまで出さない) */
let dismissed: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
let started = false;

function start() {
  if (started) return;
  const u = api();
  if (!u) return;
  started = true;
  u.onState(s => { state = s; emit(); });
  u.getState().then(s => { state = s; emit(); }, () => { /* 前の版の本体 */ });
}

const subscribe = (l: () => void) => {
  start();
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** 更新の状態。デスクトップ版でないとき・前の版の本体では null */
export function useDesktopUpdate(): DesktopUpdateState | null {
  return useSyncExternalStore(subscribe, () => state, () => null);
}

export function useUpdateDismissed(): string | null {
  return useSyncExternalStore(subscribe, () => dismissed, () => null);
}

export const desktopUpdate = {
  check: () => api()?.check().then(s => { state = s; emit(); }),
  download: () => api()?.download().then(s => { state = s; emit(); }),
  install: () => api()?.install(),
  openReleases: () => api()?.openReleases(),
  dismiss: (version: string | null) => { dismissed = version; emit(); },
};
