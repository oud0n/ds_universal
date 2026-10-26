import { describe, expect, it, vi } from 'vitest';

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
/** n 回目の appendFile で失敗させる (0 なら失敗しない) */
let failAppendAt = 0;
vi.mock('../../native/bridge', () => ({
  hasNative: () => true,
  toBase64: () => '',
  callNative: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'system.appendFile' && failAppendAt && calls.filter(c => c.method === 'system.appendFile').length === failAppendAt) throw new Error('disk full');
    return {};
  }
}));

const { nativeWriter } = await import('./importWriters');

describe('取り込みの書き方 (iPhone のアプリ)', () => {
  it('書き終えたら、書いたファイルを閉じてから選んだフォルダへ移す (アプリの中に残さない)', async () => {
    calls.length = 0;
    const w = nativeWriter(new Set(['sodegaura/20261024/20261024100000.nmea']))!;
    expect(await w.writeNew('sodegaura/20261024/20261024100000.nmea', new Uint8Array(3))).toBe('exists');
    expect(await w.writeNew('sodegaura/20261024/20261024110000.nmea', new Uint8Array(3))).toBe('ok');
    await w.finish();
    const methods = calls.map(c => c.method);
    expect(methods).toEqual(['system.appendFile', 'system.closeFiles', 'system.syncLapFiles']);
    // もう保管場所にあって書かなかったものは閉じない
    expect(calls[1].params).toEqual({ paths: ['sodegaura/20261024/20261024110000.nmea'] });
  });
});

describe('取り込みの途中の失敗 (LATER-19)', () => {
  it('4 MB を超えるログの書き足しで失敗したら、書きかけのファイルを消し、閉じる一覧にも入れない', async () => {
    calls.length = 0;
    failAppendAt = 2;
    const w = nativeWriter()!;
    const path = 'sodegaura/20261024/20261024120000.nmea';
    await expect(w.writeNew(path, new Uint8Array(5 * 1024 * 1024))).rejects.toThrow('disk full');
    expect(calls.map(c => c.method)).toEqual(['system.appendFile', 'system.appendFile', 'system.closeFiles', 'system.deleteRunFiles']);
    expect(calls[3].params).toEqual({ paths: [path] });
    failAppendAt = 0;
    calls.length = 0;
    await w.finish();
    expect(calls.map(c => c.method)).toEqual(['system.syncLapFiles']);
  });
});
