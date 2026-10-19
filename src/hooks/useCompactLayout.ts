import { useSyncExternalStore } from 'react';
import { isPhone } from '../utils/device';

// スマートフォン向けの配置にするのは、スマートフォン (src/utils/device.ts の isPhone) と、ウインドウの幅が 600px より狭いとき。
// パソコンでウインドウを狭くすると、スマートフォンの表示を確かめられる。タブレットはパソコン向けの配置
// (ロガー設定のタブは、配置に関係なく USB でつなげる環境だけに出す: canUseLoggerUsb)
const NARROW_QUERY = '(max-width: 599px)';
const LANDSCAPE_QUERY = '(orientation: landscape)';

const media = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);
const narrowMql = media(NARROW_QUERY);
const landscapeMql = media(LANDSCAPE_QUERY);

const watch = (mql: MediaQueryList | null) => (cb: () => void) => {
  mql?.addEventListener('change', cb);
  return () => mql?.removeEventListener('change', cb);
};
const subscribeNarrow = watch(narrowMql);
const subscribeLandscape = watch(landscapeMql);

/** スマートフォン向けの配置にするか */
export function useCompactLayout(): boolean {
  const narrow = useSyncExternalStore(subscribeNarrow, () => !!narrowMql?.matches);
  return isPhone || narrow;
}

/** 横向きか (スマートフォンを横にしたときは、グラフとコース図を左右に並べる) */
export function useLandscape(): boolean {
  return useSyncExternalStore(subscribeLandscape, () => !!landscapeMql?.matches);
}
