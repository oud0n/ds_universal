import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { StoredZipWriter, crc32 } from './storedZip';

describe('StoredZipWriter', () => {
  it('crc32 が既知の値と合う', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('ふつうの ZIP として読める (大きさを先頭に書き、データディスクリプターを使わない)', () => {
    const w = new StoredZipWriter();
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array(1000).map((_, i) => i & 0xff);
    const parts = [w.add('dir/a.png', a), w.add('dir/b.png', b), w.finish()];
    const zip = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { zip.set(p, o); o += p.length; }
    // 旗 (bit 3) が立っていない
    expect(new DataView(zip.buffer).getUint16(6, true) & 8).toBe(0);
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(['dir/a.png', 'dir/b.png']);
    expect([...files['dir/a.png']]).toEqual([...a]);
    expect([...files['dir/b.png']]).toEqual([...b]);
  });
});
