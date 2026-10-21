/**
 * どこで動いているか (アプリ・デスクトップ版・ブラウザ) と画面の広さから、画面の組み方 (下のタブ・左のサイドバー・上のタブ) を決める。
 * 2026-10-21 (PLAN-24 の作る順番の 2: 外枠)。できること (ロガー・ラップタイマー・保管場所) は utils/device.ts と runStore.ts で決め、ここではまとめるだけ
 */

import { useMemo } from 'react';
import { hasNative } from '../native/bridge';
import { canUseLapTimer, canUseLogger, canUseLoggerBle, isMockNativeRequested } from '../utils/device';
import { useCompactLayout } from '../hooks/useCompactLayout';

export type AppHost = 'native' | 'electron' | 'browser';
export type AppLayout = 'phone' | 'wide';
export type ProfileKind = 'app-phone' | 'app-tablet' | 'desktop' | 'browser-phone' | 'browser-desktop';

export interface AppProfile {
  host: AppHost;
  layout: AppLayout;
  kind: ProfileKind;
  /** 保管場所 (走行のライブラリ) を使える */
  hasLibrary: boolean;
  hasLapTimer: boolean;
  /** ロガー設定 (USB か Bluetooth) */
  hasLogger: boolean;
  hasBle: boolean;
}

/**
 * どこで動いているか (ページを開いている間は変わらない)。
 * 開発用のふりのアプリ (?native=mock) は main.tsx で App を読み込んだあとに入るので、読み込んだときに一度だけ決めず、呼ぶたびに見る
 */
export function appHost(): AppHost {
  if (hasNative() || isMockNativeRequested()) return 'native';
  if (typeof window !== 'undefined' && window.electronAPI) return 'electron';
  return 'browser';
}

export interface Capabilities {
  hasLibrary: boolean;
  hasLapTimer: boolean;
  hasLogger: boolean;
  hasBle: boolean;
}

/** 今の環境でできること */
export function capabilities(host: AppHost): Capabilities {
  const electronLib = typeof window !== 'undefined' && !!window.electronAPI?.laps;
  return {
    hasLibrary: host === 'native' || electronLib,
    hasLapTimer: canUseLapTimer,
    hasLogger: canUseLogger,
    hasBle: canUseLoggerBle
  };
}

/** どこで動いているかと画面の広さから、組み方を決める (試験のため、環境を見ない形にしておく) */
export function profileFor(host: AppHost, compact: boolean, caps: Capabilities): AppProfile {
  const layout: AppLayout = compact ? 'phone' : 'wide';
  let kind: ProfileKind;
  if (host === 'native') kind = compact ? 'app-phone' : 'app-tablet';
  else if (host === 'electron') kind = compact ? 'browser-phone' : 'desktop';
  else kind = compact ? 'browser-phone' : 'browser-desktop';
  return { host, layout, kind, ...caps };
}

/** 今の組み方 (ウインドウの幅が変わると変わる) */
export function useAppProfile(): AppProfile {
  const compact = useCompactLayout();
  return useMemo(() => {
    const host = appHost();
    return profileFor(host, compact, capabilities(host));
  }, [compact]);
}
