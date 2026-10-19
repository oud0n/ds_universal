/**
 * デジスパイスIV の BLE (Bluetooth Low Energy) の受信データの解析 (入出力のない部分)。
 *
 * 本体は標準の Location and Navigation Service (0x1819) の Location and Speed (0x2A67) の通知で、
 * 1 測位を「パケット A (16 バイト) → パケット B (10 バイト)」の 2 つに分けて 20Hz で送ってくる。
 * 仕様は bluetooth_protocol_analysis.md (Android の HCI スヌープログの解析)。iPhone アプリ版では、
 * BLE の接続と通知の受け取りを Swift で行い、届いたバイト列をここに渡して測位にする
 *
 * 確度の低いところ:
 * - 速度の単位は 0.01 m/s (LN の標準の単位) と推定。静止中のデータでしか確かめていない
 * - 高度の単位は 0.01 m と推定
 */

export const BLE_DEVICE_NAME_PREFIX = 'DS4';
export const LOCATION_AND_NAVIGATION_SERVICE = 0x1819;
export const LOCATION_AND_SPEED_CHARACTERISTIC = 0x2a67;

const PACKET_A_LENGTH = 16;
const PACKET_B_LENGTH = 10;

export interface BleFix {
  /** 測位の時刻 (UTC) */
  timestamp: Date;
  /** 測位できているか (未測位の間も、緯度・経度・高度には直前の値が入り続ける) */
  valid: boolean;
  latitude: number;
  longitude: number;
  /** km/h (0.01 m/s 単位と推定) */
  speedKmh: number;
  /** m (0.01 m 単位と推定) */
  altitude: number;
}

/** デバイス名 (DS4B + 7 桁) から、本体に書かれたシリアル番号を取り出す。デジスパイスでなければ null */
export function serialFromDeviceName(name: string | null | undefined): string | null {
  const m = /^DS4B(\d{7})$/.exec(name ?? '');
  return m ? m[1] : null;
}

/** 測位できているか (Flags のビット 7〜8 の Position Status が 0 以外) */
function positionOk(flags: number): boolean {
  return ((flags >> 7) & 0x3) !== 0;
}

interface PacketA { flags: number; speedRaw: number; lat: number; lon: number; elevationRaw: number }

function parsePacketA(v: DataView): PacketA {
  return {
    flags: v.getUint16(0, true),
    speedRaw: v.getUint16(2, true),
    lat: v.getInt32(4, true),
    lon: v.getInt32(8, true),
    elevationRaw: v.getInt32(12, true)
  };
}

/**
 * 通知を 1 つずつ渡すと、パケット A と続くパケット B を組にして測位を返す。
 * 長さで種別を決める (16 バイト = A、10 バイト = B)。A のない B、続く B のない A、年が 0 の組 (接続直後のダミー) は捨てる
 */
export class BleFixAssembler {
  private pendingA: PacketA | null = null;

  push(value: Uint8Array): BleFix | null {
    const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
    if (value.byteLength === PACKET_A_LENGTH) {
      this.pendingA = parsePacketA(v);
      return null;
    }
    if (value.byteLength !== PACKET_B_LENGTH) return null;
    const a = this.pendingA;
    this.pendingA = null;
    if (!a) return null;

    const flags = v.getUint16(0, true);
    const year = v.getUint16(2, true);
    if (year === 0) return null;
    const month = v.getUint8(4), day = v.getUint8(5), hours = v.getUint8(6), minutes = v.getUint8(7), seconds = v.getUint8(8), centis = v.getUint8(9);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 60 || centis > 99) return null;

    return {
      timestamp: new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, centis * 10)),
      valid: positionOk(a.flags) && positionOk(flags),
      latitude: a.lat / 1e7,
      longitude: a.lon / 1e7,
      speedKmh: (a.speedRaw / 100) * 3.6,
      altitude: a.elevationRaw / 100
    };
  }

  /** 接続し直したときなど、組にしかけの A を捨てる */
  reset(): void {
    this.pendingA = null;
  }
}
