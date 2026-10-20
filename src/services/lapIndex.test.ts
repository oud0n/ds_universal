import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { courseHash, lapKey, groupBon4ByFolder, lapRows, lapsFromBon4, reconcileFolder, setHidden, setRunVideos, videosInFolder, type LapCourse, type LapRecord } from './lapIndex';
import { CIRCUIT_PRESETS } from './circuitDatabase';

const line = (lat: number) => ({ name: 'x', latA: lat, lonA: 140, latB: lat + 0.0001, lonB: 140.0001 });
const course: LapCourse = { name: 'テスト', controlLine: line(35), sectors: [{ ...line(35.01), id: 's1', name: 'S1' }] };
const lap = (n: number, startMs: number, time = 90): LapRecord => ({ n, time, startMs, sectors: [30, 30, 30], topSpeed: 150 });

/** 偽の計算 (ファイルの名前ごとに決めた周を返し、呼ばれた回数を数える) */
function fakeCompute(table: Record<string, LapRecord[]>) {
  const calls: string[] = [];
  const compute = (name: string) => { calls.push(name); return { startMs: table[name]?.[0]?.startMs ?? null, laps: table[name] ?? [] }; };
  return { calls, compute };
}
const read = async () => new Uint8Array();

describe('コースのハッシュ', () => {
  it('同じ線なら同じ、計測線やセクター線を動かすと変わる。コース図は関係しない', () => {
    const h = courseHash(course);
    expect(courseHash({ ...course })).toBe(h);
    expect(courseHash({ ...course, controlLine: line(35.00001) })).not.toBe(h);
    expect(courseHash({ ...course, sectors: [{ ...line(35.02), id: 's1', name: 'S1' }] })).not.toBe(h);
    expect(courseHash({ ...course, sectors: [] })).not.toBe(h);
    expect(courseHash({ ...course, pathPolylines: [[[140, 35]]] } as LapCourse)).toBe(h);
  });
});

describe('控えの作り直し (変わったところだけ計算する)', () => {
  const files = [
    { path: 'sodegaura/a.bon4', size: 100, mtimeMs: 1 },
    { path: 'sodegaura/b.bon4', size: 200, mtimeMs: 2 }
  ];
  const table = { 'a.bon4': [lap(1, 1000), lap(2, 91000)], 'b.bon4': [lap(1, 500000)] };

  it('はじめは全部計算し、変わっていなければ計算しない', async () => {
    const f = fakeCompute(table);
    const first = await reconcileFolder('sodegaura', files, course, null, read, f.compute);
    expect(f.calls).toEqual(['a.bon4', 'b.bon4']);
    expect(first.changed).toBe(true);
    const again = await reconcileFolder('sodegaura', files, course, first.index, read, f.compute);
    expect(f.calls.length).toBe(2);
    expect(again.changed).toBe(false);
  });

  it('大きさ・更新日時の変わったファイルだけ計算し直し、消えたファイルの周は消す', async () => {
    const f = fakeCompute(table);
    const first = await reconcileFolder('sodegaura', files, course, null, read, f.compute);
    const next = await reconcileFolder('sodegaura', [{ ...files[0], size: 150 }], course, first.index, read, f.compute);
    expect(f.calls).toEqual(['a.bon4', 'b.bon4', 'a.bon4']);
    expect(Object.keys(next.index.files)).toEqual(['a.bon4']);
    expect(next.changed).toBe(true);
  });

  it('計測線・セクター線を直したら、全部計算し直す', async () => {
    const f = fakeCompute(table);
    const first = await reconcileFolder('sodegaura', files, course, null, read, f.compute);
    await reconcileFolder('sodegaura', files, { ...course, controlLine: line(35.001) }, first.index, read, f.compute);
    expect(f.calls.length).toBe(4);
  });

  it('非表示は、計算し直して周の番号が変わっても、同じ時刻の周に引き継ぐ。近い周がなければ捨てる', async () => {
    const f = fakeCompute(table);
    const first = await reconcileFolder('sodegaura', files, course, null, read, f.compute);
    let index = setHidden(first.index, 'a.bon4', undefined, 2, true);
    index = setHidden(index, 'b.bon4', undefined, 1, true);
    expect(lapRows('sodegaura', index).filter(r => r.hidden).length).toBe(2);
    // 計測線を直したら、a の 2 周目が 3 周目になり (前に 1 周増えた)、b の周は無くなった
    const g = fakeCompute({ 'a.bon4': [lap(1, -89000), lap(2, 1000), lap(3, 92000)], 'b.bon4': [] });
    const next = await reconcileFolder('sodegaura', files, { ...course, controlLine: line(35.001) }, index, read, g.compute);
    expect(next.index.hidden).toEqual([{ file: 'a.bon4', n: 3, startMs: 92000 }]);
  });

  it('非表示を戻せる', async () => {
    const f = fakeCompute(table);
    const first = await reconcileFolder('sodegaura', files, course, null, read, f.compute);
    const hidden = setHidden(first.index, 'a.bon4', undefined, 1, true);
    expect(setHidden(hidden, 'a.bon4', undefined, 1, false).hidden).toEqual([]);
  });
});

describe('フォルダ分け', () => {
  it('保管場所/フォルダ/xxx.bon4 だけを数える (NMEA・控え・ほかの階層は数えない)', () => {
    const g = groupBon4ByFolder([
      { path: 'sodegaura/a.bon4', size: 1, mtimeMs: 1 },
      { path: 'sodegaura/a.nmea', size: 1, mtimeMs: 1 },
      { path: 'sodegaura/laptimes.json', size: 1, mtimeMs: 1 },
      { path: 'old.bon4', size: 1, mtimeMs: 1 },
      { path: 'fsw/x/y.bon4', size: 1, mtimeMs: 1 },
      { path: 'fsw/B.BON4', size: 1, mtimeMs: 1 }
    ]);
    expect([...g.keys()]).toEqual(['sodegaura', 'fsw']);
    expect(g.get('sodegaura')!.length).toBe(1);
  });
});

const SODE = '../ds_universal/_private/samples/wd/sode0919.bon4';
describe.skipIf(!existsSync(SODE))('実際のログ (袖ヶ浦)', () => {
  it('.bon4 から周を数える', () => {
    const preset = CIRCUIT_PRESETS.find(p => p.id === 'sodegaura')!;
    const { startMs, laps } = lapsFromBon4('sode0919.bon4', new Uint8Array(readFileSync(SODE)), { name: preset.name, controlLine: preset.controlLine!, sectors: preset.sectors });
    expect(startMs).not.toBeNull();
    expect(laps.length).toBeGreaterThan(3);
    const best = Math.min(...laps.map(l => l.time));
    expect(best).toBeGreaterThan(70);
    expect(best).toBeLessThan(110);
    // 周の始まりは時刻順、番号は 1 から
    laps.forEach((l, i) => { expect(l.n).toBe(i + 1); if (i) expect(l.startMs).toBeGreaterThan(laps[i - 1].startMs); });
    console.log('sode0919 laps', laps.length, 'best', best);
  });
});

describe('走行の動画 (同じフォルダの動画だけ)', () => {
  const files = [{ path: 'sodegaura/a.bon4', size: 100, mtimeMs: 1 }];
  const table = { 'a.bon4': [lap(1, 1000)] };

  it('動画のファイル名を付けられ、ほかのフォルダ・動画でないもの・隠しファイルは捨てる', async () => {
    const f = fakeCompute(table);
    const { index } = await reconcileFolder('sodegaura', files, course, null, read, f.compute);
    const next = setRunVideos(index, 'a.bon4', ['GX010001.MP4', 'GX010001.LRV', '../x.mp4', 'sub/y.mp4', 'a.nmea', '.hidden.mp4', 'GX010001.MP4']);
    expect(next.files['a.bon4'].videos).toEqual(['GX010001.MP4', 'GX010001.LRV']);
    expect(setRunVideos(next, 'a.bon4', []).files['a.bon4'].videos).toBeUndefined();
    expect(setRunVideos(next, 'none.bon4', ['x.mp4'])).toBe(next);
  });

  it('ファイルが変わって計算し直しても、コースを直しても、動画は引き継ぐ', async () => {
    const f = fakeCompute(table);
    const first = await reconcileFolder('sodegaura', files, course, null, read, f.compute);
    const withVideo = setRunVideos(first.index, 'a.bon4', ['GX010001.MP4']);
    const changed = await reconcileFolder('sodegaura', [{ ...files[0], size: 120 }], { ...course, controlLine: line(35.001) }, withVideo, read, f.compute);
    expect(changed.index.files['a.bon4'].videos).toEqual(['GX010001.MP4']);
  });

  it('同じフォルダの動画を挙げる', () => {
    expect(videosInFolder([
      { path: 'sodegaura/GX010001.MP4', size: 1, mtimeMs: 1 },
      { path: 'sodegaura/a.bon4', size: 1, mtimeMs: 1 },
      { path: 'fsw/GX010002.MP4', size: 1, mtimeMs: 1 }
    ], 'sodegaura')).toEqual(['GX010001.MP4']);
  });
});


describe('レビューで直したこと', () => {
  const files = [{ path: 'sodegaura/a.bon4', size: 100, mtimeMs: 1 }];

  it('読めなかったときは前の控えを残し、隠した周の印を消さない', async () => {
    const f = fakeCompute({ 'a.bon4': [lap(1, 1000), lap(2, 91000)] });
    const first = await reconcileFolder('sodegaura', files, course, null, read, f.compute);
    const hidden = setHidden(first.index, 'a.bon4', undefined, 2, true);
    const failing = () => { throw new Error('io'); };
    const next = await reconcileFolder('sodegaura', [{ ...files[0], size: 110 }], course, hidden, read, failing);
    expect(next.index.hidden.length).toBe(1);
    expect(next.index.files['a.bon4'].laps.length).toBe(2);
    // 大きさは前のままなので、次に開いたときに読み直す
    expect(next.index.files['a.bon4'].size).toBe(100);
  });

  it('分かれた走行は、まとまりごとに番号を振り、まとまりも含めて見分ける', async () => {
    const parts = { 'a.bon4': [{ ...lap(1, 1000), part: 1 }, { ...lap(1, 5000000), part: 2 }] };
    const f = fakeCompute(parts);
    const { index } = await reconcileFolder('sodegaura', files, course, null, read, f.compute);
    const h = setHidden(index, 'a.bon4', 2, 1, true);
    const rows = lapRows('sodegaura', h);
    expect(rows.map(r => [r.part, r.n, r.hidden])).toEqual([[1, 1, false], [2, 1, true]]);
    expect(lapKey('a.bon4', 2, 1)).not.toBe(lapKey('a.bon4', 1, 1));
  });

  it('開始時刻が同じ走行の周は、ファイルごとにまとめて並べる', () => {
    const index = { version: 1 as const, courseHash: '', courseName: '', hidden: [], files: {
      'b.bon4': { size: 1, mtimeMs: 1, startMs: null, laps: [lap(1, 0), lap(2, 1)] },
      'a.bon4': { size: 1, mtimeMs: 1, startMs: null, laps: [lap(1, 0), lap(2, 1)] }
    } };
    expect(lapRows('x', index).map(r => `${r.file}${r.n}`)).toEqual(['a.bon41', 'a.bon42', 'b.bon41', 'b.bon42']);
  });
  it('日付のフォルダの中の走行も、サーキットのフォルダで数える (2026-10-20)', () => {
    const g = groupBon4ByFolder([
      { path: 'sodegaura/20261024/20261024100000.bon4', size: 1, mtimeMs: 0 },
      { path: 'sodegaura/20260913092357.bon4', size: 1, mtimeMs: 0 },
      { path: 'sodegaura/misc/x.bon4', size: 1, mtimeMs: 0 },
      { path: 'sodegaura/20261024/GX010001.MP4', size: 1, mtimeMs: 0 }
    ]);
    expect(g.get('sodegaura')?.map(f => f.path)).toEqual(['sodegaura/20261024/20261024100000.bon4', 'sodegaura/20260913092357.bon4']);
  });
});
