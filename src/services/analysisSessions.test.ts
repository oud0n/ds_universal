import { describe, expect, it } from 'vitest';
import { parseLapSession } from './analysisSessions';

describe('保存した比べ方 (解析用のセッション) を読む', () => {
  it('正しいものを読み、おかしな Car は落とす', () => {
    const s = parseLapSession(JSON.stringify({
      version: 1, name: '袖ヶ浦 比べ', createdAt: '2026-10-25T00:00:00Z',
      cars: [{ slot: 0, run: 'sodegaura/20260918/20260918092608.nmea', lap: 10 }, { slot: 1, run: '../etc/passwd', lap: 1 }, { slot: 2, lap: 3 }]
    }));
    expect(s?.cars).toEqual([{ slot: 0, run: 'sodegaura/20260918/20260918092608.nmea', lap: 10 }]);
  });

  it('版が違う・Car が無い・壊れたものは null', () => {
    expect(parseLapSession(JSON.stringify({ version: 2, name: 'x', cars: [{ slot: 0, run: 'a', lap: 1 }] }))).toBeNull();
    expect(parseLapSession(JSON.stringify({ version: 1, name: 'x', cars: [] }))).toBeNull();
    expect(parseLapSession('{')).toBeNull();
    expect(parseLapSession(null)).toBeNull();
  });
});
