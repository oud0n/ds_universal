import { useSyncExternalStore } from 'react';
import { isPhone } from '../utils/device';

// スマートフォン向けの配置にするかは、画面の幅でなく機種 (スマートフォンか) で決める。
// タブレットとパソコン (ウインドウを狭くしても) はパソコン向けの配置
const LANDSCAPE_QUERY = '(orientation: landscape)';

const media = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);
const landscapeMql = media(LANDSCAPE_QUERY);

const subscribe = (cb: () => void) => {
  landscapeMql?.addEventListener('change', cb);
  return () => landscapeMql?.removeEventListener('change', cb);
};

/** スマートフォン向けの配置にするか */
export function useCompactLayout(): boolean {
  return isPhone;
}

/** 横向きか (スマートフォンを横にしたときは、グラフとコース図を左右に並べる) */
export function useLandscape(): boolean {
  return useSyncExternalStore(subscribe, () => !!landscapeMql?.matches);
}
