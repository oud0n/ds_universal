/**
 * BLE の機器を探す・つなぐ・通知を受け取る層 (環境ごとに差し替える部分)。
 *
 * 今ある実装:
 * - ネイティブ (iPhone・Android のアプリ。nativeBleCentral.ts): 窓口 (src/native/bridge.ts) を通して呼ぶ
 * - Web Bluetooth (パソコン・Android の Chrome と Electron。webBluetoothCentral.ts)
 *
 * 決まり:
 * - connect() は頼みを受け付けたら終わる。つながった・切れた・つなぎ直しているは onState で知らせる
 *   (機器の電源が入っていなくても失敗にせず、見つかるまで connecting のまま待つ)
 * - autoReconnect は実装が受け持つ (ネイティブでは、画面が消えて Web が止まっている間もつなぎ直すため)
 * - 通知の tMs は受け取った時刻 (単調な時計のミリ秒)。実装ごとに時計は違うが、1 つの実装の中では同じ時計
 * - 利用者に見せるエラーの文言は tr() で日本語と英語の両方を用意する
 */

import type { BleLinkState, GattCharacteristicRef } from '../native/contract';
import { hasNative, nativeCapabilities } from '../native/bridge';

export type { BleLinkState, GattCharacteristicRef };

export interface BleDeviceInfo {
  id: string;
  name: string;
  rssi?: number;
}

export interface BleNotification {
  tMs: number;
  bytes: Uint8Array;
}

export interface BleLinkHandlers {
  onState: (state: BleLinkState, error?: Error) => void;
  onNotify: (items: BleNotification[]) => void;
}

export interface BleScanOptions {
  namePrefixes: string[];
  /** つないだあとに使うサービス (Web Bluetooth は、選ぶときに書いておかないと使えない) */
  services: string[];
}

export interface BleCentral {
  readonly kind: 'native' | 'web';
  /**
   * 探す。見つかるたびに onDevice、探し終えたら onEnd。
   * Web Bluetooth では、ブラウザの機器の選択画面を出し、選ばれた 1 台を知らせて終わる
   */
  scan(options: BleScanOptions, onDevice: (d: BleDeviceInfo) => void, onEnd: () => void): Promise<void>;
  stopScan(): Promise<void>;
  connect(deviceId: string, notify: GattCharacteristicRef, handlers: BleLinkHandlers): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  /** 許可を断られたときに、OS の設定の画面を開ける (ネイティブだけ) */
  openSettings?: () => Promise<void>;
}

/** BLE を使えそうか (画面を出すかの判断。実際に使えるかは getBleCentral で分かる) */
export function bleMaybeAvailable(): boolean {
  if (hasNative()) return true;
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

let centralPromise: Promise<BleCentral | null> | null = null;

/** この環境の BLE の層。使えないときは null */
export function getBleCentral(): Promise<BleCentral | null> {
  centralPromise ??= (async () => {
    if (hasNative()) {
      const caps = await nativeCapabilities();
      if (!caps?.features.ble) return null;
      const { nativeBleCentral } = await import('./nativeBleCentral');
      return nativeBleCentral;
    }
    if (typeof navigator !== 'undefined' && 'bluetooth' in navigator) {
      const { webBluetoothCentral } = await import('./webBluetoothCentral');
      return webBluetoothCentral;
    }
    return null;
  })();
  return centralPromise;
}

/** '2a67' → 0x2a67、128 ビットの UUID はそのまま (小文字) */
export function uuidForWeb(uuid: string): number | string {
  return /^[0-9a-f]{4}$/i.test(uuid) ? parseInt(uuid, 16) : uuid.toLowerCase();
}
