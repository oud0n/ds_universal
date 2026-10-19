/**
 * Garmin の FIT (.fit) の読み込み。公開されている FIT の仕様 (FIT Protocol) に沿って、record のメッセージ (番号 20) だけを読む。
 * 時刻・位置 (semicircle)・高度・速度を取り出し、GPX・TCX と同じ処理 (trackToLog) で点にする
 *
 * ファイルの作り: ファイルヘッダー (12 か 14 バイト、".FIT")、レコードの並び、CRC (2 バイト)。複数のファイルが続くこともある。
 * レコードは、ヘッダーの 1 バイトの後に、定義のメッセージ (以後のデータのフィールドの並び) か、データのメッセージが続く
 */
import { trackToLog, TrackPoint, ImportedLog } from './externalFormats';
import { tr } from '../utils/i18n';

/** FIT の時刻の起点 (1989-12-31 00:00:00 UTC) の UNIX 秒 */
const FIT_EPOCH_SEC = 631065600;
const RECORD_MESG = 20;
const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

interface FieldDef { num: number; size: number; baseType: number }
interface MesgDef { global: number; littleEndian: boolean; fields: FieldDef[]; devSize: number }

export function isFit(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && (bytes[0] === 12 || bytes[0] === 14) &&
    bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54; // ".FIT"
}

/** フィールドの値を読む (数値の型だけ)。無効値 (すべて 1 のビット・符号つきの最大値) は NaN */
function readValue(view: DataView, pos: number, f: FieldDef, le: boolean): number {
  const type = f.baseType & 0x1f;
  switch (type) {
    case 0x00: case 0x02: case 0x0a: { const v = view.getUint8(pos); return v === 0xff && type !== 0x0a ? NaN : v; } // enum / uint8 / uint8z
    case 0x01: { const v = view.getInt8(pos); return v === 0x7f ? NaN : v; } // sint8
    case 0x03: { const v = view.getInt16(pos, le); return v === 0x7fff ? NaN : v; } // sint16
    case 0x04: case 0x0b: { const v = view.getUint16(pos, le); return v === 0xffff ? NaN : v; } // uint16 / uint16z
    case 0x05: { const v = view.getInt32(pos, le); return v === 0x7fffffff ? NaN : v; } // sint32
    case 0x06: case 0x0c: { const v = view.getUint32(pos, le); return v === 0xffffffff ? NaN : v; } // uint32 / uint32z
    default: return NaN;
  }
}

/** FIT のファイルを読む。record に位置がなければ (室内の記録など) 読み込めない */
export function parseFit(bytes: Uint8Array): ImportedLog {
  if (!isFit(bytes)) throw new Error(tr('FIT のファイルとして読めませんでした', 'Could not read this as a FIT file'));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw: TrackPoint[] = [];
  let offset = 0;
  // ファイルが続けて入っていることがある (chained FIT)
  while (offset + 12 <= bytes.length && isFit(bytes.subarray(offset))) {
    const headerSize = bytes[offset];
    const dataSize = view.getUint32(offset + 4, true);
    let pos = offset + headerSize;
    const end = Math.min(bytes.length, pos + dataSize);
    const defs = new Map<number, MesgDef>();
    let lastTimestamp = NaN;
    while (pos < end) {
      const header = bytes[pos++];
      let local: number;
      let compressedTime = NaN;
      if (header & 0x80) {
        // 時刻を縮めて書いたデータのメッセージ: 下位 5 ビットが、直前の時刻からの秒 (32 秒で一周)
        local = (header >> 5) & 0x03;
        const off = header & 0x1f;
        if (Number.isFinite(lastTimestamp)) {
          let t = (lastTimestamp & ~0x1f) + off;
          if (off < (lastTimestamp & 0x1f)) t += 0x20;
          compressedTime = t;
          lastTimestamp = t;
        }
      } else if (header & 0x40) {
        // 定義のメッセージ
        local = header & 0x0f;
        const hasDev = (header & 0x20) !== 0;
        const littleEndian = bytes[pos + 1] === 0;
        const global = view.getUint16(pos + 2, littleEndian);
        const n = bytes[pos + 4];
        pos += 5;
        const fields: FieldDef[] = [];
        for (let i = 0; i < n; i++, pos += 3) fields.push({ num: bytes[pos], size: bytes[pos + 1], baseType: bytes[pos + 2] });
        let devSize = 0;
        if (hasDev) {
          const nd = bytes[pos++];
          for (let i = 0; i < nd; i++, pos += 3) devSize += bytes[pos + 1];
        }
        defs.set(local, { global, littleEndian, fields, devSize });
        continue;
      } else {
        local = header & 0x0f;
      }
      const def = defs.get(local);
      if (!def) throw new Error(tr('FIT のファイルが壊れています (定義のないメッセージ)', 'The FIT file is damaged (a message without a definition)'));
      if (def.global === RECORD_MESG) {
        const v: Record<number, number> = {};
        let p = pos;
        for (const f of def.fields) {
          if (p + f.size <= end) v[f.num] = readValue(view, p, f, def.littleEndian);
          p += f.size;
        }
        const ts = Number.isFinite(v[253]) ? v[253] : compressedTime;
        if (Number.isFinite(v[253])) lastTimestamp = v[253];
        // 速度・高度は、桁の多い enhanced_* を先に使う
        const speed = Number.isFinite(v[73]) ? v[73] / 1000 : Number.isFinite(v[6]) ? v[6] / 1000 : NaN;
        const alt = Number.isFinite(v[78]) ? v[78] / 5 - 500 : Number.isFinite(v[2]) ? v[2] / 5 - 500 : NaN;
        raw.push({
          t: Number.isFinite(ts) ? ts + FIT_EPOCH_SEC : NaN,
          lat: Number.isFinite(v[0]) ? v[0] * SEMICIRCLE_TO_DEG : NaN,
          lon: Number.isFinite(v[1]) ? v[1] * SEMICIRCLE_TO_DEG : NaN,
          ele: alt,
          speedMs: speed,
          course: NaN
        });
      } else {
        // record 以外のメッセージにも時刻 (253) があれば、縮めた時刻の基準にする
        let p = pos;
        for (const f of def.fields) {
          if (f.num === 253 && p + f.size <= end) {
            const t = readValue(view, p, f, def.littleEndian);
            if (Number.isFinite(t)) lastTimestamp = t;
          }
          p += f.size;
        }
      }
      pos += def.fields.reduce((a, f) => a + f.size, 0) + def.devSize;
    }
    offset = offset + headerSize + dataSize + 2;
  }
  if (raw.length === 0) throw new Error(tr('FIT のファイルに記録 (record) がありません', 'The FIT file has no records'));
  return trackToLog(raw, tr('FIT のファイル', 'the FIT file'));
}
