/**
 * デジスパイスとの BLE のつなぎ (ペアリング・機器の登録) と、届いた測位 (PLAN-01、docs/iphone_app_design.md の 4)。
 *
 * - 探す: 名前が DS3 / DS4 で始まる機器を一覧にする (シリアル番号は名前の番号の部分)
 * - 登録する: 選んだ機器を覚え、次からはロガー設定・ラップタイマーの画面を開いたときに自動でつなぐ。OS のペアリング (ボンディング) はしない
 * - つないでいる間に切れたら、BLE の層 (bleCentral) がつなぎ直す。測位が途切れた間は gaps に残す
 * - 届いた通知は BleFixAssembler で測位にして、onFix で渡す (ラップタイマー・記録はここから受け取る)
 *
 * 画面は subscribe / getSnapshot (useSyncExternalStore) で状態を読む
 */

import { getBleCentral, type BleCentral, type BleDeviceInfo, type BleLinkState, type BleNotification } from './bleCentral';
import {
  BleFixAssembler,
  LOCATION_AND_NAVIGATION_SERVICE,
  LOCATION_AND_SPEED_CHARACTERISTIC,
  type BleFix
} from './digspiceBleProtocol';
import { NativeError } from '../native/bridge';
import { tr } from '../utils/i18n';

/** 探すときの名前の頭 (デジスパイスIII・IV) */
export const DIGSPICE_NAME_PREFIXES = ['DS3', 'DS4'];

const SERVICE = LOCATION_AND_NAVIGATION_SERVICE.toString(16).padStart(4, '0');
/** 標準の Device Information (メーカー・型番・シリアル番号・版) */
const DEVICE_INFORMATION_SERVICE = '180a';
const DEVICE_INFORMATION: Array<[string, string]> = [
  ['manufacturer', '2a29'],
  ['model', '2a24'],
  ['serial', '2a25'],
  ['hardware', '2a27'],
  ['firmware', '2a26'],
  ['software', '2a28']
];
const CHARACTERISTIC = LOCATION_AND_SPEED_CHARACTERISTIC.toString(16).padStart(4, '0');

const STORAGE_KEY = 'ds_ble_logger_device';
/** 利用者が切断ボタンで切ったか (アプリを起動し直しても、ロガー設定を開いただけではつなぎに行かないため。2026-10-20) */
const USER_OFF_KEY = 'ds_ble_logger_user_off';
function loadUserOff(): boolean {
  try { return localStorage.getItem(USER_OFF_KEY) === '1'; } catch { return false; }
}
function saveUserOff(off: boolean): void {
  try { if (off) localStorage.setItem(USER_OFF_KEY, '1'); else localStorage.removeItem(USER_OFF_KEY); } catch { /* 覚えられなくてもよい */ }
}
/** これより長く測位が来なければ、途切れとして残す (秒) */
const GAP_SEC = 0.5;
/** これより長く測位が来なければ、測位待ちに戻す (ミリ秒) */
const FIX_STALE_MS = 1500;
/** 何 Hz かを数える幅 (GPS の時刻のミリ秒。届いた時刻は 100 ms ごとにまとまるので、測位の時刻で数える) */
const RATE_WINDOW_MS = 2000;

export interface RegisteredLogger {
  id: string;
  name: string;
}

/** 画面に出す状態 */
export type LoggerLinkStatus =
  | 'unsupported' // この環境では BLE を使えない
  | 'none'        // 登録していない
  | 'idle'        // 登録してあるが、つないでいない
  | 'connecting'
  | 'reconnecting'
  | 'waiting'     // つながったが、測位できていない
  | 'fixing';     // 測位できている

export interface FixGap {
  /** 最後に届いた測位の時刻 (UTC ミリ秒) */
  fromUtcMs: number;
  /** 次に届いた測位の時刻 (UTC ミリ秒) */
  toUtcMs: number;
}

export interface LoggerLinkSnapshot {
  status: LoggerLinkStatus;
  centralKind: BleCentral['kind'] | null;
  registered: RegisteredLogger | null;
  scanning: boolean;
  found: BleDeviceInfo[];
  lastFix: BleFix | null;
  rateHz: number;
  gaps: FixGap[];
  error: string | null;
  /** 許可を断られたので、設定の画面への案内を出す */
  permissionDenied: boolean;
  /** 本体の情報 (Device Information。読めたものだけ) */
  deviceInfo: Record<string, string>;
}

/** デバイス名 (DS4B + 7 桁) の番号の部分。デジスパイスの名前でなければ名前のまま */
export function loggerSerial(name: string): string {
  const m = /^DS[34][A-Z]?(\d+)$/.exec(name);
  return m ? m[1] : name;
}

function loadRegistered(): RegisteredLogger | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.id === 'string' && typeof v?.name === 'string' ? { id: v.id, name: v.name } : null;
  } catch {
    return null;
  }
}

function saveRegistered(r: RegisteredLogger | null): void {
  try {
    if (r) localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 保存できなくても、このページを開いている間は使える
  }
}

function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return tr('Bluetooth でつなげませんでした。', 'Could not connect over Bluetooth.');
}

export class BleLoggerLink {
  private central: BleCentral | null = null;
  private linkState: Exclude<BleLinkState, 'disconnected'> | 'idle' = 'idle';
  private assembler = new BleFixAssembler();
  private fixTimes: number[] = [];
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private fixListeners = new Set<(fix: BleFix, receivedMs: number) => void>();
  private rawListeners = new Set<(items: BleNotification[]) => void>();
  private stateListeners = new Set<(state: BleLinkState) => void>();
  private snap: LoggerLinkSnapshot;
  private ready: Promise<void> | null = null;

  constructor(private readonly centralSource: () => Promise<BleCentral | null> = getBleCentral) {
    this.snap = {
      status: 'unsupported',
      centralKind: null,
      registered: loadRegistered(),
      scanning: false,
      found: [],
      lastFix: null,
      rateHz: 0,
      gaps: [],
      error: null,
      permissionDenied: false,
      deviceInfo: {}
    };
  }

  // ---- 画面から読む ----

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getSnapshot = (): LoggerLinkSnapshot => this.snap;

  /** 測位を受け取る (受け取った時刻は BLE の層の単調な時計のミリ秒) */
  onFix(fn: (fix: BleFix, receivedMs: number) => void): () => void {
    this.fixListeners.add(fn);
    return () => { this.fixListeners.delete(fn); };
  }

  /** 届いた通知をそのまま受け取る (ブラウザでの記録に使う) */
  onRaw(fn: (items: BleNotification[]) => void): () => void {
    this.rawListeners.add(fn);
    return () => { this.rawListeners.delete(fn); };
  }

  /** つなぎの状態が変わったとき (BLE の層からの状態そのまま) */
  onLinkState(fn: (state: BleLinkState) => void): () => void {
    this.stateListeners.add(fn);
    return () => { this.stateListeners.delete(fn); };
  }

  /** BLE の層 (記録の手段を選ぶのに使う) */
  getCentral(): BleCentral | null {
    return this.central;
  }

  // ---- 操作 ----

  /**
   * BLE の層を用意する (アプリを開いたとき)。つなぐのは、ロガー設定・ラップタイマーの画面を開いたとき (startAndConnect)。
   * アプリを開くたびにつなぎに行くと、サーキットの外でも探し続けて電池を使うため (2026-10-20 決定)
   */
  start(): Promise<void> {
    this.ready ??= (async () => {
      this.central = await this.centralSource();
      this.update({ centralKind: this.central?.kind ?? null });
      this.refreshStatus();
    })();
    return this.ready;
  }

  /**
   * BLE の層を用意し、登録してある機器につないでいなければつなぐ (ロガー設定・ラップタイマーの画面を開いたとき)。
   * 利用者が切断ボタンで切っていたら、ロガー設定を開いただけではつながない (force: ラップタイマーを開いたときは、使うつもりなのでつなぐ)
   */
  async startAndConnect(force = false): Promise<void> {
    await this.start();
    if (!force && loadUserOff()) return;
    if (this.central && this.snap.registered && this.linkState === 'idle') await this.connect(true);
  }

  /** つないでいない (つなぎに行ってもいない) か。ラップタイマーが、自分でつないだ接続だけを閉じるときに切るため */
  isLinkIdle(): boolean {
    return this.linkState === 'idle';
  }

  /** 利用者が切断ボタンで切る (起動し直しても、自分でつなぐまでつなぎに行かない) */
  async disconnectByUser(): Promise<void> {
    saveUserOff(true);
    await this.disconnect();
  }

  async startScan(): Promise<void> {
    await this.start();
    const central = this.central;
    if (!central || this.snap.scanning) return;
    this.update({ scanning: true, found: [], error: null });
    try {
      await central.scan(
        { namePrefixes: DIGSPICE_NAME_PREFIXES, services: [SERVICE, DEVICE_INFORMATION_SERVICE] },
        d => {
          const found = this.snap.found.filter(f => f.id !== d.id);
          found.push(d);
          found.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
          this.update({ found });
        },
        () => this.update({ scanning: false })
      );
    } catch (e) {
      this.fail(e);
      this.update({ scanning: false });
    }
  }

  async stopScan(): Promise<void> {
    if (!this.central || !this.snap.scanning) return;
    await this.central.stopScan().catch(() => {});
    this.update({ scanning: false });
  }

  /** 選んだ機器を登録してつなぐ (前に登録していた機器は外す) */
  async register(device: BleDeviceInfo): Promise<void> {
    await this.stopScan();
    const prev = this.snap.registered;
    if (prev && prev.id !== device.id) await this.disconnect();
    const registered = { id: device.id, name: device.name };
    saveRegistered(registered);
    this.update({ registered, found: [] });
    await this.connect();
  }

  /** 登録を外す (つないでいれば切る) */
  async forget(): Promise<void> {
    await this.disconnect();
    saveRegistered(null);
    this.update({ registered: null });
    this.refreshStatus();
  }

  /** 登録した機器につなぐ。auto (アプリを開いたとき) なら、前の機器が見つからなくても知らせない (ブラウザでは選び直しが要るため) */
  async connect(auto = false): Promise<void> {
    const central = this.central;
    const registered = this.snap.registered;
    if (!central || !registered) return;
    // つなぐ (自分で押した・ラップタイマーを開いた) ので、切断ボタンで切った印は外す
    saveUserOff(false);
    this.assembler.reset();
    // 新しくつなぐときは、前のつなぎの測位と途切れを持ち越さない (前の日の測位との差を途切れと数えないため)。
    // つなぎ直し (BLE の層が切れて戻る) の間は持ち越して、途切れを残す
    this.fixTimes = [];
    this.update({ error: null, permissionDenied: false, lastFix: null, gaps: [], rateHz: 0 });
    this.setLinkState('connecting');
    try {
      await central.connect(
        registered.id,
        { service: SERVICE, characteristic: CHARACTERISTIC },
        {
          onState: (state, error) => {
            if (state !== 'connected') this.assembler.reset();
            if (error) this.update({ error: messageOf(error) });
            this.setLinkState(state);
            this.stateListeners.forEach(fn => fn(state));
            if (state === 'connected') void this.readDeviceInfo();
          },
          onNotify: items => {
            this.rawListeners.forEach(fn => fn(items));
            this.handleNotify(items);
          }
        }
      );
    } catch (e) {
      if (!(auto && e instanceof NativeError && e.code === 'not-found')) this.fail(e);
      this.setLinkState('idle');
    }
  }

  async disconnect(): Promise<void> {
    const central = this.central;
    const registered = this.snap.registered;
    if (!central || !registered || this.linkState === 'idle') return;
    this.setLinkState('idle');
    await central.disconnect(registered.id).catch(e => console.warn('[ble] 切るときに失敗:', e));
  }

  /** 本体の情報を読む (つながるたび。読めないものは飛ばす) */
  private async readDeviceInfo(): Promise<void> {
    const central = this.central;
    const registered = this.snap.registered;
    if (!central || !registered) return;
    const info: Record<string, string> = {};
    for (const [key, characteristic] of DEVICE_INFORMATION) {
      try {
        const bytes = await central.read(registered.id, { service: DEVICE_INFORMATION_SERVICE, characteristic });
        const text = new TextDecoder().decode(bytes).replace(/\0+$/, '').trim();
        if (text) info[key] = text;
      } catch {
        // 本体にない・読めない項目は飛ばす
      }
    }
    if (Object.keys(info).length) this.update({ deviceInfo: info });
  }

  async openSettings(): Promise<void> {
    await this.central?.openSettings?.();
  }

  // ---- 中の処理 ----

  private handleNotify(items: BleNotification[]): void {
    let lastFix: BleFix | null = null;
    const gaps: FixGap[] = [];
    for (const item of items) {
      const fix = this.assembler.push(item.bytes);
      if (!fix) continue;
      const prev = lastFix ?? this.snap.lastFix;
      if (prev && fix.timestamp.getTime() - prev.timestamp.getTime() > GAP_SEC * 1000) {
        gaps.push({ fromUtcMs: prev.timestamp.getTime(), toUtcMs: fix.timestamp.getTime() });
      }
      lastFix = fix;
      this.fixTimes.push(fix.timestamp.getTime());
      this.fixListeners.forEach(fn => fn(fix, item.tMs));
    }
    if (!lastFix) return;
    const cutoff = lastFix.timestamp.getTime() - RATE_WINDOW_MS;
    while (this.fixTimes.length && this.fixTimes[0] < cutoff) this.fixTimes.shift();
    const span = this.fixTimes.length > 1 ? this.fixTimes[this.fixTimes.length - 1] - this.fixTimes[0] : 0;
    const rateHz = span > 0 ? Math.round(((this.fixTimes.length - 1) * 1000) / span) : 0;
    this.update({ lastFix, rateHz, gaps: gaps.length ? [...this.snap.gaps, ...gaps] : this.snap.gaps });
    this.armStaleTimer();
    this.refreshStatus();
  }

  /** 測位が来なくなったら、測位待ちに戻す */
  private armStaleTimer(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      this.fixTimes = [];
      this.update({ rateHz: 0 });
      this.refreshStatus();
    }, FIX_STALE_MS);
  }

  private setLinkState(state: BleLinkState | 'idle'): void {
    this.linkState = state === 'disconnected' ? 'idle' : state;
    if (this.linkState !== 'connected') {
      this.fixTimes = [];
      if (this.staleTimer) clearTimeout(this.staleTimer);
      this.staleTimer = null;
      this.update({ rateHz: 0 });
    }
    this.refreshStatus();
  }

  private refreshStatus(): void {
    let status: LoggerLinkStatus;
    if (!this.central) status = 'unsupported';
    else if (!this.snap.registered) status = 'none';
    else if (this.linkState === 'connected') {
      const fresh = this.snap.lastFix?.valid && this.staleTimer !== null;
      status = fresh ? 'fixing' : 'waiting';
    } else status = this.linkState;
    if (status !== this.snap.status) this.update({ status });
  }

  private fail(e: unknown): void {
    const denied = e instanceof NativeError && e.code === 'permission-denied';
    this.update({ error: messageOf(e), permissionDenied: denied });
  }

  private update(patch: Partial<LoggerLinkSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach(fn => fn());
  }
}

/** アプリで 1 つだけ使う */
export const bleLoggerLink = new BleLoggerLink();
