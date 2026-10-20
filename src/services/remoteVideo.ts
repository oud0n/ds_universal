/**
 * 保管場所の動画を、ファイルを丸ごと読まずに使う (lapfile://run/<道>。2026-10-20)。
 * 範囲 (Range) を頼んで読む ByteSource と、撮影日時・長さを読むための File に似たもの
 */
import type { ByteSource } from './gpmfParser';

/** 保管場所の動画 */
export interface RemoteVideo {
  name: string;
  size: number;
  url: string;
  /** 保管場所からの道 (runs.json に書くのはファイル名だけ) */
  path: string;
  lastModified: number;
}

async function readRange(url: string, start: number, end: number): Promise<ArrayBuffer> {
  if (end <= start) return new ArrayBuffer(0);
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (!r.ok) throw new Error(`read ${r.status}`);
  return r.arrayBuffer();
}

export function remoteByteSource(v: Pick<RemoteVideo, 'url' | 'size'>): ByteSource {
  return {
    size: v.size,
    read: async (offset, length) => new DataView(await readRange(v.url, offset, Math.min(v.size, offset + length)))
  };
}

/** parseVideoMetadata が使うところ (name・size・lastModified・slice().arrayBuffer()) だけを持つ、File に似たもの */
export function remoteFileLike(v: RemoteVideo): File {
  const slice = (start = 0, end = v.size) => ({
    arrayBuffer: () => readRange(v.url, Math.max(0, start), Math.min(v.size, end))
  });
  return { name: v.name, size: v.size, lastModified: v.lastModified, slice } as unknown as File;
}

export const isRemoteVideo = (x: File | RemoteVideo): x is RemoteVideo => typeof (x as RemoteVideo).url === 'string' && !(x instanceof Blob);
