import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });
const { DEFAULT_TIMER_DISPLAY, loadTimerDisplay, saveTimerDisplay, verdictOf } = await import('./timerDisplay');

describe('ラップタイマーの出し方の設定', () => {
  beforeEach(() => mem.clear());

  it('覚えた秒数を読み、選べない値は既定に戻す', () => {
    expect(loadTimerDisplay()).toEqual(DEFAULT_TIMER_DISPLAY);
    saveTimerDisplay({ lapHoldSec: 10, sectorHoldSec: 0 });
    expect(loadTimerDisplay()).toEqual({ lapHoldSec: 10, sectorHoldSec: 0 });
    mem.set('ds_timer_display', JSON.stringify({ lapHoldSec: 7, sectorHoldSec: 'x' }));
    expect(loadTimerDisplay()).toEqual(DEFAULT_TIMER_DISPLAY);
  });

  it('速い・遅い・同じくらい (端末の GPS は同じくらいの幅を広く取る)', () => {
    expect(verdictOf(-0.1, false)).toBe('better');
    expect(verdictOf(0.1, false)).toBe('worse');
    expect(verdictOf(0.01, false)).toBe('even');
    expect(verdictOf(null, false)).toBe('even');
    expect(verdictOf(-0.1, true)).toBe('even');
    expect(verdictOf(-0.3, true)).toBe('better');
  });
});
