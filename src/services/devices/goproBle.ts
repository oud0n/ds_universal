/**
 * GoPro (Open GoPro。HERO9 以降) の Bluetooth LE (2026-10-20、PLAN-21)。
 * GoPro が公開している Open GoPro の BLE の資料 (Data Protocol・Control・Hilights・Query) と、公式の SDK の定数で確かめた形。
 *
 * - サービス FEA6 の Command (GP-0072) に書き、答えは Command Response (GP-0073) の通知。
 *   設定は Settings (GP-0074) / GP-0075、問い合わせは Query (GP-0076) / GP-0077
 * - 1 つのパケットは 20 バイトまで。長いメッセージは、始まりのパケット (長さの頭) と続きのパケット (0x80 | 番号) に分ける
 * - つなぐ前に、カメラとペアリング (暗号化) しておく必要がある。カメラをペアリングの状態にして選ぶと、iPhone が 1 回だけ確認を出す
 * - つないでいる間は、3 秒ごとにつなぎを保つ合図 (設定 91 に 0x42) を送る
 */

const gp = (n: string) => `b5f9${n}-aa8d-11e3-9046-0002a5d5c51b`;
export const GOPRO_SERVICE = 'fea6';
export const GOPRO_COMMAND = gp('0072');
export const GOPRO_COMMAND_RESPONSE = gp('0073');
export const GOPRO_SETTINGS = gp('0074');
export const GOPRO_SETTINGS_RESPONSE = gp('0075');
export const GOPRO_QUERY = gp('0076');
export const GOPRO_QUERY_RESPONSE = gp('0077');
export const GOPRO_NAME_PREFIXES = ['GoPro '];
/** つなぎを保つ合図の間隔 (ミリ秒。資料のおすすめは 3 秒) */
export const GOPRO_KEEP_ALIVE_MS = 3000;

const MAX_PACKET = 20;

/** メッセージを、頭を付けたパケットに分ける */
export function packetize(message: Uint8Array): Uint8Array[] {
  let head: number[];
  if (message.length < 32) head = [message.length]; // 一般 (5 ビット)
  else if (message.length < 8192) head = [0x20 | (message.length >> 8), message.length & 0xff]; // 拡張 (13 ビット)
  else head = [0x40, message.length >> 8, message.length & 0xff]; // 拡張 (16 ビット)
  const packets: Uint8Array[] = [];
  packets.push(Uint8Array.from([...head, ...message.slice(0, MAX_PACKET - head.length)]));
  let i = MAX_PACKET - head.length;
  let counter = 0;
  while (i < message.length) {
    const take = message.slice(i, i + MAX_PACKET - 1);
    packets.push(Uint8Array.from([0x80 | (counter & 0x0f), ...take]));
    counter++;
    i += take.length;
  }
  return packets;
}

/** 届いたパケットをつなぎ合わせて、メッセージにする */
export class GoProAssembler {
  private buf: number[] = [];
  private expected = 0;

  /** パケットを 1 つ渡す。メッセージがそろったら返す (まだなら null) */
  push(packet: Uint8Array): Uint8Array | null {
    if (packet.length === 0) return null;
    const h = packet[0];
    if ((h & 0x80) === 0) {
      // 始まりのパケット
      const type = (h >> 5) & 0x03;
      let offset: number;
      if (type === 0) { this.expected = h & 0x1f; offset = 1; }
      else if (type === 1) { this.expected = ((h & 0x1f) << 8) | packet[1]; offset = 2; }
      else if (type === 2) { this.expected = (packet[1] << 8) | packet[2]; offset = 3; }
      else return null;
      this.buf = Array.from(packet.slice(offset));
    } else {
      if (this.expected === 0) return null; // 始まりを受け取っていない続きは捨てる
      this.buf.push(...packet.slice(1));
    }
    if (this.buf.length >= this.expected) {
      const out = Uint8Array.from(this.buf.slice(0, this.expected));
      this.buf = [];
      this.expected = 0;
      return out;
    }
    return null;
  }
}

/** 命令 (Command に書く) */
export const goproCommands = {
  /** 録画を始める・止める */
  shutter: (on: boolean) => Uint8Array.from([0x01, 0x01, on ? 1 : 0]),
  /** 録画中の動画に印 (HiLight) を付ける */
  hilight: () => Uint8Array.from([0x18]),
  /** カメラの時計を合わせる (時差と夏時間も)。utcOffsetMin は UTC からのずれ (分。日本は +540) */
  setLocalDateTime: (d: Date, utcOffsetMin: number, dst = false) => {
    // 時差を足した、その土地の時刻
    const local = new Date(d.getTime() + utcOffsetMin * 60000);
    const y = local.getUTCFullYear();
    const off = utcOffsetMin & 0xffff;
    return Uint8Array.from([0x0f, 10, y >> 8, y & 0xff, local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), off >> 8, off & 0xff, dst ? 1 : 0]);
  }
};

/** つなぎを保つ合図 (Settings に書く。設定 91 に 0x42) */
export const goproKeepAlive = () => Uint8Array.from([91, 0x01, 0x42]);

/** 状態の番号 (Query の「状態を読む」で使う) */
export const GOPRO_STATUS = { busy: 8, encoding: 10, remainingVideoSec: 35, batteryPercent: 70 } as const;

/** 状態を読む問い合わせ (Query に書く) */
export const goproQueryStatus = (ids: number[] = Object.values(GOPRO_STATUS)) => Uint8Array.from([0x13, ...ids]);

/** 命令の答え: [命令の番号, 結果 (0 が成功)] */
export function parseCommandResponse(message: Uint8Array): { id: number; ok: boolean } | null {
  return message.length >= 2 ? { id: message[0], ok: message[1] === 0 } : null;
}

export interface GoProStatus {
  busy?: boolean;
  encoding?: boolean;
  remainingVideoSec?: number;
  batteryPercent?: number;
}

/** 状態の問い合わせの答え: [0x13, 結果, (番号, 長さ, 値 (big endian))…] */
export function parseStatusResponse(message: Uint8Array): GoProStatus | null {
  if (message.length < 2 || message[0] !== 0x13 || message[1] !== 0) return null;
  const out: GoProStatus = {};
  for (let i = 2; i + 1 < message.length;) {
    const id = message[i];
    const len = message[i + 1];
    if (i + 2 + len > message.length) break;
    let v = 0;
    for (let k = 0; k < len; k++) v = v * 256 + message[i + 2 + k];
    if (id === GOPRO_STATUS.busy) out.busy = v !== 0;
    else if (id === GOPRO_STATUS.encoding) out.encoding = v !== 0;
    else if (id === GOPRO_STATUS.remainingVideoSec) out.remainingVideoSec = v;
    else if (id === GOPRO_STATUS.batteryPercent) out.batteryPercent = v;
    i += 2 + len;
  }
  return out;
}
