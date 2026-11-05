import { EngineError } from './errors';
import type { RunRepository as RunStore } from './ports';

/** 中断した読込みを、壊れたファイルや空の保管場所として覚えない。 */
export class StorageChangedError extends EngineError {
  constructor() {
    super('storage.changed', { ja: '走行の保管場所が変わりました。', en: 'The run folder changed.' });
    this.name = 'StorageChangedError';
  }
}


export function createStorageContext() {
// 保管場所そのものの世代と、選択画面の間の I/O の寿命は別にする。
let revision = 0;
let readRevision = 0;
let selecting = false;
let selectionLocked = false;
const listeners = new Set<() => void>();
const beforeSelection = new Set<() => Promise<void>>();
const getStorageRevision = () => revision;
const getStorageReadRevision = () => readRevision;
const isStorageSelectionPending = () => selecting;
function subscribeStorageRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function subscribeBeforeStorageSelection(listener: () => Promise<void>): () => void {
  beforeSelection.add(listener);
  return () => { beforeSelection.delete(listener); };
}
function invalidateStorageReads(): void {
  readRevision++;
  for (const listener of listeners) listener();
}
function invalidateStorageRevision(): void {
  revision++;
  invalidateStorageReads();
}

/** 未保存の同期を旧保存先へ書いてから選択する。取消では保存先の所有を外さない。 */
async function trackStorageSelection<T>(pick: () => T | Promise<T>, changed: (value: T) => boolean = (value: T) => value !== null && value !== undefined): Promise<T> {
  if (selectionLocked) throw new EngineError('storage.busy', { ja: '保管場所を選択中です。', en: 'Storage selection is already in progress.' });
  selectionLocked = true;
  try {
    await Promise.all([...beforeSelection].map(save => save()));
    selecting = true;
    invalidateStorageReads();
    const value = await pick();
    if (changed(value)) invalidateStorageRevision();
    return value;
  } finally {
    selecting = false;
    selectionLocked = false;
    invalidateStorageReads();
  }
}

/** デスクトップは完全な道で同じ場所かを判定できる。表示名だけでは判定しない。 */
function pickDesktopStorage(api: { getFolder: () => Promise<string | null>; pickFolder: () => Promise<string | null> } | undefined): Promise<string | null> {
  if (!api) return Promise.resolve(null);
  let before: string | null = null;
  return trackStorageSelection(async () => { before = await api.getFolder(); return api.pickFolder(); }, next => next !== null && next !== before);
}

/** 変更後の呼び出しと遅れた応答を拒む。ホストにすでに渡した書き込みは完了することがある。 */
function revisionBoundStore(store: RunStore, bound = getStorageRevision()): RunStore {
  const changed = () => new StorageChangedError();
  function check() {
    if (bound !== revision || selecting) throw changed();
  }
  function guard<A extends unknown[], T>(operation: (...args: A) => Promise<T>) {
    return async (...args: A) => {
      check();
      const started = readRevision;
      try { return await operation(...args); }
      finally {
        check();
        if (started !== readRevision) throw changed();
      }
    };
  }
  return {
    ...store,
    storageRevision: bound,
    list: guard(store.list.bind(store)),
    listAll: guard(store.listAll.bind(store)),
    read: guard(store.read.bind(store)),
    readText: guard(store.readText.bind(store)),
    readTextStrict: guard(store.readTextStrict.bind(store)),
    writeText: guard(store.writeText.bind(store)),
    startDownload: guard(store.startDownload.bind(store)),
    fileStatus: guard(store.fileStatus.bind(store)),
    supportsVideos: guard(store.supportsVideos.bind(store)),
    videoUrl: path => bound === revision ? store.videoUrl(path) : 'about:blank',
    ...(store.rangeReader && { rangeReader: (path: string) => {
      if (bound !== revision || selecting) return async () => { throw changed(); };
      const reader = store.rangeReader!(path);
      return reader && guard(reader);
    } }),
    ...(store.remove && { remove: guard(store.remove.bind(store)) }),
    ...(store.trash && { trash: {
      move: guard(store.trash.move.bind(store.trash)),
      list: guard(store.trash.list.bind(store.trash)),
      restore: guard(store.trash.restore.bind(store.trash)),
      purge: guard(store.trash.purge.bind(store.trash))
    } })
  };
}

return { getStorageRevision, getStorageReadRevision, isStorageSelectionPending, subscribeStorageRevision, subscribeBeforeStorageSelection, invalidateStorageReads, invalidateStorageRevision, trackStorageSelection, pickDesktopStorage, revisionBoundStore };
}
export type StorageContext = ReturnType<typeof createStorageContext>;
