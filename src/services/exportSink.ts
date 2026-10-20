/**
 * 書き出しの行き先 (2026-10-20)。長い書き出しで、できたファイルを全部メモリに持たないようにする。
 *
 * ブラウザの中のファイル置き場 (OPFS、navigator.storage.getDirectory) に少しずつ書き、終わったらそのファイルをダウンロードする。
 * ファイルはディスクにあるので、20 分の 1080p (1 GB を超える) でもメモリを使い切らない (iPhone で落ちないように)。
 * OPFS に書けないブラウザでは、これまでどおりメモリに持つ。
 * 置き場のファイルは、ダウンロードを始めてしばらくしたら消す (前の書き出しの残りは、次の書き出しの始めに消す)
 */

import { BufferTarget, StreamTarget, type Target } from 'mediabunny';

const PREFIX = 'laploupe-export-';
/** ダウンロードを始めてから、置き場のファイルを消すまで (ミリ秒)。ダウンロードがファイルを読み終える前に消さないように */
const REMOVE_AFTER_MS = 5 * 60 * 1000;

interface DiskFile {
  root: FileSystemDirectoryHandle;
  name: string;
  handle: FileSystemFileHandle;
  writable: FileSystemWritableFileStream;
}

/** OPFS に書けるか (createWritable がないブラウザ・プライベートブラウズでは書けない) */
async function openDiskFile(): Promise<DiskFile | null> {
  try {
    const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    if (typeof storage?.getDirectory !== 'function') return null;
    const root = await storage.getDirectory();
    await removeLeftovers(root);
    const name = `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = await root.getFileHandle(name, { create: true });
    if (typeof (handle as FileSystemFileHandle & { createWritable?: unknown }).createWritable !== 'function') {
      await root.removeEntry(name).catch(() => {});
      return null;
    }
    const writable = await handle.createWritable();
    return { root, name, handle, writable };
  } catch {
    return null;
  }
}

/** 前の書き出しの残り (消し損ねたもの) を消す */
async function removeLeftovers(root: FileSystemDirectoryHandle): Promise<void> {
  try {
    const dir = root as FileSystemDirectoryHandle & { keys?: () => AsyncIterableIterator<string> };
    if (typeof dir.keys !== 'function') return;
    const old: string[] = [];
    // 名前の時刻から、ダウンロードの読み終わりを待つ時間より前のものだけ (直前の書き出しのダウンロード中のものは消さない)
    for await (const key of dir.keys()) {
      if (!key.startsWith(PREFIX)) continue;
      const at = Number(key.slice(PREFIX.length).split('-')[0]);
      if (!Number.isFinite(at) || Date.now() - at > REMOVE_AFTER_MS) old.push(key);
    }
    await Promise.all(old.map(k => root.removeEntry(k).catch(() => {})));
  } catch {
    // 消せなくても書き出しはできる
  }
}

function scheduleRemove(file: DiskFile): void {
  setTimeout(() => { void file.root.removeEntry(file.name).catch(() => {}); }, REMOVE_AFTER_MS);
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
    return {
      target: new StreamTarget(disk.writable as unknown as WritableStream, { chunked: true }),
      onDisk: true,
      finish: async () => {
        // StreamTarget は finalize で書き込み口を閉じる
        const file = await disk.handle.getFile();
        scheduleRemove(disk);
        return file;
      },
      abort: async () => {
        await disk.writable.abort().catch(() => {});
        await disk.root.removeEntry(disk.name).catch(() => {});
      }
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
  /** 書く (前の書き込みが終わるのを待つと、メモリにためない) */
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
        chain = chain.then(() => disk.writable.write(data as unknown as BufferSource));
        return chain;
      },
      finish: async () => {
        await chain;
        await disk.writable.close();
        const file = await disk.handle.getFile();
        scheduleRemove(disk);
        return file;
      },
      abort: async () => {
        await disk.writable.abort().catch(() => {});
        await disk.root.removeEntry(disk.name).catch(() => {});
      }
    };
  }
  const chunks: Uint8Array[] = [];
  return {
    write: async data => { chunks.push(data); },
    finish: async type => new Blob(chunks as BlobPart[], { type }),
    abort: async () => { chunks.length = 0; }
  };
}
