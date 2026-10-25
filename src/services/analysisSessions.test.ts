import { describe, expect, it } from 'vitest';
import { fileSessionCars, lapStartUtcMs, matchFileSession, parseLapSession, resolveSessionLap } from './analysisSessions';
import type { Session } from '../types/telemetry';

const T0 = Date.parse('2026-10-25T01:00:00Z');
const sess = (starts: number[]) => ({
  points: [{ timestamp: new Date(T0).toISOString() }],
  laps: starts.map((startTime, i) => ({ lapNumber: i + 1, startTime })),
}) as unknown as Session;

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

describe('保存した周を、周の始まりの時刻で選び直す', () => {
  it('計測線を直して周の番号がずれても、同じ時刻の周を選ぶ', () => {
    const saved = lapStartUtcMs(sess([0, 100, 200, 300]), 3)!;
    expect(saved).toBe(T0 + 200_000);
    // 直したあと、最初の周が無くなった (番号が 1 つずれた)
    expect(resolveSessionLap(sess([100.4, 200.6, 300]), { lap: 3, lapStartMs: saved })).toEqual({ lap: 2, moved: true });
    expect(resolveSessionLap(sess([0, 100, 200, 300]), { lap: 3, lapStartMs: saved })).toEqual({ lap: 3, moved: false });
  });
  it('近い周が無い・時刻が無いときは保存した番号', () => {
    expect(resolveSessionLap(sess([0, 150, 400]), { lap: 3, lapStartMs: T0 + 200_000 })).toEqual({ lap: 3, moved: false });
    expect(resolveSessionLap(sess([0, 100]), { lap: 2 })).toEqual({ lap: 2, moved: false });
    const noTime = { points: [{}], laps: [{ lapNumber: 1, startTime: 0 }] } as unknown as Session;
    expect(resolveSessionLap(noTime, { lap: 1, lapStartMs: T0 })).toEqual({ lap: 1, moved: false });
  });
});

describe('ブラウザ版: 比べ方をファイルに書き出して、読み込む', () => {
  it('ファイルの名前と何番目かで指し、開いているログに当てる', () => {
    const a = { ...sess([0, 100, 200]), id: 'a', fileName: 'run.nmea' } as Session;
    const b1 = { ...sess([0, 90]), id: 'b1', fileName: 'two.vbo' } as Session;
    const b2 = { ...sess([0, 95, 190]), id: 'b2', fileName: 'two.vbo' } as Session;
    const cars = fileSessionCars([{ slot: 1, sessionId: 'b2', lapNumber: 2 }, { slot: 0, sessionId: 'a', lapNumber: 3 }], [a, b1, b2]);
    expect(cars.map(c => [c.slot, c.run, c.part, c.lap])).toEqual([[0, 'run.nmea', undefined, 3], [1, 'two.vbo', 2, 2]]);
    // 読み込み直した (id は変わる)。run.nmea は開いていない
    const b1n = { ...b1, id: 'x1' }, b2n = { ...b2, id: 'x2' };
    const r = matchFileSession({ version: 1, name: 'n', createdAt: '', source: 'files', cars }, [b1n, b2n]);
    expect(r.missing).toEqual(['run.nmea']);
    expect(r.picks.map(p => [p.slot, p.session.id, p.lapNumber])).toEqual([[1, 'x2', 2]]);
  });
});
