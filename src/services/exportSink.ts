/**
 * 書き出しの行き先 (2026-10-20)。長い書き出しで、できたファイルを全部メモリに持たないようにする。
 *
 * ブラウザの中のファイル置き場 (OPFS、navigator.storage.getDirectory) に少しずつ書き、終わったらそのファイルをダウンロードする。
 * ファイルはディスクにあるので、20 分の 1080p (1 GB を超える) でもメモリを使い切らない (iPhone で落ちないように)。
 * - 書き方は 2 つ: createWritable (Chrome・Edge・Electron など) と、それがないブラウザ (Safari・iPhone の WebKit) では
 *   裏の作業 (Worker) の createSyncAccessHandle。どちらもないブラウザ・プライベートブラウズでは、これまでどおりメモリに持つ
 * - 置き場のファイルは、ダウンロードが読み終わるだけの時間をおいて消す。消し損ねたもの (取り消した・失敗した・ページを閉じた) は、
 *   次の書き出しの始めに消す (今書いている・ダウンロード中のものは残す)
 * URL の ?opfs=worker で、Worker の書き方を試せる
 */

import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from 'mediabunny';

const PREFIX = 'laploupe-export-';
/** 置き場のファイルを残す最短の時間 (ミリ秒)。ダウンロードがファイルを読み終える前に消さないように */
const KEEP_MIN_MS = 5 * 60 * 1000;

/** 今書いている・ダウンロード中の置き場のファイルと、いつまで残すか (このページを開いている間だけ覚える) */
const keepUntil = new Map<string, number>();

/** ダウンロードに渡したファイルを読み終えるまでの見込み (ミリ秒)。ディスクからの写しを 1 秒に 10 MB と遅めに見る */
export function downloadReadMs(bytes: number): number {
  return Math.max(10_000, bytes / 10_000);
}

/** 置き場のファイルに書く口 (書き方によらず同じ) */
interface DiskWriter {
  writeAt: (position: number, data: Uint8Array) => Promise<void>;
  append: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
}

interface DiskFile {
  root: FileSystemDirectoryHandle;
  name: string;
  handle: FileSystemFileHandle;
  writer: DiskWriter;
}

const forceWorker = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('opfs') === 'worker';

/** createWritable で書く (Chrome・Edge・Electron) */
async function writableWriter(handle: FileSystemFileHandle): Promise<DiskWriter | null> {
  const h = handle as FileSystemFileHandle & { createWritable?: () => Promise<FileSystemWritableFileStream> };
  if (forceWorker || typeof h.createWritable !== 'function') return null;
  const w = await h.createWritable();
  let appendAt = 0;
  return {
    writeAt: (position, data) => w.write({ type: 'write', position, data: data as unknown as BufferSource }),
    append: async data => {
      await w.write({ type: 'write', position: appendAt, data: data as unknown as BufferSource });
      appendAt += data.byteLength;
    },
    close: () => w.close(),
    abort: () => w.abort()
  };
}

/** 裏の作業 (Worker) の createSyncAccessHandle で書く (Safari・iPhone の WebKit) */
async function workerWriter(name: string): Promise<DiskWriter | null> {
  if (typeof Worker === 'undefined') return null;
  const worker = new Worker(new URL('./opfsWriter.worker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.ok) w.resolve();
    else w.reject(new Error(e.data.error ?? 'OPFS の書き込みに失敗しました'));
  };
  const call = (msg: { op: string; name?: string; position?: number; data?: Uint8Array }) => new Promise<void>((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    // 書き出しの部品が同じメモリを使い回すことがあるので、写して渡す
    const data = msg.data ? msg.data.slice() : undefined;
    worker.postMessage({ ...msg, id, data }, data ? [data.buffer] : []);
  });
  try {
    await call({ op: 'open', name });
  } catch {
    worker.terminate();
    return null;
  }
  return {
    writeAt: (position, data) => call({ op: 'write', position, data }),
    append: data => call({ op: 'write', data }),
    close: async () => { await call({ op: 'close' }); worker.terminate(); },
    abort: async () => { await call({ op: 'abort' }).catch(() => {}); worker.terminate(); }
  };
}

/** 置き場のファイルを作る。書けないときは null (メモリに持つ) */
async function openDiskFile(): Promise<DiskFile | null> {
  let root: FileSystemDirectoryHandle | null = null;
  let name = '';
  try {
    const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    if (typeof storage?.getDirectory !== 'function') return null;
    root = await storage.getDirectory();
    await removeLeftovers(root);
    name = `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    keepUntil.set(name, Infinity);
    const handle = await root.getFileHandle(name, { create: true });
    const writer = (await writableWriter(handle)) ?? (await workerWriter(name));
    if (!writer) throw new Error('no writer');
    return { root, name, handle, writer };
  } catch {
    // 作りかけのファイルを残さない
    if (root && name) {
      keepUntil.delete(name);
      await root.removeEntry(name).catch(() => {});
    }
    return null;
  }
}

/** 前の書き出しの残り (消し損ねたもの) を消す。今書いている・ダウンロード中のものは残す */
async function removeLeftovers(root: FileSystemDirectoryHandle): Promise<void> {
  try {
    const dir = root as FileSystemDirectoryHandle & { keys?: () => AsyncIterableIterator<string> };
    if (typeof dir.keys !== 'function') return;
    const now = Date.now();
    const old: string[] = [];
    for await (const key of dir.keys()) {
      if (!key.startsWith(PREFIX)) continue;
      const keep = keepUntil.get(key);
      if (keep === undefined || keep < now) old.push(key);
    }
    await Promise.all(old.map(k => root.removeEntry(k).then(() => { keepUntil.delete(k); }, () => {})));
  } catch {
    // 消せなくても書き出しはできる
  }
}

/** 書き終えたファイルを、ダウンロードが読み終わるだけの時間をおいて消す */
function scheduleRemove(file: DiskFile, bytes: number): void {
  const ms = Math.max(KEEP_MIN_MS, downloadReadMs(bytes) * 2);
  keepUntil.set(file.name, Date.now() + ms);
  setTimeout(() => { void file.root.removeEntry(file.name).then(() => { keepUntil.delete(file.name); }, () => {}); }, ms);
}

/** 取り消した・失敗したファイルを消す (書き込み口がまだ閉じていなくて消せないときは、少しおいてもう一度) */
async function discard(file: DiskFile): Promise<void> {
  await file.writer.abort().catch(() => {});
  keepUntil.delete(file.name);
  const remove = () => file.root.removeEntry(file.name);
  await remove().catch(() => { setTimeout(() => { void remove().catch(() => {}); }, 3000); });
}

/** 動画の書き出し (mediabunny) の行き先 */
export interface VideoSink {
  target: Target;
  /** ディスクに書く (MP4 の目次は最後に書く) か、メモリに持つか */
  onDisk: boolean;
  /** 書き終えたファイル (output.finalize() のあとに呼ぶ) */
  finish: (type: string) => Promise<Blob>;
  /** 取り消したとき・失敗したとき */
  abort: () => Promise<void>;
}

export async function createVideoSink(): Promise<VideoSink> {
  const disk = await openDiskFile();
  if (disk) {
    const stream = new WritableStream<StreamTargetChunk>({
      write: chunk => disk.writer.writeAt(chunk.position, chunk.data),
      close: () => disk.writer.close()
    });
    return {
      target: new StreamTarget(stream, { chunked: true }),
      onDisk: true,
      finish: async type => {
        // StreamTarget は finalize で書き込み口を閉じる
        const file = await disk.handle.getFile();
        scheduleRemove(disk, file.size);
        // ディスクのファイルには種類が付かないので、包んで付ける (中身は写さない。共有の画面で動画として扱われるように)
        return type ? new Blob([file], { type }) : file;
      },
      abort: () => discard(disk)
    };
  }
  const target = new BufferTarget();
  return {
    target,
    onDisk: false,
    finish: async type => new Blob([target.buffer!], { type }),
    abort: async () => {}
  };
}

/** バイト列を順に書く行き先 (ZIP) */
export interface ByteSink {
  /** 書く。書き込みは順に並べ、返す Promise は、それまでの書き込みが全部終わったら解ける (待つと、メモリにためない) */
  write: (data: Uint8Array) => Promise<void>;
  finish: (type: string) => Promise<Blob>;
  abort: () => Promise<void>;
}

export async function createByteSink(): Promise<ByteSink> {
  const disk = await openDiskFile();
  if (disk) {
    let chain: Promise<void> = Promise.resolve();
    return {
      write: data => {
        chain = chain.then(() => disk.writer.append(data));
        return chain;
      },
      finish: async type => {
        await chain;
        await disk.writer.close();
        const file = await disk.handle.getFile();
        scheduleRemove(disk, file.size);
        return type ? new Blob([file], { type }) : file;
      },
      abort: () => discard(disk)
    };
  }
  const chunks: Uint8Array[] = [];
  return {
    write: async data => { chunks.push(data); },
    finish: async type => new Blob(chunks as BlobPart[], { type }),
    abort: async () => { chunks.length = 0; }
  };
}
