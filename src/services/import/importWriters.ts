/**
 * 取り込みの書き方 (2026-10-21)。デスクトップ版は保管場所のフォルダへ直接、iPhone・Android のアプリはアプリの中 (LapTimer/) に書いてから
 * 選んだフォルダへ移す (system.closeFiles → system.syncLapFiles。アプリの中には残さない)。どちらも、もうあるファイルは書かない。
 * アプリは 4 MB ずつ書くので、途中で失敗したら書きかけのファイルを消す (LATER-19)
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

/** 書きかけのファイルを閉じて消す。消せなかったら知らせる (黙って残すと、取り込み直しで飛ばされるため) */
async function removePartial(path: string): Promise<void> {
  await callNative('system.closeFiles', { paths: [path] }).catch(() => {});
  const r = await callNative('system.deleteRunFiles', { paths: [path] }).catch(() => null);
  if (r?.failed?.length) console.warn('[import] 書きかけのファイルを消せない:', path, r.failed[0].error);
}

/** 一度に送る大きさ (橋の上の base64 が大きくなりすぎないように) */
const CHUNK = 4 * 1024 * 1024;

/**
 * iPhone のアプリ。existing は保管場所 (選んだフォルダ) にあるファイルの道。アプリの中 (LapTimer/) に無くても、
 * 選んだフォルダにあれば書かない (書くと、あとの写し (system.syncLapFiles) が選んだフォルダのファイルを上書きするため)
 */
export function nativeWriter(existing: ReadonlySet<string> = new Set()): (ImportWriter & { finish: () => Promise<void> }) | null {
  if (!hasNative()) return null;
  /** 書いたファイル (書き終えたら閉じて、選んだフォルダへ移す) */
  const written: string[] = [];
  return {
    async writeNew(path, bytes) {
      if (existing.has(path)) return 'exists';
      try {
        await callNative('system.appendFile', { path, b64: toBase64(bytes.subarray(0, CHUNK)), truncate: true, createNew: true });
        // 書けたものだけ、あとで閉じる (同じ名前があって書かなかったものは数えない)
        written.push(path);
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === 'busy') return 'exists';
        // 初めの 4 MB を書く途中で失敗したときも、書きかけが残っているかもしれないので消す
        await removePartial(path);
        throw e;
      }
      try {
        for (let off = CHUNK; off < bytes.length; off += CHUNK) {
          await callNative('system.appendFile', { path, b64: toBase64(bytes.subarray(off, off + CHUNK)) });
        }
      } catch (e) {
        // 途中で失敗したら、書きかけのファイルを消す (残すと、取り込み直したときに「もうある」として飛ばされ、
        // 途中までのログが走行として残る。LATER-19)。閉じる一覧からも外す
        written.splice(written.indexOf(path), 1);
        await removePartial(path);
        throw e;
      }
      return 'ok';
    },
    /** 書き終えたら、選んだフォルダへ移す */
    async finish() {
      if (written.length) await callNative('system.closeFiles', { paths: written.splice(0) }).catch(() => {});
      await callNative('system.syncLapFiles', {}).catch(() => {});
    }
  };
}
