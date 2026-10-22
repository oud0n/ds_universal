import { describe, expect, it, vi } from 'vitest';

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
vi.mock('../../native/bridge', () => ({
  hasNative: () => true,
  toBase64: () => '',
  callNative: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
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
