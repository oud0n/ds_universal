import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunStore } from './runStore';
import type { CsvFormat } from './csvFormats';
import { getStorageRevision, invalidateStorageRevision, revisionBoundStore, StorageChangedError, trackStorageSelection, isStorageSelectionPending } from './storageRevision';
import { currentCsvFormats, deleteCsvFormat, loadCsvFormats, saveCalcChannels, saveCsvFormat } from './csvFormatStore';

let raw: RunStore;
vi.mock('./runStore', () => ({ canUseRunStore: () => true, getRunStore: async () => revisionBoundStore(raw) }));
const format = (name: string): CsvFormat => ({ version: 1, id: 'user:sample', name, kind: 'sensor', sensorKey: 'sample', header: ['v'], headerRow: 0, delimiter: ',', time: null, columns: { v: { target: 'throttle' } } });
const channels = (label: string) => [{ key: 'test_value', label, expr: 'speed' }];
function memory(name: string) {
  const files = new Map([
    ['formats/sample.csvformat.json', JSON.stringify(format(name))],
    ['formats/calc.json', JSON.stringify({ version: 1, channels: channels(name) })]
  ]);
  const store: RunStore = {
    list: async () => [], listAll: async () => [...files].map(([path, text]) => ({ path, size: text.length, mtimeMs: 1, local: true })),
    read: async () => new Uint8Array(), readText: async path => files.get(path) ?? null,
    readTextStrict: async path => files.get(path) ?? null,
    writeText: vi.fn(async (path, text) => { files.set(path, text); }),
    videoUrl: path => path, startDownload: async () => {}, fileStatus: async () => ({ local: true, downloading: false }), supportsVideos: async () => true
  };
  return { store, files };
}
async function switchTo(store: RunStore) { raw = store; invalidateStorageRevision(); await loadCsvFormats(); }
beforeEach(async () => { await switchTo(memory('A').store); });
afterEach(async () => { await switchTo(memory('cleanup').store); });

describe('定義と計算式の保存先・読込み期間', () => {
  it('新保存先を確認する前や旧保存先の編集から、計算式を上書きしない', async () => {
    const oldRoot = getStorageRevision();
    const next = memory('B');
    let resume!: () => void;
    const list = next.store.listAll;
    next.store.listAll = async () => { await new Promise<void>(resolve => { resume = resolve; }); return list(); };
    raw = next.store; invalidateStorageRevision();
    const load = loadCsvFormats();
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    expect(currentCsvFormats()).toEqual([]);
    await expect(saveCalcChannels(channels('A'), oldRoot)).rejects.toBeInstanceOf(StorageChangedError);
    await expect(saveCalcChannels(channels('A'))).rejects.toThrow();
    expect(next.store.writeText).not.toHaveBeenCalled();
    resume(); await load;
    expect(currentCsvFormats()[0].name).toBe('B');
    expect(JSON.parse(next.files.get('formats/calc.json')!).channels).toEqual(channels('B'));
  });

  it.each([false, true])('取消が応答より先=%s でも、部分的な定義を出さず再読込みする', async cancelFirst => {
    const next = memory('B'); raw = next.store;
    const read = raw.readTextStrict;
    let resume!: () => void, hold = true;
    raw.readTextStrict = async path => {
      if (hold && path.endsWith('.csvformat.json')) await new Promise<void>(resolve => { resume = resolve; });
      return read(path);
    };
    const load = loadCsvFormats(1);
    const rejected = expect(load).rejects.toBeInstanceOf(StorageChangedError);
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    let cancel!: (value: null) => void;
    const selection = trackStorageSelection(() => new Promise<null>(resolve => { cancel = resolve; }));
    await vi.waitFor(() => expect(isStorageSelectionPending()).toBe(true));
    if (cancelFirst) { cancel(null); await selection; }
    hold = false; resume(); await rejected;
    if (!cancelFirst) { cancel(null); await selection; }
    await vi.waitFor(() => expect(currentCsvFormats()[0]?.name).toBe('B'));
    expect(raw.writeText).not.toHaveBeenCalled();
  });

  it.each(['format', 'calc', 'delete'])('%s 保存中の保存先変更で、完了した旧書込みを新しい表示へ戻さない', async kind => {
    const previous = memory('A'); await switchTo(previous.store);
    const root = getStorageRevision();
    let resume!: () => void;
    const write = raw.writeText;
    raw.writeText = async (path, text) => { await new Promise<void>(resolve => { resume = resolve; }); await write(path, text); };
    const save = kind === 'format' ? saveCsvFormat(format('edited A'), undefined, root)
      : kind === 'calc' ? saveCalcChannels(channels('edited A'), root) : deleteCsvFormat('user:sample', root);
    const rejected = expect(save).rejects.toBeInstanceOf(StorageChangedError);
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    const next = memory('B'); await switchTo(next.store);
    resume(); await rejected;
    expect(currentCsvFormats()[0].name).toBe('B');
    expect(next.store.writeText).not.toHaveBeenCalled();
    expect(JSON.parse(next.files.get('formats/calc.json')!).channels).toEqual(channels('B'));
  });

  it('計算式を読めない間は、前の控えで保存せず、回復後に確認した内容だけ保存できる', async () => {
    const next = memory('B');
    let fail = true;
    const read = next.store.readTextStrict;
    next.store.readTextStrict = async path => { if (fail && path === 'formats/calc.json') throw new Error('offline'); return read(path); };
    await switchTo(next.store);
    await expect(saveCalcChannels(channels('A'))).rejects.toThrow();
    expect(next.store.writeText).not.toHaveBeenCalled();
    fail = false; await loadCsvFormats(1);
    await saveCalcChannels(channels('reviewed B'));
    expect(JSON.parse(next.files.get('formats/calc.json')!).channels).toEqual(channels('reviewed B'));
  });

  it('先に始めた再読込みは、後から保存した定義を戻さない', async () => {
    const oldRead = raw.readTextStrict;
    const oldText = JSON.stringify(format('old A'));
    let resume!: () => void;
    raw.readTextStrict = async path => path.endsWith('.csvformat.json') ? new Promise<string>(resolve => { resume = () => resolve(oldText); }) : oldRead(path);
    const load = loadCsvFormats(1);
    const rejected = expect(load).rejects.toBeInstanceOf(StorageChangedError);
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    await saveCsvFormat(format('new A'), 'user:sample');
    resume(); await rejected;
    expect(currentCsvFormats()[0].name).toBe('new A');
  });
});
