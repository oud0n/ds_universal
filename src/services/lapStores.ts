/**
 * ラップタイムの一覧のファイルの読み書き (lapIndex.ts の LapFileStore)。
 * iPhone のアプリ: 書類のフォルダの LapTimer/ (走っている間に書くところ)。デスクトップ版: 利用者が選んだ保管場所のフォルダ。
 * ブラウザ版にはない (ブラウザの中の記録は消えることがあるので、続けて見る一覧には向かない)
 */

import { callNative, fromBase64, hasNative, toBase64 } from '../native/bridge';
import type { LapFileStore } from './lapIndex';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** iPhone のアプリ (LapTimer/ の下) */
export function nativeLapStore(): LapFileStore | null {
  if (!hasNative()) return null;
  return {
    async list() {
      return (await callNative('system.listLapFiles', {})).files;
    },
    async read(path) {
      return fromBase64((await callNative('system.readLapFile', { path })).b64);
    },
    async readText(path) {
      try {
        return decoder.decode(fromBase64((await callNative('system.readLapFile', { path })).b64));
      } catch {
        return null;
      }
    },
    async writeText(path, text) {
      await callNative('system.appendFile', { path, b64: toBase64(encoder.encode(text)), truncate: true });
    }
  };
}

/** デスクトップ版 (選んだ保管場所。選んでいなければ null) */
export async function electronLapStore(): Promise<LapFileStore | null> {
  const api = window.electronAPI?.laps;
  if (!api || !(await api.getFolder())) return null;
  const fail = (e?: string) => new Error(e ?? 'failed');
  return {
    async list() {
      const r = await api.list();
      if (!r.success || !r.files) throw fail(r.error);
      return r.files;
    },
    async read(path) {
      const r = await api.read(path);
      if (!r.success || !r.data) throw fail(r.error);
      return r.data;
    },
    async readText(path) {
      const r = await api.readText(path);
      return r.success ? r.text ?? null : null;
    },
    async writeText(path, text) {
      const r = await api.writeText(path, text);
      if (!r.success) throw fail(r.error);
    }
  };
}

/** この環境でラップタイムの一覧を使えるか (iPhone のアプリかデスクトップ版) */
export const canUseLapHistory = (): boolean => hasNative() || !!window.electronAPI?.laps;
