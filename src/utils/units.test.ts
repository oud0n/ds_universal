import { describe, expect, it } from 'vitest';
import { formatSpeed, speedIn, speedToKmh } from './units';

describe('速度の単位', () => {
  it('km/h と mph を換算できる', () => {
    expect(speedIn(160.9344, 'mph')).toBeCloseTo(100, 6);
    expect(speedToKmh(100, 'mph')).toBeCloseTo(160.9344, 6);
    expect(speedIn(100, 'kmh')).toBe(100);
  });
  it('表示の文字', () => {
    expect(formatSpeed(131.06, 'kmh', 1)).toBe('131.1 km/h');
    expect(formatSpeed(160.9344, 'mph')).toBe('100 mph');
    expect(formatSpeed(NaN, 'kmh')).toBe('-- km/h');
  });
  it('画面で選べないので、決めていなければ km/h', () => {
    expect(formatSpeed(50)).toBe('50 km/h');
  });
});
