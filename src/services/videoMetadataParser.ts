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
  // mvhd ボックスは通常ファイルの先頭付近 (または moov 内) に存在するため、先頭 512KB をスキャン
  const headerSliceSize = Math.min(file.size, 512 * 1024);
  const buffer = await file.slice(0, headerSliceSize).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  let creationTime: Date | null = null;
  let durationSec = 0;
  let timescale = 1000;

  // 'mvhd' FourCC ('m', 'v', 'h', 'd' = 0x6D, 0x76, 0x68, 0x64) を検索
  let mvhdOffset = -1;
  for (let i = 0; i < bytes.length - 8; i++) {
    if (
      bytes[i] === 0x6d && // 'm'
      bytes[i + 1] === 0x76 && // 'v'
      bytes[i + 2] === 0x68 && // 'h'
      bytes[i + 3] === 0x64 // 'd'
    ) {
      mvhdOffset = i - 4; // ボックスサイズを含む開始位置
      break;
    }
  }

  // 先頭 512KB で見つからず、moov が末尾にある動画（FastStart 未処理）の場合、末尾 512KB もスキャン
  if (mvhdOffset === -1 && file.size > headerSliceSize) {
    const tailStart = Math.max(0, file.size - 512 * 1024);
    const tailBuffer = await file.slice(tailStart).arrayBuffer();
    const tailBytes = new Uint8Array(tailBuffer);
    for (let i = 0; i < tailBytes.length - 8; i++) {
      if (
        tailBytes[i] === 0x6d &&
        tailBytes[i + 1] === 0x76 &&
        tailBytes[i + 2] === 0x68 &&
        tailBytes[i + 3] === 0x64
      ) {
        mvhdOffset = i - 4;
        const tailView = new DataView(tailBuffer);
        const res = parseMvhdBox(tailView, mvhdOffset);
        if (res) {
          creationTime = res.creationTime;
          durationSec = res.durationSec;
          timescale = res.timescale;
        }
        break;
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
