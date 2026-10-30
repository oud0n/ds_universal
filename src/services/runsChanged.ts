/** 保管場所の走行が増えた・変わったことの知らせ (走行の一覧が読み直す)。画面の部品とサービスの両方から使う */
const listeners = new Set<() => void>();

export function notifyRunsChanged(): void {
  listeners.forEach(f => f());
}

export function onRunsChanged(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}
