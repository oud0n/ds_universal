/**
 * ブラウザの中のファイル置き場 (OPFS) のファイルに、裏の作業で書く (exportSink.ts)。
 * Safari・iPhone の WebKit は、画面の側から少しずつ書く口 (createWritable) を持たないので、
 * 裏の作業でだけ使える createSyncAccessHandle で書く
 */

interface SyncHandle {
  write: (data: Uint8Array, options?: { at?: number }) => number;
  flush: () => void;
  close: () => void;
}

let handle: SyncHandle | null = null;
let end = 0;

self.onmessage = async (e: MessageEvent<{ id: number; op: string; name?: string; position?: number; data?: Uint8Array }>) => {
  const { id, op, name, position, data } = e.data;
  try {
    if (op === 'open') {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(name!, { create: true });
      handle = await (file as FileSystemFileHandle & { createSyncAccessHandle: () => Promise<SyncHandle> }).createSyncAccessHandle();
      end = 0;
    } else if (op === 'write' && handle && data) {
      // 位置の指定がなければ、後ろに足す
      const at = position ?? end;
      handle.write(data, { at });
      end = Math.max(end, at + data.byteLength);
    } else if (op === 'close' && handle) {
      handle.flush();
      handle.close();
      handle = null;
    } else if (op === 'abort') {
      handle?.close();
      handle = null;
    }
    (self as unknown as Worker).postMessage({ id, ok: true });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) });
  }
};
