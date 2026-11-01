/**
 * ラップタイマーの画面の出し方の設定 (2026-10-30)。
 * 周を終えたとき・セクターを跨いだときに、そのタイムを大きく出し続ける秒数 (0 は出さない)。次を跨いだら、そこで打ち切る
 */

export interface TimerDisplaySettings {
  lapHoldSec: number;
  sectorHoldSec: number;
}

export const LAP_HOLD_CHOICES = [2, 4, 6, 10];
export const SECTOR_HOLD_CHOICES = [0, 2, 4, 6, 10];
export const DEFAULT_TIMER_DISPLAY: TimerDisplaySettings = { lapHoldSec: 6, sectorHoldSec: 4 };

const KEY = 'ds_timer_display';

export function loadTimerDisplay(): TimerDisplaySettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    const pick = (x: unknown, choices: number[], d: number) => (typeof x === 'number' && choices.includes(x) ? x : d);
    return v && typeof v === 'object'
      ? { lapHoldSec: pick(v.lapHoldSec, LAP_HOLD_CHOICES, DEFAULT_TIMER_DISPLAY.lapHoldSec), sectorHoldSec: pick(v.sectorHoldSec, SECTOR_HOLD_CHOICES, DEFAULT_TIMER_DISPLAY.sectorHoldSec) }
      : DEFAULT_TIMER_DISPLAY;
  } catch {
    return DEFAULT_TIMER_DISPLAY;
  }
}

export function saveTimerDisplay(s: TimerDisplaySettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 覚えられなくても測れる */ }
}

/** 良くなった (速い) / 悪くなった / 同じくらい・比べる相手なし。端末の GPS (粗い) は同じくらいの幅を広く取る */
export type Verdict = 'better' | 'worse' | 'even';
export function verdictOf(diffSec: number | null | undefined, coarse: boolean): Verdict {
  if (diffSec === null || diffSec === undefined || !Number.isFinite(diffSec)) return 'even';
  const even = coarse ? 0.2 : 0.02;
  return diffSec < -even ? 'better' : diffSec > even ? 'worse' : 'even';
}
