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
 * いま入っているのは、デジスパイスとのつなぎ (ペアリング) と、BLE の通知の記録に要る分だけ (caps・ble・recorder・system)。
 * files・camera などは、作るときにここへ足す
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

export interface RecorderStatus {
  recording: boolean;
  fileName?: string;
  deviceId?: string;
  notifications?: number;
}

/**
 * 記録のファイル (CSV の文字):
 * ```
 * # ds-ble-capture 1
 * # <見出しの行>
 * # started_utc_ms=<端末の時計のミリ秒> started_ns=<単調な時計>
 * t_ns,device,characteristic,hex
 * <受け取った時刻 ns>,<機器の ID>,2a67,8520070012…
 * # state,<t_ns>,reconnecting      (つなぎの状態が変わったとき)
 * # resumed,<t_ns>,started_utc_ms=… (OS が止めたアプリを起こし直して、続きを書いたとき)
 * ```
 */
export interface RecordingFile {
  fileName: string;
  bytes: number;
  modifiedMs: number;
}

/** ラップタイマーの記録の保管先 */
export interface StorageInfo {
  kind: 'local' | 'folder';
  /** 選んだフォルダの名前 (選んでいなければ '') */
  folderName: string;
  /** 選んだフォルダを今も開けるか */
  folderOk: boolean;
}

export interface NativeMethods {
  'caps.get': { params: Record<string, never>; result: Capabilities };
  'ble.permission': { params: { request: boolean }; result: { state: PermissionState } };
  'ble.scan': { params: BleScanParams; result: Record<string, never> };
  'ble.stopScan': { params: Record<string, never>; result: Record<string, never> };
  'ble.connect': { params: BleConnectParams; result: Record<string, never> };
  'ble.disconnect': { params: { deviceId: string }; result: Record<string, never> };
  /** つないでいる機器の特性を 1 回読む (Device Information など)。b はバイト列 (base64) */
  'ble.read': { params: { deviceId: string } & GattCharacteristicRef; result: { b: string } };
  /**
   * つないでいる機器の通知を、そのままファイルに書き足し始める (画面が消えていても続く。OS がアプリを止めても、起こし直したときに続ける)。
   * header は見出しの行 (機器の名前など)。ファイルの形は RecordingFile の説明
   */
  'recorder.start': { params: { name: string; deviceId: string; header: string[] }; result: { fileName: string } };
  'recorder.stop': { params: Record<string, never>; result: { fileName?: string; notifications?: number; bytes?: number } };
  'recorder.status': { params: Record<string, never>; result: RecorderStatus };
  'recorder.list': { params: Record<string, never>; result: { files: RecordingFile[] } };
  /** 記録の中身 (文字)。通勤の 1 時間で数 MB */
  'recorder.read': { params: { fileName: string }; result: { text: string } };
  'recorder.remove': { params: { fileName: string }; result: Record<string, never> };
  /** 記録のファイルを、OS の共有の画面で渡す (AirDrop・「ファイル」に保存など) */
  'recorder.share': { params: { fileName: string }; result: Record<string, never> };
  /** Web で作った文 (変換した CSV など) を、ファイルにして共有の画面で渡す */
  'system.shareText': { params: { fileName: string; text: string }; result: Record<string, never> };
  /**
   * 画面の自動ロックを止める・戻す (ラップタイマーを開いている間。iPhone は isIdleTimerDisabled)。
   * 2026-10-20 に足した。版は 1 のまま (足しただけ。前のアプリは not-supported を返し、Web は Wake Lock にする)
   */
  'system.keepAwake': { params: { on: boolean }; result: Record<string, never> };
  /**
   * アプリの書類のフォルダの LapTimer/ の下のファイルに、バイト列 (base64) を足す (ラップタイマーの走行の記録を、走っている間に書くため)。
   * truncate なら、はじめから書き直す。ファイルは「ファイル」アプリの「このiPhone内 → このアプリ → LapTimer」に出る。
   * 2026-10-20 に足した。版は 1 のまま (前のアプリは not-supported を返し、Web はブラウザの中のデータベースにだけ保存する)
   */
  /** createNew: 同じ名前のファイルがあれば書かずに busy を返す (新しい走行のファイルで、前の走行を上書きしないように。前のアプリは見ない) */
  'system.appendFile': { params: { path: string; b64: string; truncate?: boolean; createNew?: boolean }; result: Record<string, never> };
  /** LapTimer/ の下のファイルを、OS の共有の画面で渡す (2026-10-20 に足した) */
  'system.shareFile': { params: { path: string }; result: Record<string, never> };
  /**
   * ラップタイマーの記録の保管先 (2026-10-20 に足した。版は 1 のまま)。
   * local: この iPhone (LapTimer/<サーキット名>/)。folder: 利用者が「ファイル」で選んだフォルダ (iCloud Drive など) にも写す。
   * 走っている間は、どちらでも LapTimer/ に書く (電波がなくても記録が消えないように)
   */
  'system.storageInfo': { params: Record<string, never>; result: StorageInfo };
  /** 「ファイル」のフォルダを選ぶ画面を出し、選んだフォルダを保管先にする。やめたら not-found (message: cancelled) */
  'system.pickStorageFolder': { params: Record<string, never>; result: StorageInfo };
  /** 保管先を この iPhone に戻す */
  'system.setStorageLocal': { params: Record<string, never>; result: StorageInfo };
  /** LapTimer/ の下のファイルのうち、選んだフォルダにない・大きさの違うものを写す (保管先が local なら何もしない) */
  'system.syncLapFiles': { params: Record<string, never>; result: { kind: 'local' | 'folder'; copied: number; skipped: number; failed: number; error?: string } };
  /** LapTimer/ の下のファイルの一覧 (ラップタイムの一覧のため。exports/ は除く。2026-10-20 に足した) */
  'system.listLapFiles': { params: Record<string, never>; result: { files: Array<{ path: string; size: number; mtimeMs: number }> } };
  /** LapTimer/ の下のファイルを読む (base64) */
  'system.readLapFile': { params: { path: string }; result: { b64: string } };
  /** 走行の置き場 (選んだフォルダ、なければ LapTimer/) と、動画を読む URL の頭 (lapfile://run/。2026-10-20) */
  'system.runRoot': { params: Record<string, never>; result: { urlBase: string; kind: 'folder' | 'local'; name: string } };
  /** 走行の置き場のファイルの一覧。local: false は iCloud にだけあるファイル */
  'system.listRunFiles': { params: Record<string, never>; result: { files: Array<{ path: string; size: number; mtimeMs: number; local: boolean }> } };
  /** 走行の置き場のログ・控え (.bon4・.nmea・.json・.csv) を読む (base64) */
  'system.readRunFile': { params: { path: string }; result: { b64: string } };
  /** 走行の置き場の runs.json・laptimes.json を書く */
  'system.writeRunFile': { params: { path: string; b64: string }; result: Record<string, never> };
  /** 動画の一部を読む (base64。8 MB まで) */
  'system.readRunRange': { params: { path: string; offset: number; length: number }; result: { b64: string } };
  /** ファイルが端末にあるか・iCloud から取り込み中か */
  'system.runFileStatus': { params: { path: string }; result: { local: boolean; downloading: boolean } };
  /** iCloud からの取り込みを始める */
  'system.downloadRunFile': { params: { path: string }; result: Record<string, never> };
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
