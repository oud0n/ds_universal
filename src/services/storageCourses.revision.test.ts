import { describe, expect, it, vi } from 'vitest';
import { getStorageRevision, invalidateStorageRevision, subscribeStorageRevision, trackStorageSelection } from './storageCourses';
import { getStorageReadRevision, isStorageSelectionPending, subscribeBeforeStorageSelection, pickDesktopStorage, revisionBoundStore } from './storageRevision';
import type { RunStore } from './runStore';

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
});
