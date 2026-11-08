import { describe, expect, it } from 'vitest';
import { carBestSource, makeReferenceContext } from './lapReferences';
import type { LapIndex } from '../lapIndex';
import type { RunsFile } from '../runsFile';
import type { RunStore } from '../runStore';

const lap = (n: number, time: number) => ({ n, time, startMs: 1_793_000_000_000 + n * 100_000, sectors: [time / 2, time / 2], topSpeed: 150 });
const index = {
  version: 1, courseHash: 'x', courseName: 'c',
  files: {
    '20261030/a.nmea': { laps: [lap(1, 90), lap(2, 85)] },
    '20261031/b.nmea': { laps: [lap(1, 84), lap(2, 83)] },
    '20261101/ref.nmea': { laps: [lap(1, 80)] }
  },
  hidden: [{ file: '20261031/b.nmea', n: 2, startMs: lap(2, 83).startMs }]
} as unknown as LapIndex;
const runs: RunsFile = { version: 2, runs: {
  '20261030/a': { car: 'ロードスター' },
  '20261031/b': { car: 'GR86' },
  '20261101/ref': { reference: { driver: '速い人' } }
} as unknown as RunsFile['runs'] };
const store = { read: async () => { throw new Error('no file'); } } as unknown as RunStore;
const course = { name: 'c', controlLine: { latA: 0, lonA: 0, latB: 0, lonB: 0 }, sectors: [] } as never;

describe('比べる相手 (過去の周)', () => {
  it('選んだ車の自分の周だけ、隠した周を除いて集め、参考ラップは別に分ける', () => {
    const ctx = makeReferenceContext(store, 'c', course, 'GR86', index, runs);
    expect(ctx.ownLaps.map(l => l.time)).toEqual([84]);
    expect(ctx.referenceLaps.map(l => [l.time, l.driver])).toEqual([[80, '速い人']]);
    const rs = makeReferenceContext(store, 'c', course, 'ロードスター', index, runs);
    expect(rs.ownLaps.map(l => l.time).sort()).toEqual([85, 90]);
  });

  it('この車のベスト: 周の点を読めなければ、比べる相手なし', async () => {
    const ctx = makeReferenceContext(store, 'c', course, 'ロードスター', index, runs);
    expect(await carBestSource.load(ctx)).toBeNull();
  });
});


it('古い周の控えに、更新後の版を除外した選択を適用する', () => {
  const file = 'new.nmea', rec = { size: 10, mtimeMs: 1, startMs: lap(1, 80).startMs, laps: [lap(1, 80)] };
  const ix = { ...index, files: { [file]: rec } };
  const decisions: RunsFile = { version: 2, runs: { new: { updatedAt: '', libraryDecision: { file, size: 20, mtimeMs: 2, include: false } } } };
  const current = new Map([[file, { size: 20, mtimeMs: 2 }]]);
  expect(makeReferenceContext(store, 'c', course, '', ix, decisions, current).ownLaps).toEqual([]);
  expect(makeReferenceContext(store, 'c', course, '', ix, null, new Map()).ownLaps).toEqual([]);
  expect(makeReferenceContext(store, 'c', course, '', ix, null, current).ownLaps).toEqual([]);
});
