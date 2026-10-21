// 1.0 の前のレビュー (2026-10-21) で直したところの試験
import { describe, expect, it } from 'vitest';
import { groupRunsByFolder } from './lapIndex';
import { sameRunExists } from './import/importPlan';
import { splitCorner, type NamedCorner } from './cornerNames';
import type { LapGeometry } from './drivingAnalysis';
import { updateRun, parseRunsFile } from './runsFile';
import type { RunStore } from './runStore';

describe('走行の一覧', () => {
  it('取り込み元/ と exports/ のログは走行として数えない', () => {
    const g = groupRunsByFolder([
      { path: 'sodegaura/20260815/20260815092455.nmea' },
      { path: '取り込み元/20260815092455.nmea' },
      { path: 'exports/20260815092455.bon4' }
    ] as never);
    expect([...g.keys()]).toEqual(['sodegaura']);
  });
});

describe('取り込み済みの見分け', () => {
  const start = new Date(2026, 9, 20, 10, 0, 0).getTime();
  it('日付のフォルダの走行', () => {
    expect(sameRunExists(new Set(['sodegaura/20261020/20261020100003']), 'sodegaura/20261020/20261020100000', start)).toBe(true);
  });
  it('日付のフォルダを作る前の置き方 (サーキットのフォルダの直下) の走行', () => {
    expect(sameRunExists(new Set(['sodegaura/20261020100003']), 'sodegaura/20261020/20261020100000', start)).toBe(true);
  });
  it('別のサーキット・離れた時刻は別の走行', () => {
    expect(sameRunExists(new Set(['nikko/20261020100003', 'sodegaura/20261020103000']), 'sodegaura/20261020/20261020100000', start)).toBe(false);
  });
});

describe('コーナーを分ける', () => {
  it('S 字を分けると、後ろは逆向きになる', () => {
    // 東へまっすぐの 41 点。前半は右 (+)、真ん中で 0、後半は左 (−) に曲がる
    const n = 41;
    const points = Array.from({ length: n }, (_, i) => ({ latitude: 35, longitude: 140 + i * 0.0001, time: i, distance: i * 0.01, speed: 50 }));
    const s = points.map((_, i) => i * 9.1);
    const curvature = points.map((_, i) => (i < 20 ? 0.02 : i === 20 ? 0 : -0.02));
    const geo = { lap: { points }, s, curvature } as unknown as LapGeometry;
    const at = (i: number) => ({ lat: 35, lon: 140 + i * 0.0001 });
    const c: NamedCorner = { name: 'S', direction: 'R', entry: at(2), apex: at(10), exit: at(38) };
    const out = splitCorner([c], 0, geo);
    expect(out.map(x => x.direction)).toEqual(['R', 'L']);
  });
});

describe('runs.json の書き換え', () => {
  it('2 つの走行の書き換えを続けて頼んでも、両方の行が残る', async () => {
    let text: string | null = null;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const store = {
      readTextStrict: async () => { const t = text; await sleep(5); return t; },
      writeText: async (_p: string, t: string) => { await sleep(5); text = t; }
    } as unknown as RunStore;
    await Promise.all([
      updateRun(store, 'sodegaura', '20260815/a.nmea', { videos: ['A.MP4'] }),
      updateRun(store, 'sodegaura', '20260918/b.nmea', { videos: ['B.MP4'] })
    ]);
    const runs = parseRunsFile(text).runs;
    expect(Object.keys(runs).sort()).toEqual(['20260815/a.nmea', '20260918/b.nmea']);
  });
});
