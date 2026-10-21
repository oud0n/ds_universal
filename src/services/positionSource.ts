/**
 * ラップタイマーの位置の出どころ (デジスパイス・RaceBox・端末の GPS) を覚え、画面の上の印でも同じものを出す。2026-10-21。
 * ログの再生は試すためのものなので覚えない
 */

import { useSyncExternalStore } from 'react';

export type PositionSource = 'digspice' | 'racebox' | 'drogger' | 'phone';

const KEY = 'lapTimer.source';
const listeners = new Set<() => void>();
let current: PositionSource | null = load();

function load(): PositionSource | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'digspice' || v === 'racebox' || v === 'drogger' || v === 'phone' ? v : null;
  } catch {
    return null;
  }
}

/** 選んだ出どころ (まだ選んでいなければ null。そのときはデジスパイス) */
export function getPositionSource(): PositionSource | null {
  return current;
}

export function setPositionSource(s: PositionSource): void {
  if (s === current) return;
  current = s;
  try { localStorage.setItem(KEY, s); } catch { /* 覚えられなくても今は使える */ }
  listeners.forEach(l => l());
}

export function usePositionSource(): PositionSource | null {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => current
  );
}
