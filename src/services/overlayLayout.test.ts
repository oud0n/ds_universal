import { describe, expect, it } from 'vitest';
import { AUTO_LAYOUT, BUILTIN_LAYOUTS, availableChannels, hiddenKey, parseOverlayLayout, resolveLayout, visibleParts } from './overlayLayout';
import type { Session } from '../types/telemetry';

const sess = (extra: Record<string, number> = {}) => ({
  points: Array.from({ length: 10 }, (_, i) => ({ time: i, speed: 100, accelG: 0, corneringG: 0, combinedG: 0, altitude: 0, ...extra })),
  laps: []
}) as unknown as Session;

describe('メーターの並び (PLAN-08)', () => {
  it('自動は、アクセルのあるログならデータ多め、無ければ標準', () => {
    expect(resolveLayout(AUTO_LAYOUT, sess()).id).toBe('builtin:standard');
    expect(resolveLayout(AUTO_LAYOUT, sess({ throttle: 50 })).id).toBe('builtin:data');
    expect(resolveLayout('builtin:graph', sess()).id).toBe('builtin:graph');
    // 知らない並びは自動
    expect(resolveLayout('nope', sess()).id).toBe('builtin:standard');
  });

  it('ログに値の無い部品と、出さないことにした部品は出さない', () => {
    const data = BUILTIN_LAYOUTS.find(l => l.id === 'builtin:data')!;
    const s = sess({ throttle: 50 });
    expect(availableChannels(s).has('brake')).toBe(false);
    const ids = visibleParts(data, s, new Set([hiddenKey(data.id, 'map')])).map(p => p.id);
    expect(ids).toContain('throttle');
    expect(ids).not.toContain('brake');
    expect(ids).not.toContain('steer');
    expect(ids).not.toContain('map');
  });

  it('並びのファイルを読む (おかしな部品は落とし、同梱の印は名乗れない)', () => {
    const l = parseOverlayLayout(JSON.stringify({
      version: 1, id: 'builtin:standard', name: '自分の並び',
      parts: [
        { id: 'a', type: 'bar', channel: 'throttle', x: 0.1, y: 0.8, w: 0.03, h: 0.15, color: '#22c55e' },
        { id: 'a', type: 'speed', x: 0.02, y: 0.83, w: 0.16, h: 0.13 },
        { type: 'bar', channel: 'nope', x: 0, y: 0, w: 0.1, h: 0.1 },
        { type: 'graph', channels: ['speed', 'xx'], window: 5, x: 0, y: 0, w: 0.5, h: 0.2 },
        { type: 'speed', x: 'a', y: 0, w: 0.1, h: 0.1 }
      ]
    }), 'mine');
    expect(l?.id).toBe('mine');
    expect(l?.name).toEqual(['自分の並び', '自分の並び']);
    expect(l?.parts.map(p => [p.id, p.type])).toEqual([['a', 'bar'], ['a_', 'speed'], ['graph2', 'graph']]);
    expect(l?.parts[2]).toMatchObject({ channels: ['speed'], window: 5 });
    expect(parseOverlayLayout('{"version":2,"parts":[]}', 'x')).toBeNull();
    expect(parseOverlayLayout('{', 'x')).toBeNull();
  });
});

describe('メーターの並びのレビューの指摘', () => {
  it("'toString' などは値として通さない", () => {
    const l = parseOverlayLayout(JSON.stringify({ version: 1, parts: [{ type: 'bar', channel: 'toString', x: 0, y: 0, w: 0.1, h: 0.1 }, { type: 'speed', x: 0, y: 0, w: 0.1, h: 0.1 }] }), 'x');
    expect(l?.parts.map(p => p.type)).toEqual(['speed']);
  });
});
