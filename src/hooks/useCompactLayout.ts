import { useEffect, useState, useSyncExternalStore } from 'react';

// 配置の段 (PLAN-30。docs/duo_layout_design.md の 2)。端末の名前でなく、今の画面の大きさで決める (折りたたみの iPhone Duo は開くと幅が変わるため)
// - phone: 幅 600 未満、または指で触る画面で高さ 500 未満 (横向きのスマートフォン)
// - medium: 指で触る画面で幅 1024 未満 (Duo を開いたとき・iPad mini の縦・iPad の Split View)。下のタブ・押す所の大きさはスマートフォンと同じで、並べ方だけ広げる
// - wide: それ以外 (パソコン・iPad の横)
// パソコンでウインドウを狭くすると、スマートフォンの表示を確かめられる
export type LayoutTier = 'phone' | 'medium' | 'wide';

const media = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);
const QUERIES = {
  narrow: media('(max-width: 599px)'),
  short: media('(max-height: 499px)'),
  belowWide: media('(max-width: 1023px)'),
  coarse: media('(pointer: coarse)'),
  landscape: media('(orientation: landscape)')
};

/** 今の大きさでの段 (試験のため、値から決める形も出しておく) */
export function tierFor(v: { narrow: boolean; short: boolean; belowWide: boolean; coarse: boolean }): LayoutTier {
  if (v.narrow || (v.coarse && v.short)) return 'phone';
  if (v.coarse && v.belowWide) return 'medium';
  return 'wide';
}

const currentTier = (): LayoutTier => tierFor({
  narrow: !!QUERIES.narrow?.matches,
  short: !!QUERIES.short?.matches,
  belowWide: !!QUERIES.belowWide?.matches,
  coarse: !!QUERIES.coarse?.matches
});

// 段は、画面の大きさが 0.15 秒変わらなくなってから切り替える (Duo を開く・たたむ間は大きさが何度か変わるので、途中でちらつかせない)
const SETTLE_MS = 150;
let tier: LayoutTier = typeof window !== 'undefined' ? currentTier() : 'wide';
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
const onChange = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const next = currentTier();
    if (next === tier) return;
    tier = next;
    for (const f of listeners) f();
  }, SETTLE_MS);
};
let watching = false;
function subscribeTier(cb: () => void): () => void {
  if (!watching) {
    watching = true;
    for (const q of [QUERIES.narrow, QUERIES.short, QUERIES.belowWide, QUERIES.coarse]) q?.addEventListener('change', onChange);
  }
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 配置の段 */
export function useLayoutTier(): LayoutTier {
  return useSyncExternalStore(subscribeTier, () => tier, () => 'wide');
}

/** スマートフォンの作り (下のタブ・1 画面ずつ・指の大きさ) にするか。中くらいの段も、作りはスマートフォンと同じ */
export function useCompactLayout(): boolean {
  return useLayoutTier() !== 'wide';
}

/** 中くらいの段か (Duo を開いたときなど。並べ方を広げる) */
export function useMediumLayout(): boolean {
  return useLayoutTier() === 'medium';
}

const subscribeLandscape = (cb: () => void) => {
  QUERIES.landscape?.addEventListener('change', cb);
  return () => QUERIES.landscape?.removeEventListener('change', cb);
};

/** 横向きか (スマートフォンを横にしたときは、グラフとコース図を左右に並べる) */
export function useLandscape(): boolean {
  return useSyncExternalStore(subscribeLandscape, () => !!QUERIES.landscape?.matches);
}

/** 段が変わったときに一度だけ呼ぶ (前の段・新しい段)。開く・たたむの移り変わりで、出す欄を引き継ぐため */
export function useTierChange(f: (prev: LayoutTier, next: LayoutTier) => void): void {
  const now = useLayoutTier();
  const [prev, setPrev] = useState(now);
  useEffect(() => {
    if (prev === now) return;
    f(prev, now);
    setPrev(now);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
}
