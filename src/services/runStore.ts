/**
 * 走行の置き場 (2026-10-20、docs/session_storage_design.md)。iPhone のアプリとデスクトップ版で共通の窓口。
 * 置き場/<サーキットのフォルダ>/ に、走行のログ (.bon4・.nmea)・動画・runs.json・laptimes.json が並ぶ。
 * 動画は lapfile://run/<道> で読む (丸ごと読まず、頼んだ範囲だけ読む。iPhone: RunFiles.swift、デスクトップ版: electron/main.cjs)
 */

import { callNative, fromBase64, hasNative, NativeError, toBase64 } from '../native/bridge';
import type { LapFileInfo, LapFileStore } from './lapIndex';

export interface RunFileInfo extends LapFileInfo {
  /** 端末の中にあるか (false: iCloud にだけある。読むと取り込みが始まる) */
  local: boolean;
}

export interface RunStore extends LapFileStore {
  /** 置き場の全部のファイル (動画も) */
  listAll(): Promise<RunFileInfo[]>;
  /** 動画を読む URL */
  videoUrl(path: string): string;
  /** iCloud からの取り込みを始める (終わるのは待たない) */
  startDownload(path: string): Promise<void>;
  /** 読む。無いときだけ null、読めないときは例外 (runs.json を書く前に読むため) */
  readTextStrict(path: string): Promise<string | null>;
  /** 動画の範囲を読む窓口 (無ければ fetch で読む) */
  rangeReader?(path: string): ((start: number, end: number) => Promise<ArrayBuffer>) | undefined;
  /** ファイルが端末にあるか・取り込み中か (分からなければ local だけ) */
  fileStatus(path: string): Promise<{ local: boolean; downloading: boolean }>;
  /** 動画を lapfile:// で読めるか (古いアプリは読めない) */
  supportsVideos(): Promise<boolean>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** lapfile://run/<道> (道の区切りごとに % で書く) */
export function lapFileUrl(path: string): string {
  return 'lapfile://run/' + path.split('/').map(encodeURIComponent).join('/');
}

/** アプリが lapfile:// を持っているか (system.runRoot に答えるか)。1 回だけ聞く */
let nativeVideos: Promise<boolean> | null = null;
const nativeSupportsVideos = () => (nativeVideos ??= callNative('system.runRoot', {}).then(() => true, e => !isOldApp(e)));

/** 古いアプリ (走行の置き場の窓口がない) か */
const isOldApp = (e: unknown) => e instanceof NativeError && e.code === 'not-supported';

/** iPhone のアプリ。選んだフォルダがあればそこ、なければ書類の LapTimer/ */
export function nativeRunStore(): RunStore | null {
  if (!hasNative()) return null;
  let synced: Promise<unknown> | null = null;
  // 走っている間に書いた走行を、選んだフォルダへ写してから見る (写すのは 1 回だけ待つ)
  const sync = () => (synced ??= callNative('system.syncLapFiles', {}).catch(() => undefined));
  const readBytes = async (path: string): Promise<Uint8Array> => {
    try {
      return fromBase64((await callNative('system.readRunFile', { path })).b64);
    } catch (e) {
      if (!isOldApp(e)) throw e;
      return fromBase64((await callNative('system.readLapFile', { path })).b64);
    }
  };
  const store: RunStore = {
    supportsVideos: nativeSupportsVideos,
    async listAll() {
      await sync();
      try {
        return (await callNative('system.listRunFiles', {})).files;
      } catch (e) {
        if (!isOldApp(e)) throw e;
        const files: LapFileInfo[] = (await callNative('system.listLapFiles', {})).files;
        return files.map(f => ({ ...f, local: true }));
      }
    },
    // iCloud にだけあるファイルも local: false で渡す (周の控えは、それを落とさずに前の控えを残す。lapIndex.ts の reconcileFolder)
    list: () => store.listAll(),
    read: readBytes,
    async readText(path) {
      try {
        return decoder.decode(await readBytes(path));
      } catch {
        return null;
      }
    },
    async readTextStrict(path) {
      try {
        return decoder.decode(await readBytes(path));
      } catch (e) {
        if (e instanceof NativeError && e.code === 'not-found') return null;
        throw e;
      }
    },
    async writeText(path, text) {
      try {
        await callNative('system.writeRunFile', { path, b64: toBase64(encoder.encode(text)) });
      } catch (e) {
        if (!isOldApp(e)) throw e;
        await callNative('system.appendFile', { path, b64: toBase64(encoder.encode(text)), truncate: true });
      }
    },
    videoUrl: lapFileUrl,
    rangeReader: path => async (start, end) => {
      const b = fromBase64((await callNative('system.readRunRange', { path, offset: start, length: end - start })).b64);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    async fileStatus(path) {
      return callNative('system.runFileStatus', { path });
    },
    async startDownload(path) {
      await callNative('system.downloadRunFile', { path }).catch(() => undefined);
    }
  };
  return store;
}

/** デスクトップ版 (選んだ保管場所。選んでいなければ null) */
export async function electronRunStore(): Promise<RunStore | null> {
  const api = window.electronAPI?.laps;
  if (!api || !(await api.getFolder())) return null;
  const fail = (e?: string) => new Error(e ?? 'failed');
  const store: RunStore = {
    supportsVideos: async () => true,
    async listAll() {
      const r = await api.list();
      if (!r.success || !r.files) throw fail(r.error);
      return r.files.map(f => ({ ...f, local: true }));
    },
    list: () => store.listAll(),
    async read(path) {
      const r = await api.read(path);
      if (!r.success || !r.data) throw fail(r.error);
      return r.data;
    },
    async readText(path) {
      const r = await api.readText(path);
      return r.success ? r.text ?? null : null;
    },
    async readTextStrict(path) {
      const r = await api.readText(path);
      if (!r.success) throw fail(r.error);
      return r.text ?? null;
    },
    async writeText(path, text) {
      const r = await api.writeText(path, text);
      if (!r.success) throw fail(r.error);
    },
    videoUrl: lapFileUrl,
    async fileStatus() {
      return { local: true, downloading: false };
    },
    async startDownload() {}
  };
  return store;
}

/** この環境の走行の置き場 (なければ null) */
export async function getRunStore(): Promise<RunStore | null> {
  return nativeRunStore() ?? (await electronRunStore());
}

/** この環境で走行の置き場を使えるか (iPhone のアプリかデスクトップ版) */
export const canUseRunStore = (): boolean => hasNative() || !!window.electronAPI?.laps;
