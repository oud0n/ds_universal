import { beforeEach, describe, expect, it, vi } from 'vitest';

// ネイティブの窓口のふり。camera.permission はこちらが返すまで待たせる
const calls: string[] = [];
let releasePermission: (() => void) | null = null;
vi.mock('../../native/bridge', () => ({
  hasNative: () => true,
  nativeCapabilities: async () => ({ features: { camera: true } }),
  callNative: async (method: string) => {
    calls.push(method);
    if (method === 'camera.permission') {
      await new Promise<void>(r => { releasePermission = r; });
      return { camera: 'granted', mic: 'granted' };
    }
    if (method === 'camera.stop') return { files: [] };
    return {};
  }
}));
vi.mock('../runStore', () => ({ getRunStore: async () => null }));

// 設定は localStorage から読む (試験の環境には無いので、ふりを置く)
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });

const { PhoneCameraRecorder } = await import('./phoneCamera');
const flush = () => new Promise(r => setTimeout(r, 0));

describe('内蔵カメラの録画 (区切り直し・熱)', () => {
  beforeEach(() => {
    calls.length = 0;
    releasePermission = null;
    localStorage.setItem('ds_timer_camera', JSON.stringify({ enabled: true }));
  });

  it('始める途中で区切り直すと、前の始めが終わってから新しい走行の録画を始める (BUG-38 の 9)', async () => {
    const rec = new PhoneCameraRecorder(() => {});
    void rec.start();
    await flush();
    void rec.stop('a/b', 'unsorted');
    void rec.start();
    releasePermission?.();
    await flush(); await flush();
    // 1 回目の許可のあと止められたので撮らず、2 回目の許可を聞く
    expect(calls.filter(c => c === 'camera.permission').length).toBe(2);
    releasePermission?.();
    await flush(); await flush();
    expect(calls).toContain('camera.start');
    expect(rec.status.recording).toBe(true);
  });

  it('熱で止めたあとは、冷めるまで区切り直しでも撮り始めない (BUG-38 の 8)', async () => {
    const rec = new PhoneCameraRecorder(() => {});
    rec.noteState(false, 'thermal', 'critical');
    await rec.start();
    expect(calls).not.toContain('camera.permission');
    expect(rec.status.error).toBe('thermal');
    rec.noteState(false, undefined, 'fair');
    void rec.start();
    await flush();
    expect(calls).toContain('camera.permission');
  });
});
