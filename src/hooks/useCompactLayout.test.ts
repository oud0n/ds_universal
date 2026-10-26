import { describe, expect, it } from 'vitest';
import { tierFor } from './useCompactLayout';

// 画面の大きさ (pt) と、指で触る画面か から段を決める
const at = (w: number, h: number, coarse: boolean) => tierFor({ narrow: w < 600, short: h < 500, belowWide: w < 1024, coarse });

describe('配置の段 (PLAN-30)', () => {
  it('Duo: たたむとスマートフォン、開くと中くらい (横でも縦でも)', () => {
    expect(at(466, 678, true)).toBe('phone');
    expect(at(951, 669, true)).toBe('medium');
    expect(at(669, 951, true)).toBe('medium');
  });
  it('横向きのスマートフォンはスマートフォンのまま', () => {
    expect(at(932, 430, true)).toBe('phone');
    expect(at(956, 440, true)).toBe('phone');
  });
  it('iPad mini の縦・Split View は中くらい、iPad の横はパソコン', () => {
    expect(at(744, 1133, true)).toBe('medium');
    expect(at(678, 1024, true)).toBe('medium');
    expect(at(1133, 744, true)).toBe('wide');
  });
  it('マウスの画面は、狭いときだけスマートフォン (中くらいにはしない)', () => {
    expect(at(500, 800, false)).toBe('phone');
    expect(at(900, 700, false)).toBe('wide');
    expect(at(900, 450, false)).toBe('wide');
  });
});
