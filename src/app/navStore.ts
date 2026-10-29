/**
 * 今どの画面を出しているか (アプリに 1 つ)。2026-10-21 (PLAN-24 の 2)。
 * 外枠・ヘッダー・各画面・読み込みの処理 (await のあと) から同じものを見るので、App の state ではなくここに置く。
 * 測っている間 (ラップタイマー) は locked にして、ほかの画面へ行けないようにする
 */

import { useSyncExternalStore } from 'react';
import type { NavPlan, Screen } from './navPlan';

export interface NavState {
  screen: Screen;
  /** ⚙ の中の画面から戻る先 */
  from: Screen | null;
  locked: boolean;
}

/** URL の末尾 (#convert など) の名前と画面。#graph は前の名前 */
const HASH_SCREENS: Record<string, Screen> = {
  graph: 'analysis', analysis: 'analysis', laptimer: 'timer', timer: 'timer',
  convert: 'convert', data: 'data', logger: 'logger', video: 'video', library: 'library', settings: 'settings'
};

/** URL の末尾から画面を決める。ない・その環境で出せない画面なら null */
export function parseHash(hash: string, plan: NavPlan): Screen | null {
  const s = HASH_SCREENS[hash.replace(/^#/, '')];
  return s && plan.available.has(s) ? s : null;
}

let plan: NavPlan | null = null;
/** ⚙ の中の画面を重ねて開いたときの戻り先 (⚙ → データ管理 → 戻る → 戻る で、はじめの画面へ) */
let backStack: Screen[] = [];
let state: NavState = { screen: 'analysis', from: null, locked: false };
let initialized = false;
const listeners = new Set<() => void>();

function set(next: NavState) {
  if (next.screen === state.screen && next.from === state.from && next.locked === state.locked) return;
  // 離れる画面を URL の末尾で開いていたら外す (読み込み直したときに、またその画面を開かないように)。#openrun= などは触らない
  if (next.screen !== state.screen && typeof window !== 'undefined' && plan && parseHash(window.location.hash, plan) === state.screen) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  state = next;
  listeners.forEach(l => l());
}

/** 今いる下のタブをもう一度押したときの知らせ (その画面のいちばん上へ戻すため。iPhone のアプリのふつうの動き。2026-10-28) */
const reselectListeners = new Set<(screen: Screen) => void>();

export const navStore = {
  /** 今いるタブをもう一度押した */
  reselect(screen: Screen): void {
    reselectListeners.forEach(l => l(screen));
  },
  /** 今いるタブをもう一度押したら呼ばれる */
  onReselect(l: (screen: Screen) => void): () => void {
    reselectListeners.add(l);
    return () => { reselectListeners.delete(l); };
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  getSnapshot(): NavState {
    return state;
  },
  /** 組み方を入れる。はじめの 1 回だけ URL の末尾を読む (何度呼んでもよい)。組み方が変わって今の画面がなくなったら、最初の画面へ */
  init(p: NavPlan): void {
    plan = p;
    if (!initialized) {
      initialized = true;
      const fromHash = typeof window !== 'undefined' ? parseHash(window.location.hash, p) : null;
      set({ screen: fromHash ?? p.home, from: null, locked: false });
      return;
    }
    if (!p.available.has(state.screen)) set({ ...state, screen: p.home, from: null });
  },
  /** 画面を替える。測っている間は替えない。その環境にない画面なら何もしない */
  go(screen: Screen): void {
    if (state.locked && screen !== state.screen) return;
    if (plan && !plan.available.has(screen)) {
      console.warn(`[nav] ${screen} はこの環境にありません`);
      return;
    }
    if (screen === state.screen) return;
    const isMore = !!plan?.more.includes(screen) && !plan.primary.includes(screen);
    if (isMore) backStack.push(state.screen);
    else backStack = [];
    set({ ...state, screen, from: isMore ? state.screen : null });
  },
  /** ⚙ の中の画面から戻る */
  back(): void {
    if (state.locked) return;
    const to = backStack.pop() ?? plan?.home ?? 'analysis';
    set({ ...state, screen: to, from: backStack[backStack.length - 1] ?? null });
  },
  /** 測っている間は、ほかの画面へ行けないようにする */
  setLocked(on: boolean): void {
    set({ ...state, locked: on });
  },
  /** 試験用: はじめの状態に戻す */
  resetForTest(): void {
    plan = null;
    initialized = false;
    backStack = [];
    state = { screen: 'analysis', from: null, locked: false };
  }
};

export function useNav(): NavState {
  return useSyncExternalStore(navStore.subscribe, navStore.getSnapshot);
}

export function useScreen(): Screen {
  return useNav().screen;
}
