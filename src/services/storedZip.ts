/**
 * 縮めずに入れる ZIP を作る (2026-10-20)。
 * どのファイルも、中身ができてから入れるので、大きさと CRC を先頭 (ローカルヘッダー) に書く、ふつうの形にする。
 * 大きさを後ろに書く形 (データディスクリプター) は、iPhone の「ファイル」アプリでファイルが多いと開けなかった。
 * ZIP64 は使わない (ファイル 65535 個・合計 4 GB まで。超えるときはエラーにする)
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

interface Entry { name: Uint8Array; crc: number; size: number; offset: number }

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

export class StoredZipWriter {
  private entries: Entry[] = [];
  private offset = 0;
  private readonly stamp = dosDateTime(new Date());

  /** ファイルを 1 つ入れる。返したバイト列をそのまま順に書く。名前は英数字と / . _ - だけにする */
  add(name: string, data: Uint8Array): Uint8Array {
    if (this.entries.length >= MAX_ENTRIES) throw new Error('ZIP に入れられるファイルの数 (65535) を超えました。書き出す範囲を短くしてください');
    const nameBytes = new TextEncoder().encode(name);
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    const crc = crc32(data);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 10, true); // 展開に要る版 (1.0: 縮めていない)
    v.setUint16(6, 0, true); // 旗 (データディスクリプターなし)
    v.setUint16(8, 0, true); // 縮めていない
    v.setUint16(10, this.stamp.time, true);
    v.setUint16(12, this.stamp.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    if (this.offset + header.length + data.length > MAX_BYTES) throw new Error('ZIP の大きさが 4 GB を超えました。書き出す範囲を短くしてください');
    this.entries.push({ name: nameBytes, crc, size: data.length, offset: this.offset });
    this.offset += header.length + data.length;
    const out = new Uint8Array(header.length + data.length);
    out.set(header, 0);
    out.set(data, header.length);
    return out;
  }

  /** 終わりの目次 (セントラルディレクトリと終端) */
  finish(): Uint8Array {
    const dirSize = this.entries.reduce((s, e) => s + 46 + e.name.length, 0);
    if (this.offset + dirSize + 22 > MAX_BYTES) throw new Error('ZIP の大きさが 4 GB を超えました。書き出す範囲を短くしてください');
    const out = new Uint8Array(dirSize + 22);
    const v = new DataView(out.buffer);
    let p = 0;
    for (const e of this.entries) {
      v.setUint32(p, 0x02014b50, true);
      v.setUint16(p + 4, 20, true); // 作った版
      v.setUint16(p + 6, 10, true);
      v.setUint16(p + 8, 0, true);
      v.setUint16(p + 10, 0, true);
      v.setUint16(p + 12, this.stamp.time, true);
      v.setUint16(p + 14, this.stamp.date, true);
      v.setUint32(p + 16, e.crc, true);
      v.setUint32(p + 20, e.size, true);
      v.setUint32(p + 24, e.size, true);
      v.setUint16(p + 28, e.name.length, true);
      // 30: 追加の欄 0, 32: 注 0, 34: ディスク 0, 36: 内部属性 0, 38: 外部属性 0
      v.setUint32(p + 42, e.offset, true);
      out.set(e.name, p + 46);
      p += 46 + e.name.length;
    }
    v.setUint32(p, 0x06054b50, true);
    v.setUint16(p + 8, this.entries.length, true);
    v.setUint16(p + 10, this.entries.length, true);
    v.setUint32(p + 12, dirSize, true);
    v.setUint32(p + 16, this.offset, true);
    return out;
  }
}
