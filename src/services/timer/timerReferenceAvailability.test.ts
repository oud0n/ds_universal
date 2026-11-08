import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import type { LapReferenceChoice, LapReferenceContext, LapReferenceSource } from './lapReferences';

const source: LapReferenceSource = {
  id: 'test-choice', label: ['選択', 'Choice'],
  available: () => available,
  subscribeAvailability: listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  load: ctx => load(ctx)
};
const listeners = new Set<() => void>();
let available = true;
let failMetadata = false, strictMetadataReads = 0;
const load = vi.fn<(ctx: LapReferenceContext) => Promise<LapReferenceChoice | null>>();
const metadataTexts = new Map<string, string>();
let metadataInventory: Array<{path: string; size: number; mtimeMs: number; local: boolean}> = [], indexText: string | null = null;
vi.mock('../../addons', () => ({ addons: { get lapReferences() { return [source]; } } }));
vi.mock('../../native/bridge', () => ({
  hasNative: () => true, callNative: async () => ({}), onNative: () => () => {}, toBase64: () => ''
}));
vi.mock('../runStore', async importOriginal => ({
  ...await importOriginal<object>(),
  getRunStore: async () => ({
    listAll: async () => metadataInventory,
    readTextStrict: async (path: string) => { strictMetadataReads++; if (failMetadata) throw Error('metadata offline'); return metadataTexts.get(path) ?? null; },
    readText: async (path: string) => path.endsWith('laptimes.json')
      ? indexText ?? JSON.stringify({ version: 1, files: {}, hidden: [] }) : metadataTexts.get(path) ?? null
  })
}));
const { TimerRuntime } = await import('./timerRuntime');
const { CIRCUIT_PRESETS } = await import('../circuitDatabase');
afterEach(() => { failMetadata = false; metadataTexts.clear(); metadataInventory = []; indexText = null; vi.unstubAllGlobals(); });

it('読み取り途中・適用後とも、選択が使えなくなったら基準とセクターを外す', async () => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', new EventTarget());
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
  available = true;
  const setAvailable = (value: boolean) => {
    available = value;
    listeners.forEach(listener => listener());
  };
  const choice: LapReferenceChoice = {
    ref: { timeSec: 30, trace: [0, 0, 100, 30], sectorsSec: [12, 18], startMs: 100 },
    tag: ['選択', 'Choice']
  };
  const rt = new TimerRuntime({ replayLogs: () => [], phoneMessages: () => ({ unavailable: '', denied: '' }) }, 'replay');
  rt.start();
  try {
    rt.chooseCourse(CIRCUIT_PRESETS.find(c => c.controlLine)!);
    let resolve!: (result: LapReferenceChoice) => void;
    load.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    rt.setReference(source.id);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    setAvailable(false);
    expect(rt.getSnapshot().refSources.map(r => r.id)).toEqual(['car-best']);
    expect(rt.getSnapshot().refId).toBe('car-best');
    resolve(choice);
    await new Promise(done => setTimeout(done, 0));
    expect(rt.getSnapshot().pastBest).toBeNull();
    expect(rt.getSnapshot().lap?.reference).toBeNull();
    load.mockResolvedValue(choice);
    setAvailable(true);
    await vi.waitFor(() => expect(rt.getSnapshot().lap?.reference?.pastStartMs).toBe(100));
    expect(rt.getSnapshot().refId).toBe(source.id);
    expect(storage.get('ds_timer_ref')).toBe(source.id);
    setAvailable(false);
    expect(rt.getSnapshot().refId).toBe('car-best');
    expect(rt.getSnapshot().pastBest).toBeNull();
    expect(rt.getSnapshot().lap?.referenceSectorsSec).toEqual([]);
    rt.setReference(source.id);
    expect(rt.getSnapshot().refId).toBe('car-best');
    rt.setReference('car-best');
    setAvailable(true);
    expect(rt.getSnapshot().refId).toBe('car-best');
    expect(storage.get('ds_timer_ref')).toBe('car-best');
    load.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    rt.setReference(source.id);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    // 読み取り中に選択が消え、先に答えが届いた場合にも一致を確かめる。
    available = false;
    resolve(choice);
    await vi.waitFor(() => expect(rt.getSnapshot().refId).toBe('car-best'));
    expect(rt.getSnapshot().pastBest).toBeNull();
  } finally {
    rt.dispose();
  }
  expect(listeners.size).toBe(0);
});

it('新しい比較基準を待っている間に完走した周の表示を、基準の適用時に閉じる', async () => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  available = true;
  load.mockReset();
  let finish!: (value: LapReferenceChoice) => void;
  load.mockReturnValueOnce(new Promise(done => { finish = done; }));
  const rt = new TimerRuntime({ replayLogs: () => [], phoneMessages: () => ({ unavailable: '', denied: '' }) }, 'replay');
  rt.start();
  try {
    rt.chooseCourse({
      ...CIRCUIT_PRESETS[0], id: 'test-loop', name: 'test-loop', centerLat: 35, centerLon: 140, sectors: [],
      controlLine: { name: 'start', latA: 35, lonA: 140.0003, latB: 35, lonB: 140.002 }
    }, { manual: true });
    rt.setReference(source.id);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    // 40 秒で一周。計測線を同じ向きに二度横切る。
    for (let i = 0; i <= 50; i++) {
      const angle = (i - 2.5) * 2 * Math.PI / 40;
      rt.handleFix({ valid: true, tMs: 100_000 + i * 1000, latitude: 35 + 0.001 * Math.sin(angle),
        longitude: 140 + 0.001 * Math.cos(angle), speedKmh: 60 });
    }
    const lap = rt.getSnapshot().flash?.event.lap;
    expect(lap?.timeSec).toBeCloseTo(40);
    finish({ ref: { timeSec: 30, trace: [0, 0, 100, 30], sectorsSec: [], startMs: 1 }, tag: ['選択', 'Choice'] });
    await vi.waitFor(() => expect(rt.getSnapshot().pastBest?.time).toBe(30));
    expect(rt.getSnapshot().flash).toBeNull();
    expect(rt.getSnapshot().lap?.laps[0]).toBe(lap);
  } finally { rt.dispose(); }
});

it('利用可否の判定と変更の通知は組で指定する', () => {
  type Fixed = Pick<LapReferenceSource, 'id' | 'label' | 'load'>;
  expectTypeOf<Fixed>().toExtend<LapReferenceSource>();
  expectTypeOf<Fixed & { available(): boolean }>().not.toExtend<LapReferenceSource>();
  expectTypeOf<Fixed & { subscribeAvailability(listener: () => void): () => void }>().not.toExtend<LapReferenceSource>();
});


it('選択メタデータが読めない間は比較基準を読み込まない', async () => {
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  failMetadata = true; strictMetadataReads = 0; available = true; load.mockReset();
  const rt = new TimerRuntime({ replayLogs: () => [], phoneMessages: () => ({ unavailable: '', denied: '' }) }, 'replay');
  rt.start();
  try {
    rt.chooseCourse(CIRCUIT_PRESETS.find(c => c.controlLine)!); rt.setReference(source.id);
    await vi.waitFor(() => expect(strictMetadataReads).toBeGreaterThan(0));
    await new Promise(done => setTimeout(done, 0));
    expect(load).not.toHaveBeenCalled(); expect(rt.getSnapshot().pastBest).toBeNull();
  } finally { rt.dispose(); }
});


it('ライブラリを先に開かなくても、競合した控えの新しい除外を使う', async () => {
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  available = true; load.mockReset(); load.mockResolvedValue(null);
  const course = CIRCUIT_PRESETS.find(c => c.id === 'sodegaura')!, file = 'skip.nmea', startMs = 1_800_000_000_000;
  indexText = JSON.stringify({ version: 1, files: { [file]: { size: 100, mtimeMs: 1, startMs, laps: [{ n: 1, time: 90, startMs, sectors: [], topSpeed: 100 }] } }, hidden: [] });
  const saved = (include: boolean, updatedAt: string) => JSON.stringify({ version: 2, runs: { skip: { id: 'same', updatedAt, libraryDecision: { file, size: 100, mtimeMs: 1, include } } } });
  metadataTexts.set('sodegaura/runs.json', saved(true, '2026-11-01'));
  metadataTexts.set('sodegaura/runs 2.json', saved(false, '2026-11-02'));
  metadataInventory = [{ path: 'sodegaura/skip.nmea', size: 100, mtimeMs: 1, local: true }, { path: 'sodegaura/runs 2.json', size: 100, mtimeMs: 1, local: true }];
  const rt = new TimerRuntime({ replayLogs: () => [], phoneMessages: () => ({ unavailable: '', denied: '' }) }, 'replay');
  rt.start();
  try {
    rt.chooseCourse(course); rt.setReference(source.id);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(load.mock.calls[0][0].ownLaps).toEqual([]);
    expect(rt.getSnapshot().pastBest).toBeNull();
  } finally { rt.dispose(); }
});
