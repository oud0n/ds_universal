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
 * ArrayBuffer または File から動画メタデータを抽出
 */
export async function parseVideoMetadata(file: File): Promise<VideoMetadata> {
  // mvhd ボックスは通常ファイルの先頭付近 (FastStart) または末尾 (GoPro等) に存在
  // 先頭 2MB をスキャン
  const headerSliceSize = Math.min(file.size, 2 * 1024 * 1024);
  const buffer = await file.slice(0, headerSliceSize).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  let creationTime: Date | null = null;
  let durationSec = 0;
  let timescale = 1000;

  // 'mvhd' FourCC ('m', 'v', 'h', 'd' = 0x6D, 0x76, 0x68, 0x64) を検索
  let mvhdOffset = findFourCC(bytes, 0x6d, 0x76, 0x68, 0x64);

  // 先頭で見つからず、moov が末尾にある動画（GoPro HERO 等）の場合、末尾最大 16MB をスキャン
  if (mvhdOffset === -1 && file.size > headerSliceSize) {
    const tailSliceSize = Math.min(file.size, 16 * 1024 * 1024);
    const tailStart = file.size - tailSliceSize;
    const tailBuffer = await file.slice(tailStart, file.size).arrayBuffer();
    const tailBytes = new Uint8Array(tailBuffer);
    const tailMvhdOffset = findFourCC(tailBytes, 0x6d, 0x76, 0x68, 0x64);

    if (tailMvhdOffset >= 0) {
      const tailView = new DataView(tailBuffer);
      const res = parseMvhdBox(tailView, tailMvhdOffset);
      if (res) {
        creationTime = res.creationTime;
        durationSec = res.durationSec;
        timescale = res.timescale;
      }
    }
  } else if (mvhdOffset >= 0) {
    const res = parseMvhdBox(view, mvhdOffset);
    if (res) {
      creationTime = res.creationTime;
      durationSec = res.durationSec;
      timescale = res.timescale;
    }
  }

  // ファイルの最終更新日時によるフォールバック
  if (!creationTime && file.lastModified) {
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

// FourCC 検索ヘルパー
function findFourCC(bytes: Uint8Array, b0: number, b1: number, b2: number, b3: number): number {
  const limit = bytes.length - 8;
  for (let i = 0; i < limit; i++) {
    if (
      bytes[i] === b0 &&
      bytes[i + 1] === b1 &&
      bytes[i + 2] === b2 &&
      bytes[i + 3] === b3
    ) {
      return i - 4; // ボックスサイズヘッダーを含むオフセット
    }
  }
  return -1;
}

function parseMvhdBox(view: DataView, offset: number): {
  creationTime: Date | null;
  durationSec: number;
  timescale: number;
} | null {
  try {
    const boxSize = view.getUint32(offset);
    if (boxSize < 32 || offset + 32 > view.byteLength) return null;

    // mvhd の構造:
    // +0: 4バイト size
    // +4: 4バイト type ('mvhd')
    // +8: 1バイト version (0 または 1)
    // +9: 3バイト flags
    const version = view.getUint8(offset + 8);

    let rawCreationTime = 0;
    let timescale = 1000;
    let rawDuration = 0;

    if (version === 1) {
      // 64-bit timestamps
      rawCreationTime = Number(view.getBigUint64(offset + 12));
      timescale = view.getUint32(offset + 28);
      rawDuration = Number(view.getBigUint64(offset + 32));
    } else {
      // 32-bit timestamps (標準)
      rawCreationTime = view.getUint32(offset + 12);
      timescale = view.getUint32(offset + 20);
      rawDuration = view.getUint32(offset + 24);
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
