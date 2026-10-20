import { describe, expect, it } from 'vitest';
import { niceStep, valueRange } from './chartScale';

describe('X/Y グラフの目盛り', () => {
  it('目盛りは 1・2・5 × 10 の何乗', () => {
    expect(niceStep(200)).toBe(50);
    expect(niceStep(3)).toBe(0.5);
    expect(niceStep(1.2)).toBe(0.2);
    expect(niceStep(0)).toBe(1);
  });
  it('範囲は外れた値に引っ張られず、少し余白を足す', () => {
    const v = Array.from({ length: 1000 }, (_, i) => i / 10);
    v.push(1e6);
    const [lo, hi] = valueRange(v);
    expect(lo).toBeLessThan(0);
    expect(hi).toBeLessThan(200);
    expect(valueRange([])).toEqual([0, 1]);
    const [a, b] = valueRange([5, 5, 5]);
    expect(a).toBeLessThan(5);
    expect(b).toBeGreaterThan(5);
  });
});
