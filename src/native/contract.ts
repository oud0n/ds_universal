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
 * files などは、作るときにここへ足す (camera は 2026-10-25 に足した)
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
  /** iap: アプリ内課金 (投げ銭) が使える (2026-10-24 に足した。前の版のアプリには無いので、無いときは使えないとみなす) */
  /** camera: 内蔵カメラで録画できる (2026-10-25 に足した。前の版のアプリには無い) */
  /** spp: Bluetooth Classic のシリアル (Android だけ。Drogger DG-PRO1S など。2026-10-25) */
  features: { ble: boolean; iap?: boolean; camera?: boolean; spp?: boolean };
}

/** 内蔵カメラの画質 */
export type CameraPreset = '1080p30' | '1080p60' | '2160p30' | '2160p60';

/** 内蔵カメラのレンズ (その端末にあるもの)。zoom は広角を 1 とした倍率 (超広角 0.5・望遠 3 など) */
export interface CameraLens {
  id: string;
  position: 'back' | 'front';
  kind: 'ultraWide' | 'wide' | 'tele' | 'front';
  zoom: number;
  isoMin: number;
  isoMax: number;
  presets: CameraPreset[];
}

/** 撮り終えた動画のファイル (止まって分かれたら複数)。startWallMs は先頭のコマの端末の時計 (UTC ミリ秒) */
export interface CameraFile {
  path: string;
  startWallMs: number;
  durationSec: number;
  bytes: number;
}

/** アプリ内課金の商品 (値段はその国の通貨で、App Store が書いたもの) */
export interface IapProduct {
  id: string;
  displayName: string;
  description: string;
  displayPrice: string;
}

/** BLE の特性の指定。UUID は 16 ビットの短い形 ('2a67') か、128 ビットの形 */
export interface GattCharacteristicRef {
  service: string;
  characteristic: string;
}

export interface BleScanParams {
  /** 名前がこれで始まる機器を知らせる */
  namePrefixes: string[];
  /** 広告にこのサービスを載せている機器も知らせる (名前がまちまちな心拍計・GoPro など。2026-10-20 に足した。前のアプリは見ない) */
  services?: string[];
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
  /** アプリ内課金の商品を読む (安い順) */
  'iap.products': { params: { ids: string[] }; result: { products: IapProduct[] } };
  /** 買う。pending は保護者の承認待ちなど (決まったら知らせ iap.purchased が来る) */
  'iap.purchase': { params: { id: string }; result: { status: 'purchased' | 'cancelled' | 'pending' } };
  'ble.permission': { params: { request: boolean }; result: { state: PermissionState } };
  'ble.scan': { params: BleScanParams; result: Record<string, never> };
  'ble.stopScan': { params: Record<string, never>; result: Record<string, never> };
  'ble.connect': { params: BleConnectParams; result: Record<string, never> };
  'ble.disconnect': { params: { deviceId: string }; result: Record<string, never> };
  /** つないでいる機器の特性を 1 回読む (Device Information など)。b はバイト列 (base64) */
  'ble.read': { params: { deviceId: string } & GattCharacteristicRef; result: { b: string } };
  /**
   * 特性に書く (b は base64)。答えのある書き込みができる特性は、書き終わってから返す (2026-10-20 に足した。版は 1 のまま。前のアプリは not-supported)。
   * OBD-II の命令・GoPro の操作に使う。暗号化が要る機器でペアリングしていなければ permission-denied
   */
  'ble.write': { params: { deviceId: string; b: string } & GattCharacteristicRef; result: Record<string, never> };
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
   * 画面の向き (ラップタイマー)。2026-10-21 に足した。版は 1 のまま (前のアプリは not-supported を返し、Web は何もしない)。
   * system = ふつう (端末の回転と画面の向きのロックに従う)、auto = 傾き (重力の向き) で縦横を決める (画面の向きのロックが入っていても)、
   * portrait / landscape = その向きに固める (横は傾きで左右を選ぶ)、hold = 今の向きのまま固める (測っている間)
   */
  /**
   * iPhone の G センサーを読み始める・やめる (ラップタイマーで測っている間)。値は知らせ system.motion で 0.5 秒ごとにまとめて来る。
   * 2026-10-21 に足した。版は 1 のまま (前のアプリは not-supported を返し、Web は記録しない)
   */
  'system.motionStart': { params: { hz: number }; result: Record<string, never> };
  'system.motionStop': { params: Record<string, never>; result: Record<string, never> };
  'system.setOrientation': { params: { mode: 'system' | 'auto' | 'portrait' | 'landscape' | 'hold' }; result: { orientation: 'portrait' | 'landscape' } };
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
   * local: この iPhone (LapTimer/<サーキット名>/)。folder: 利用者が「ファイル」で選んだフォルダ (iCloud Drive など)。
   * 書いている間は、どちらでも LapTimer/ に書く。folder では、書き終えたファイルを選んだフォルダへ移す (system.syncLapFiles。
   * 2026-10-21 からはアプリの中に控えを残さない。残すと、選んだフォルダで消したものを写し直して戻してしまうため)
   */
  'system.storageInfo': { params: Record<string, never>; result: StorageInfo };
  /** 「ファイル」のフォルダを選ぶ画面を出し、選んだフォルダを保管先にする。やめたら not-found (message: cancelled) */
  'system.pickStorageFolder': { params: Record<string, never>; result: StorageInfo };
  /** 保管先を この iPhone に戻す */
  'system.setStorageLocal': { params: Record<string, never>; result: StorageInfo };
  /**
   * LapTimer/ の下のファイルを、選んだフォルダへ移す (保管先が local なら何もしない)。書いている最中のファイル (system.closeFiles で
   * まだ閉じていないもの) は、選んだフォルダにない・大きさの違うときに写すだけ (copied)。書き終えたものは写してからアプリの中から消す (moved)。
   * 写せなかったものはアプリの中に残し、次に移す。moved は 2026-10-21 に足した (前のアプリは返さず、写すだけ)
   */
  'system.syncLapFiles': { params: Record<string, never>; result: { kind: 'local' | 'folder'; copied: number; moved?: number; skipped: number; failed: number; error?: string } };
  /**
   * 書き終えたファイル (system.appendFile で書いたもの) を知らせる (2026-10-21 に足した。前のアプリは not-supported)。
   * all: 全部 (ページを読み込んだとき。読み込み直したあとは前の走行のファイルに書き足さない)。prefix: その名前で始まるもの (走行を閉じたとき。
   * .nmea・.bon4・センサーの .csv)。paths: そのファイル (取り込み終えたとき)。open は、まだ書いている最中のファイルの数
   */
  'system.closeFiles': { params: { all?: boolean; prefix?: string; paths?: string[] }; result: { open: number } };
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
  /** 内蔵カメラ (とマイク) の許可。request なら、まだ聞いていないものを聞く */
  'camera.permission': { params: { request: boolean; audio: boolean }; result: { camera: PermissionState; mic: PermissionState } };
  'camera.lenses': { params: Record<string, never>; result: { lenses: CameraLens[] } };
  /**
   * 録画を始める (一時ファイルに書く)。向きは今の画面の向き。iso を決めたら、シャッターの速さで明るさを保つ (null は自動)。
   * preview なら、撮り始めの 5 秒だけ右上に小さく映す
   */
  'camera.start': { params: { lensId: string | null; preset: CameraPreset; audio: boolean; iso: number | null; preview: boolean }; result: { lensId: string; preset: CameraPreset } };
  /** 止める。path (LapTimer/ の下の道。.nmea と同じ所の .mov) があれば、そこへ移す (止まって分かれたものは _2・_3 を付ける) */
  'camera.stop': { params: { path: string | null }; result: { files: CameraFile[] } };
  /**
   * 撮る前の確かめ: 画面の rect (CSS の座標) に今の映像を出す (show: false で消す)。出している間は camera.exposure が届く。
   * レンズ・画質を変えたら、もう一度呼ぶ
   */
  'camera.preview': { params: { show: boolean; lensId?: string | null; preset?: CameraPreset; iso?: number | null; rect?: { x: number; y: number; w: number; h: number } }; result: Record<string, never> };
  /** ISO をその場で変える (null は自動) */
  'camera.setIso': { params: { iso: number | null }; result: Record<string, never> };
  /**
   * Bluetooth Classic のシリアル (SPP。Android だけ)。OS の機器を選ぶ画面を出し、選んだ機器とペアリングする。
   * namePrefixes を渡すと、その名前で始まる機器だけを出す (空なら全部)
   */
  'spp.pick': { params: { namePrefixes: string[] }; result: { deviceId: string; name: string } };
  /** つなぐ。切れたら、spp.disconnect まで自分でつなぎ直す。受け取ったバイト列は spp.data で届く */
  'spp.connect': { params: { deviceId: string }; result: Record<string, never> };
  'spp.disconnect': { params: { deviceId: string }; result: Record<string, never> };
  /** 確かめの記録 (受け取った行・つなぐ / 切れる / ペアリングの結果・機種と OS の版) を、共有の画面で送る */
  'spp.shareLog': { params: Record<string, never>; result: Record<string, never> };
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
  /** G センサーの値 (列ごとの配列。t: UTC ミリ秒、g*: 重力の向き、u*: 重力を除いた加速度 (G)、r*: 回転の速さ (rad/s)。端末の向きのまま) */
  'system.motion': MotionBatch;
  /** 保留だった購入などが、あとで終わった */
  'iap.purchased': { productId: string };
  /** 録画の様子。error: interrupted (裏に回った・電話など。戻ると続きを撮る)・thermal (熱すぎて止めた) */
  'camera.state': { recording: boolean; error?: 'interrupted' | 'thermal'; thermal?: 'nominal' | 'fair' | 'serious' | 'critical' };
  /** 今の ISO とシャッターの速さ (秒)。確かめの映像を出している間、0.3 秒ごと */
  'camera.exposure': { iso: number; shutterSec: number };
  /** Bluetooth Classic のつなぎの様子 (ble.state と同じ形) */
  'spp.state': BleStateEvent;
  /** 受け取ったバイト列 (100 ms ごとにまとめる。t は受け取った時刻 (単調な時計のナノ秒)、b は base64) */
  'spp.data': { deviceId: string; items: Array<{ t: number; b: string }> };
}

export interface MotionBatch {
  t: number[];
  gx: number[]; gy: number[]; gz: number[];
  ux: number[]; uy: number[]; uz: number[];
  rx: number[]; ry: number[]; rz: number[];
}
