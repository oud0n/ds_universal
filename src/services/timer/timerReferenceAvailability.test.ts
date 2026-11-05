import { afterEach, expect, it, vi } from 'vitest';
import type { LapReferenceChoice, LapReferenceSource } from './lapReferences';

const source: LapReferenceSource = {
  id: 'test-choice', label: ['選択', 'Choice'],
  available: () => available,
  subscribeAvailability: listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  load: () => load()
};
const listeners = new Set<() => void>();
let available = true;
const load = vi.fn<() => Promise<LapReferenceChoice | null>>();
vi.mock('../../addons', () => ({ addons: { get lapReferences() { return [source]; } } }));
vi.mock('../../native/bridge', () => ({
  hasNative: () => true, callNative: async () => ({}), onNative: () => () => {}, toBase64: () => ''
}));
vi.mock('../runStore', async importOriginal => ({
  ...await importOriginal<object>(),
  getRunStore: async () => ({
    readText: async (path: string) => path.endsWith('laptimes.json')
      ? JSON.stringify({ version: 1, files: {}, hidden: [] }) : null
  })
}));
const { TimerRuntime } = await import('./timerRuntime');
const { CIRCUIT_PRESETS } = await import('../circuitDatabase');
afterEach(() => { vi.unstubAllGlobals(); });

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
    setAvailable(true);
    load.mockResolvedValue(choice);
    rt.setReference(source.id);
    await vi.waitFor(() => expect(rt.getSnapshot().lap?.reference?.pastStartMs).toBe(100));
    setAvailable(false);
    expect(rt.getSnapshot().refId).toBe('car-best');
    expect(rt.getSnapshot().pastBest).toBeNull();
    expect(rt.getSnapshot().lap?.referenceSectorsSec).toEqual([]);
    rt.setReference(source.id);
    expect(rt.getSnapshot().refId).toBe('car-best');
  } finally {
    rt.dispose();
  }
  expect(listeners.size).toBe(0);
});
