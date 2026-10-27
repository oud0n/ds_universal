import { describe, expect, it } from 'vitest';
import { readRemoteChunked } from './encodeVideoExporter';

describe('readRemoteChunked', () => {
  const data = Uint8Array.from({ length: 100 }, (_, i) => i);
  const calls: Array<[number, number]> = [];
  const video = {
    url: 'lapfile://run/x.mp4',
    readRange: async (start: number, end: number) => {
      calls.push([start, end]);
      return data.slice(start, end).buffer;
    }
  };

  it('分けて読み、つなげて返す', async () => {
    calls.length = 0;
    const out = await readRemoteChunked(video, 5, 47, 16);
    expect([...out]).toEqual([...data.slice(5, 47)]);
    expect(calls).toEqual([[5, 21], [21, 37], [37, 47]]);
  });

  it('足りない中身が返ったら止める', async () => {
    const short = { url: 'x', readRange: async () => new ArrayBuffer(3) };
    await expect(readRemoteChunked(short, 0, 10, 16)).rejects.toThrow();
  });
});
