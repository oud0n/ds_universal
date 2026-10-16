/**
 * MP4 / QuickTime (MOV) メタデータ抽出ユーティリティ
 * ISO Base Media File Format (ISOBMFF) の moov -> mvhd ボックスを解析し、
 * 撮影開始日時 (creation_time) および再生時間 (duration) を抽出します。
 */

export interface VideoMetadata {
  fileName: string;
  fileSize: number;
  creationTime: Date | null;
  durationSec: number;
  timescale: number;
}

// QuickTime / MP4 エポック (1904-01-01T00:00:00Z) と Unix エポック (1970-01-01T00:00:00Z) の秒数差
const MAC_EPOCH_OFFSET_SECONDS = 2082844800;

/**
 * File から動画メタデータを抽出
 * ボックス (size + type) の並びを先頭から辿って moov → mvhd を探す。
 * 生のバイト列から 'mvhd' の 4 文字を探すと、mdat (映像データ) の中に同じ並びがあったときに誤って拾うため使わない
 */
export async function parseVideoMetadata(file: File): Promise<VideoMetadata> {
  let creationTime: Date | null = null;
  let durationSec = 0;
  let timescale = 1000;

  try {
    const moov = await findBox(file, 0, file.size, 'moov');
    const mvhd = moov ? await findBox(file, moov.bodyStart, moov.end, 'mvhd') : null;
    if (mvhd) {
      // ボックスの大きさの欄は 0 (親の末尾まで) や 1 (64 bit) のこともあるので、中身 (version から) を読む
      const buffer = await file.slice(mvhd.bodyStart, Math.min(mvhd.end, mvhd.bodyStart + 256)).arrayBuffer();
      const res = parseMvhdBody(new DataView(buffer));
      if (res) {
        creationTime = res.creationTime;
        durationSec = res.durationSec;
        timescale = res.timescale;
      }
    }
  } catch (err) {
    console.warn('動画メタデータの解析に失敗しました:', err);
  }

  // ファイルの最終更新日時によるフォールバック (コピーした日時のことがある。照合は 4 時間以内に収まらなければ失敗として扱われる)
  if (!creationTime && file.lastModified) {
    console.warn(`[VideoMeta] ${file.name}: 撮影日時を読み取れなかったため、ファイルの更新日時を使います`);
    creationTime = new Date(file.lastModified);
  }

  return {
    fileName: file.name,
    fileSize: file.size,
    creationTime,
    durationSec,
    timescale
  };
}

/** [from, to) の範囲にあるボックスを順に辿り、type が一致する最初のボックスを返す */
async function findBox(
  file: File,
  from: number,
  to: number,
  type: string
): Promise<{ start: number; bodyStart: number; end: number } | null> {
  let offset = from;
  // 壊れたファイルで無限に辿らないよう、ボックス数に上限を設ける
  for (let n = 0; n < 10000 && offset + 8 <= to; n++) {
    const head = new DataView(await file.slice(offset, Math.min(to, offset + 16)).arrayBuffer());
    if (head.byteLength < 8) return null;
    let size = head.getUint32(0);
    const boxType = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let headerSize = 8;
    if (size === 1) {
      // 64 bit の大きさ (4GB を超える mdat など)
      if (head.byteLength < 16) return null;
      size = Number(head.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      // ファイル (親ボックス) の末尾まで
      size = to - offset;
    }
    if (size < headerSize || offset + size > to) return null;
    if (boxType === type) return { start: offset, bodyStart: offset + headerSize, end: offset + size };
    offset += size;
  }
  return null;
}

/** mvhd の中身 (ヘッダーの直後、version から) を読む */
function parseMvhdBody(view: DataView): {
  creationTime: Date | null;
  durationSec: number;
  timescale: number;
} | null {
  try {
    // +0: version (1 バイト) / +1: flags (3 バイト)
    if (view.byteLength < 24) return null;
    const version = view.getUint8(0);

    let rawCreationTime = 0;
    let timescale = 1000;
    let rawDuration = 0;

    if (version === 1) {
      // 64 bit の時刻: creation(8) modification(8) timescale(4) duration(8)
      if (view.byteLength < 32) return null;
      rawCreationTime = Number(view.getBigUint64(4));
      timescale = view.getUint32(20);
      rawDuration = Number(view.getBigUint64(24));
    } else {
      // 32 bit の時刻 (標準): creation(4) modification(4) timescale(4) duration(4)
      rawCreationTime = view.getUint32(4);
      timescale = view.getUint32(12);
      rawDuration = view.getUint32(16);
    }

    let creationTime: Date | null = null;
    if (rawCreationTime > MAC_EPOCH_OFFSET_SECONDS) {
      const unixSec = rawCreationTime - MAC_EPOCH_OFFSET_SECONDS;
      creationTime = new Date(unixSec * 1000);
    }

    const durationSec = timescale > 0 ? Number((rawDuration / timescale).toFixed(2)) : 0;

    return {
      creationTime,
      durationSec,
      timescale
    };
  } catch (err) {
    console.warn('mvhd 解析例外:', err);
    return null;
  }
}
