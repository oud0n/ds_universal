import { tr } from '../utils/i18n';
import type { RunStore } from './runStore';

// 保管場所そのものの世代と、選択画面の間の I/O の寿命は別にする。
let revision = 0;
let readRevision = 0;
let selecting = false;
let selectionLocked = false;
const listeners = new Set<() => void>();
const beforeSelection = new Set<() => Promise<void>>();
export const getStorageRevision = () => revision;
export const getStorageReadRevision = () => readRevision;
export const isStorageSelectionPending = () => selecting;
export function subscribeStorageRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function subscribeBeforeStorageSelection(listener: () => Promise<void>): () => void {
  beforeSelection.add(listener);
  return () => { beforeSelection.delete(listener); };
}
export function invalidateStorageReads(): void {
  readRevision++;
  for (const listener of listeners) listener();
}
export function invalidateStorageRevision(): void {
  revision++;
  invalidateStorageReads();
}

/** 未保存の同期を旧保存先へ書いてから選択する。取消では保存先の所有を外さない。 */
export async function trackStorageSelection<T>(pick: () => T | Promise<T>, changed: (value: T) => boolean = (value: T) => value !== null && value !== undefined): Promise<T> {
  if (selectionLocked) throw new Error(tr('保管場所を選択中です。', 'Storage selection is already in progress.'));
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
export function pickDesktopStorage(api: { getFolder: () => Promise<string | null>; pickFolder: () => Promise<string | null> } | undefined): Promise<string | null> {
  if (!api) return Promise.resolve(null);
  let before: string | null = null;
  return trackStorageSelection(async () => { before = await api.getFolder(); return api.pickFolder(); }, next => next !== null && next !== before);
}

/** 変更後の呼び出しと遅れた応答を拒む。ホストにすでに渡した書き込みは完了することがある。 */
export function revisionBoundStore(store: RunStore, bound = getStorageRevision()): RunStore {
  const changed = () => new Error(tr('走行の保管場所が変わりました。', 'The run folder changed.'));
  function check() {
    if (bound !== revision || selecting) throw changed();
  }
  function guard<A extends unknown[], T>(operation: (...args: A) => Promise<T>) {
    return async (...args: A) => {
      check();
      const started = readRevision;
      const value = await operation(...args);
      check();
      if (started !== readRevision) throw changed();
      return value;
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
