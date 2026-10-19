/**
 * Web とネイティブ (iPhone の Swift・Android の Kotlin) の間の約束 (docs/iphone_app_design.md の 7.6)。
 *
 * ネイティブはこの形を作るだけにし、解析・周の判定・機器ごとのデータの読み方は入れない。
 * 形を変えるときは CONTRACT_VERSION を上げ、mobile/ios (Swift)・mobile/android (Kotlin)・ふりをする窓口 (mockNative.ts) も同じに直す。
 *
 * やりとり (すべて JSON の文字列):
 * - Web → ネイティブ: NativeRequest を `window.webkit.messageHandlers.dsNative.postMessage(文字列)` (iPhone)
 *   または `window.dsNativeAndroid.postMessage(文字列)` (Android) に渡す
 * - ネイティブ → Web: NativeResponse (呼び出しへの答え) と NativeEvent (知らせ) を `window.dsNative.receive(文字列)` で渡す
 * - 時刻はすべてネイティブの単調な時計のナノ秒 (iPhone は mach_absolute_time、Android は elapsedRealtimeNanos)。
 *   UTC への対応は GPS の測位から Web が作る
 * - バイト列は base64
 *
 * いま入っているのは、デジスパイスとのつなぎ (ペアリング) に要る分だけ (caps・ble・system)。
 * recorder・files・camera などは、作るときにここへ足す
 */

export const CONTRACT_VERSION = 1;

// ---- やりとりの外側 ----

export interface NativeRequest {
  v: number;
  id: number;
  method: keyof NativeMethods;
  params: unknown;
}

export type NativeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: NativeErrorBody };

export interface NativeEvent {
  event: keyof NativeEvents;
  data: unknown;
}

export type NativeErrorCode = 'permission-denied' | 'not-supported' | 'not-connected' | 'not-found' | 'io' | 'busy';

export interface NativeErrorBody {
  code: NativeErrorCode;
  /** 利用者に見せる文言 (ネイティブが言語に合わせて返す。空なら Web が符号から作る) */
  message: string;
}

// ---- 呼び出し ----

export type Platform = 'ios' | 'android' | 'mock';
export type DeviceKind = 'phone' | 'tablet' | 'foldable';
export type PermissionState = 'granted' | 'denied' | 'unknown';

export interface Capabilities {
  contractVersion: number;
  platform: Platform;
  deviceKind: DeviceKind;
  /** 使える機能のまとまり。画面はこれで出し分け、端末の種類では分けない */
  features: { ble: boolean };
}

/** BLE の特性の指定。UUID は 16 ビットの短い形 ('2a67') か、128 ビットの形 */
export interface GattCharacteristicRef {
  service: string;
  characteristic: string;
}

export interface BleScanParams {
  /** 名前がこれで始まる機器だけを知らせる */
  namePrefixes: string[];
}

export interface BleConnectParams {
  deviceId: string;
  /** つないだら (つなぎ直したときも) 通知を受け取る特性 */
  notify: GattCharacteristicRef[];
  /**
   * 切れたら、ネイティブが同じ手順でつなぎ直すか。画面が消えて Web が止まっている間もつなぎ直せるよう、ネイティブが受け持つ
   */
  autoReconnect: boolean;
  /** Android: つないだあと MTU を上げ、速く送る設定にする (iPhone では OS が決めるので無視) */
  highThroughput: boolean;
}

export interface NativeMethods {
  'caps.get': { params: Record<string, never>; result: Capabilities };
  'ble.permission': { params: { request: boolean }; result: { state: PermissionState } };
  'ble.scan': { params: BleScanParams; result: Record<string, never> };
  'ble.stopScan': { params: Record<string, never>; result: Record<string, never> };
  'ble.connect': { params: BleConnectParams; result: Record<string, never> };
  'ble.disconnect': { params: { deviceId: string }; result: Record<string, never> };
  /** OS の設定の画面 (このアプリの許可) を開く。一度断られた許可は、OS がもう聞いてくれないため */
  'system.openSettings': { params: Record<string, never>; result: Record<string, never> };
}

// ---- 知らせ ----

export type BleLinkState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface BleDeviceEvent {
  deviceId: string;
  name: string;
  rssi?: number;
}

export interface BleStateEvent {
  deviceId: string;
  state: BleLinkState;
  /** disconnected になった理由 (自分で切ったときはなし) */
  error?: NativeErrorBody;
}

export interface BleNotifyEvent {
  deviceId: string;
  characteristic: string;
  /** 100 ms ごとにまとめた通知。t は受け取った時刻 (単調な時計のナノ秒)、b はバイト列 (base64) */
  items: Array<{ t: number; b: string }>;
}

export interface NativeEvents {
  'ble.device': BleDeviceEvent;
  'ble.scanStopped': Record<string, never>;
  'ble.state': BleStateEvent;
  'ble.notify': BleNotifyEvent;
  'system.appState': { state: 'active' | 'background' };
}
