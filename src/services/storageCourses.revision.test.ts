import { describe, expect, it, vi } from 'vitest';
import { getStorageRevision, invalidateStorageRevision, subscribeStorageRevision, trackStorageSelection, loadStorageCourses, subscribeStorageCourses } from './storageCourses';
import { getStorageReadRevision, invalidateStorageReads, isStorageSelectionPending, subscribeBeforeStorageSelection, pickDesktopStorage, revisionBoundStore, StorageChangedError } from './storageRevision';
import type { RunStore } from './runStore';
import * as storeModule from './runStore';
import { userCircuitStorage } from './userCircuitStorage';
import { LAP_INDEX_CHECKPOINT, reconcileFolder } from './lapIndex';
import { loadLapHistory } from './lapHistory';

describe('保管場所の切り替え', () => {
  it('選択画面で取消しても保存先の世代は変わらず、読込みだけを無効にする', async () => {
    const before = getStorageRevision(), reads = getStorageReadRevision();
    const seen: number[] = [];
    const stop = subscribeStorageRevision(() => seen.push(getStorageReadRevision()));
    let cancel!: (result: null) => void;
    const selection = trackStorageSelection(() => new Promise<null>(resolve => { cancel = resolve; }));
    await Promise.resolve();
    expect(isStorageSelectionPending()).toBe(true);
    expect(getStorageRevision()).toBe(before);
    cancel(null); await selection;
    expect(getStorageRevision()).toBe(before);
    expect(getStorageReadRevision()).toBe(reads + 2);
    expect(isStorageSelectionPending()).toBe(false);
    stop();
    expect(seen).toEqual([reads + 1, reads + 2]);
  });

  it('選択が失敗しても保存先と未保存の所有者を変更しない', async () => {
    const before = getStorageRevision();
    await expect(trackStorageSelection(() => Promise.reject(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(getStorageRevision()).toBe(before);
    expect(isStorageSelectionPending()).toBe(false);
  });

  it('旧保存先への書込みが終わってから選び、失敗なら選択画面を開かない', async () => {
    const events: string[] = [];
    let saved!: () => void;
    const stop = subscribeBeforeStorageSelection(() => new Promise<void>(resolve => { saved = () => { events.push('saved'); resolve(); }; }));
    const pick = vi.fn(() => { events.push('pick'); return 'new-root'; });
    const before = getStorageRevision();
    const selection = trackStorageSelection(pick);
    expect(pick).not.toHaveBeenCalled();
    saved(); await selection; stop();
    expect(events).toEqual(['saved', 'pick']);
    expect(getStorageRevision()).toBe(before + 1);
    const fail = subscribeBeforeStorageSelection(async () => { throw new Error('disk full'); });
    const never = vi.fn();
    await expect(trackStorageSelection(never)).rejects.toThrow('disk full');
    expect(never).not.toHaveBeenCalled(); fail();
    expect(getStorageRevision()).toBe(before + 1);
  });

  it('同じデスクトップの道を選び直しても所有者を外さない', async () => {
    const before = getStorageRevision();
    await expect(pickDesktopStorage({ getFolder: async () => '/same/root', pickFolder: async () => '/same/root' })).resolves.toBe('/same/root');
    expect(getStorageRevision()).toBe(before);
  });

  it('古い窓口ではホストに書き込まず、先に渡した読み取りの返事も採用しない', async () => {
    let complete!: (data: Uint8Array) => void;
    const write = vi.fn(async () => {});
    const readRange = vi.fn(async () => new ArrayBuffer(0));
    const raw: RunStore = {
      list: async () => [], listAll: async () => [], read: () => new Promise(resolve => { complete = resolve; }),
      readText: async () => null, readTextStrict: async () => null, writeText: write, videoUrl: path => path,
      startDownload: async () => {}, fileStatus: async () => ({ local: true, downloading: false }),
      supportsVideos: async () => true, rangeReader: () => readRange
    };
    const old = revisionBoundStore(raw);
    const inFlight = old.read('file.bon4');
    const range = old.rangeReader!('clip.mp4')!;
    invalidateStorageRevision();
    complete(new Uint8Array([1]));
    await expect(inFlight).rejects.toThrow();
    await expect(old.writeText('runs.json', '{}')).rejects.toThrow();
    await expect(range(0, 100)).rejects.toThrow();
    await expect(old.rangeReader!('clip.mp4')!(0, 100)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(readRange).not.toHaveBeenCalled();
    expect(old.videoUrl('clip.mp4')).toBe('about:blank');
    await revisionBoundStore(raw).writeText('runs.json', '{}');
    expect(write).toHaveBeenCalledOnce();
  });

  it.each(['bon4', 'nmea'])('読込み中断を .%s の周なしとして保存せず、次の走査で再計算できる', async extension => {
    let complete!: (data: Uint8Array) => void;
    const file = { path: `sodegaura/good.${extension}`, size: 1, mtimeMs: 1, local: true };
    const raw: RunStore = {
      list: async () => [file], listAll: async () => [file], read: () => new Promise(resolve => { complete = resolve; }),
      readText: async () => null, readTextStrict: async () => null, writeText: vi.fn(async () => {}), videoUrl: path => path,
      startDownload: async () => {}, fileStatus: async () => ({ local: true, downloading: false }), supportsVideos: async () => true
    };
    const store = revisionBoundStore(raw);
    const scan = loadLapHistory(store);
    const rejected = expect(scan).rejects.toThrow(/保管場所|run folder/);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    invalidateStorageReads(); complete(new Uint8Array([1]));
    await rejected;
    expect(raw.writeText).not.toHaveBeenCalled();
    const course = { name: 'test', controlLine: { name: 'line', latA: 35, lonA: 140, latB: 36, lonB: 140 }, sectors: [] };
    const compute = vi.fn(() => ({ startMs: 1000, laps: [{ n: 1, time: 90, startMs: 1000, sectors: [], topSpeed: 100 }] }));
    const next = reconcileFolder('sodegaura', [file], course, null, p => store.read(p), compute);
    complete(new Uint8Array([1]));
    const result = await next;
    expect(compute).toHaveBeenCalledOnce();
    expect(result.index.files[`good.${extension}`].laps).toHaveLength(1);
  });


  it('途中の控え保存が中断したら、後の走行の走査も採用もしない', async () => {
    const files = Array.from({ length: LAP_INDEX_CHECKPOINT + 1 }, (_, i) => ({ path: `test/${i}.bon4`, size: 1, mtimeMs: 1 }));
    const compute = vi.fn(() => ({ startMs: null, laps: [] }));
    const course = { name: 'test', controlLine: { name: 'line', latA: 35, lonA: 140, latB: 36, lonB: 140 }, sectors: [] };
    await expect(reconcileFolder('test', files, course, null, async () => new Uint8Array(), compute,
      async () => { throw new StorageChangedError(); })).rejects.toBeInstanceOf(StorageChangedError);
    expect(compute).toHaveBeenCalledTimes(LAP_INDEX_CHECKPOINT);
  });

  it.each([false, true])('控えの最終保存で中断=%s。通常の保存失敗は一覧を表示でき、中断は返さない', async interrupted => {
    const store = {
      list: async () => [{ path: 'sodegaura/empty.bon4', size: 0, mtimeMs: 1 }],
      read: async () => new Uint8Array(), readText: async () => null,
      writeText: vi.fn(async () => { throw interrupted ? new StorageChangedError() : new Error('disk full'); })
    };
    const scan = loadLapHistory(store);
    if (interrupted) await expect(scan).rejects.toBeInstanceOf(StorageChangedError);
    else await expect(scan).resolves.toHaveLength(1);
    expect(store.writeText).toHaveBeenCalledOnce();
  });


  it.each([false, true])('取消がコース応答より先=%s でも、古い結果を採用せず自動で読み直す', async cancelFirst => {
    const replies: Array<(data: Uint8Array) => void> = [];
    const raw: RunStore = {
      list: async () => [], listAll: async () => [{ path: 'course/ControlLine/test.cln', size: 1, mtimeMs: 1, local: true }],
      read: () => new Promise(resolve => { replies.push(resolve); }), readText: async () => null, readTextStrict: async () => null,
      writeText: async () => {}, videoUrl: path => path, startDownload: async () => {},
      fileStatus: async () => ({ local: true, downloading: false }), supportsVideos: async () => true
    };
    invalidateStorageReads();
    vi.spyOn(storeModule, 'canUseRunStore').mockReturnValue(true);
    vi.spyOn(storeModule, 'getRunStore').mockResolvedValue(revisionBoundStore(raw));
    vi.spyOn(userCircuitStorage, 'setSyncedEdited').mockResolvedValue();
    const apply = vi.spyOn(userCircuitStorage, 'setStorageCourseFiles');
    const completed = vi.fn(); const stop = subscribeStorageCourses(completed);
    try {
      const scan = loadStorageCourses();
      expect(loadStorageCourses()).toBe(scan);
      const rejected = expect(scan).rejects.toBeInstanceOf(StorageChangedError);
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      let cancel!: (value: null) => void;
      const selection = trackStorageSelection(() => new Promise<null>(resolve => { cancel = resolve; }));
      await vi.waitFor(() => expect(isStorageSelectionPending()).toBe(true));
      if (cancelFirst) { cancel(null); await selection; }
      replies[0](new Uint8Array([1])); await rejected;
      expect(apply).not.toHaveBeenCalled();
      if (!cancelFirst) { cancel(null); await selection; }
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(apply).not.toHaveBeenCalled();
      replies[1](new Uint8Array([2]));
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
      expect(apply).toHaveBeenCalledOnce();
      expect(apply.mock.calls[0][0]).toEqual([{ path: 'course/ControlLine/test.cln', text: String.fromCharCode(2) }]);
    } finally { stop(); vi.restoreAllMocks(); }
  });

  it('コース保持側の非同期待ちが終わった直後にも、採用可能か検査する', async () => {
    await userCircuitStorage.ready;
    const before = userCircuitStorage.getAllCircuits();
    const reject = () => { throw new StorageChangedError(); };
    await expect(userCircuitStorage.setStorageCourseFiles([], reject)).rejects.toBeInstanceOf(StorageChangedError);
    await expect(userCircuitStorage.setSyncedEdited([], reject)).rejects.toBeInstanceOf(StorageChangedError);
    expect(userCircuitStorage.getAllCircuits()).toEqual(before);
  });

});
