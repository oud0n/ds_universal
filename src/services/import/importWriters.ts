/**
 * 取り込みの書き方 (2026-10-21)。デスクトップ版は保管場所のフォルダへ直接、iPhone のアプリはアプリの中 (LapTimer/) に書いてから
 * 選んだフォルダへ写す (system.syncLapFiles)。どちらも、もうあるファイルは書かない
 */

import { callNative, hasNative, toBase64 } from '../../native/bridge';
import type { ImportWriter } from './importApply';

/** デスクトップ版 (Electron) */
export function electronWriter(): ImportWriter | null {
  const write = window.electronAPI?.laps?.writeFile;
  if (!write) return null;
  return {
    async writeNew(path, bytes) {
      const r = await write(path, bytes);
      if (r.success) return 'ok';
      if (r.error === 'exists') return 'exists';
      throw new Error(r.error ?? 'write failed');
    }
  };
}

/** 一度に送る大きさ (橋の上の base64 が大きくなりすぎないように) */
const CHUNK = 4 * 1024 * 1024;

/** iPhone のアプリ */
export function nativeWriter(): (ImportWriter & { finish: () => Promise<void> }) | null {
  if (!hasNative()) return null;
  return {
    async writeNew(path, bytes) {
      try {
        await callNative('system.appendFile', { path, b64: toBase64(bytes.subarray(0, CHUNK)), truncate: true, createNew: true });
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === 'busy') return 'exists';
        throw e;
      }
      for (let off = CHUNK; off < bytes.length; off += CHUNK) {
        await callNative('system.appendFile', { path, b64: toBase64(bytes.subarray(off, off + CHUNK)) });
      }
      return 'ok';
    },
    /** 書き終えたら、選んだフォルダへ写す */
    async finish() {
      await callNative('system.syncLapFiles', {}).catch(() => {});
    }
  };
}
