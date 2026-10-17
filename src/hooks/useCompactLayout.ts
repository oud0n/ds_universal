import { useSyncExternalStore } from 'react';

// スマートフォン向けの配置にする画面の大きさ: 幅が 768px 未満 (縦向き)、またはタッチ操作で高さが 500px 以下 (横向き)
const COMPACT_QUERY = '(max-width: 767px), (max-height: 500px) and (pointer: coarse)';
const LANDSCAPE_QUERY = '(orientation: landscape)';

const media = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);
const compactMql = media(COMPACT_QUERY);
const landscapeMql = media(LANDSCAPE_QUERY);

const subscribe = (cb: () => void) => {
  compactMql?.addEventListener('change', cb);
  landscapeMql?.addEventListener('change', cb);
  return () => {
    compactMql?.removeEventListener('change', cb);
    landscapeMql?.removeEventListener('change', cb);
  };
};

/** スマートフォン向けの配置にするか */
export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, () => !!compactMql?.matches);
}

/** 横向きか (スマートフォンを横にしたときは、グラフとコース図を左右に並べる) */
export function useLandscape(): boolean {
  return useSyncExternalStore(subscribe, () => !!landscapeMql?.matches);
}
