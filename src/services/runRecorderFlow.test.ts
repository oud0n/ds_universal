import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 偽のネイティブ (ファイル) とデータベース */
const files = new Map<string, number>();
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
vi.mock('../native/bridge', () => ({
  hasNative: () => true,
  toBase64: (b: Uint8Array) => String(b.length),
  callNative: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'system.appendFile') {
      const path = params.path as string;
      if (params.createNew && files.has(path)) throw { code: 'busy', message: 'file exists' };
      files.set(path, (params.truncate ? 0 : files.get(path) ?? 0) + 1);
    }
    return {};
  }
}));
vi.mock('./liveRunStore', () => ({
  startRun: async (meta: Record<string, unknown>) => ({ ...meta, updatedMs: 0, fixCount: 0, lapCount: 0, bestLapSec: null }),
  appendFixes: async (run: Record<string, unknown>, _seq: number, fixes: unknown[], patch: Record<string, unknown>) => ({ ...run, ...patch, fixCount: (run.fixCount as number) + fixes.length })
}));

const { LiveRunRecorder } = await import('./runRecorder');
const { runFileBase } = await import('./runFiles');

const T0 = Date.UTC(2026, 9, 24, 1, 0, 0);
/** ファイルの名前は端末の時刻なので、時差によらず同じものを求める */
const NAME = () => runFileBase(T0);
const fix = (i: number) => ({ tMs: T0 + i * 50, latitude: 35.39, longitude: 140.08, speedKmh: 50, valid: true });
const bon4Paths = () => calls.filter(c => c.method === 'system.appendFile' && (c.params.path as string).endsWith('.bon4') && c.params.truncate).map(c => c.params.path);

describe('走っている間の記録 (アプリ)', () => {
  beforeEach(() => { files.clear(); calls.length = 0; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('測位のできた点が来るまではファイルを作らず、それより前のつかめていない点は書かない (LATER-18)', async () => {
    const rec = new LiveRunRecorder('digspice', () => '袖ヶ浦', () => {}, () => 'sodegaura');
    // ほかの試験とファイルの名前 (秒まで) が重ならないよう、1 時間あとにする
    const later = (i: number) => ({ ...fix(i), tMs: fix(i).tMs + 3600_000 });
    rec.add({ ...later(0), valid: false });
    rec.add({ ...later(1), valid: false });
    await rec.flush(undefined, true);
    expect(bon4Paths()).toEqual([]);
    rec.add(later(2));
    await rec.flush(undefined, true);
    const name = runFileBase(T0 + 3600_000 + 100);
    expect(bon4Paths()).toEqual([`sodegaura/${name.slice(0, 8)}/${name}.bon4`]);
  });

  it('コースが決まったら、そのフォルダにファイルを作る', async () => {
    let course = '';
    const rec = new LiveRunRecorder('digspice', () => course, () => {}, () => (course ? 'sodegaura' : ''));
    rec.add(fix(0));
    await rec.flush();
    expect(bon4Paths()).toEqual([]);
    course = '袖ヶ浦';
    rec.add(fix(1));
    await rec.flush();
    expect(bon4Paths()).toEqual([`sodegaura/${NAME().slice(0, 8)}/${NAME()}.bon4`]);
    expect(rec.current?.fixCount).toBe(2);
  });

  it('コースを待っている途中でも、閉じるとき (force) は unsorted に保存する', async () => {
    const rec = new LiveRunRecorder('digspice', () => '', () => {}, () => '');
    for (let i = 0; i < 40; i++) rec.add(fix(i));
    await rec.flush();
    expect(rec.current).toBeNull();
    await rec.flush(undefined, true);
    expect(bon4Paths()[0]).toMatch(/^unsorted\//);
    expect(rec.current?.fixCount).toBe(40);
  });

  it('測位が途切れても、端末の時計で 15 秒たてば始める', async () => {
    const rec = new LiveRunRecorder('phone', () => '', () => {}, () => '');
    rec.add(fix(0));
    await rec.flush();
    expect(rec.current).toBeNull();
    vi.setSystemTime(T0 + 16000);
    await rec.flush();
    expect(rec.current?.fixCount).toBe(1);
  });

  it('同じ名前のファイル (前に起動したときの走行) があれば、上書きせずに _2 にする', async () => {
    files.set(`sodegaura/${NAME()}.bon4`, 5);
    const rec = new LiveRunRecorder('digspice', () => '袖ヶ浦', () => {}, () => 'sodegaura');
    rec.add(fix(0));
    await rec.flush();
    expect(files.get(`sodegaura/${NAME()}.bon4`)).toBe(5);
    expect(rec.current?.fileBase).toBe(`sodegaura/${NAME().slice(0, 8)}/${NAME()}_2`);
  });
});
