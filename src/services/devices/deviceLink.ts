/**
 * 登録した Bluetooth LE の機器につなぎ、値を受け取る (2026-10-20、PLAN-21・22)。
 * つなぐ層 (bleCentral) は機器を問わないので、ここで機器の種類ごとに、受け取る特性と読み方を選ぶ。
 *
 * - RaceBox: 位置 (ラップタイマーの出どころ) と G・回転の速さ
 * - 心拍計: 心拍
 * - OBD-II: 回転数・車速・アクセル開度など (命令を書いて答えを読む。機器によって特性が違うので、つながらなければ別の形で試す)
 * - GoPro: 録画・印・時計合わせの命令と、状態 (録画中・電池・残り時間)。つないでいる間は 3 秒ごとにつなぎを保つ合図を送る
 */

import type { BleCentral, BleLinkState, BleNotification, GattCharacteristicRef } from '../bleCentral';
import type { LiveFix } from '../liveLapTimer';
import type { RegisteredDevice } from './deviceRegistry';
import { RACEBOX_TX_CHARACTERISTIC, RACEBOX_UART_SERVICE, RaceboxStream } from './raceboxProtocol';
import { HEART_RATE_MEASUREMENT, HEART_RATE_SERVICE, parseHeartRate } from './heartRateProtocol';
import { Elm327Client, OBD_BLE_PROFILES } from './obdElm327';
import {
  GOPRO_COMMAND, GOPRO_COMMAND_RESPONSE, GOPRO_KEEP_ALIVE_MS, GOPRO_QUERY, GOPRO_QUERY_RESPONSE, GOPRO_SERVICE, GOPRO_SETTINGS,
  GOPRO_SETTINGS_RESPONSE, GoProAssembler, goproCommands, goproKeepAlive, goproQueryStatus, packetize, parseStatusResponse, type GoProStatus
} from './goproBle';

export type DeviceSample =
  | { type: 'fix'; fix: LiveFix; values: Record<string, number> }
  | { type: 'values'; tMs: number; values: Record<string, number> }
  | { type: 'gopro'; status: GoProStatus };

/** OBD-II の 1 つの形でつながるのを待つ長さ (ミリ秒)。過ぎたら別の形で試す */
const OBD_PROFILE_WAIT_MS = 8000;
/** GoPro の状態を問い合わせる間隔 */
const GOPRO_STATUS_MS = 5000;

export class DeviceLink {
  state: BleLinkState | 'idle' = 'idle';
  error: string | null = null;
  private sampleListeners = new Set<(s: DeviceSample) => void>();
  private stateListeners = new Set<(s: DeviceLink['state']) => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private obd: Elm327Client | null = null;
  private obdProfile = 0;
  private raceboxStream = new RaceboxStream();
  private goproAsm = new Map<string, GoProAssembler>();
  private closed = false;

  constructor(
    readonly device: RegisteredDevice,
    private readonly central: BleCentral,
    private readonly now: () => number = () => Date.now()
  ) {}

  onSample(cb: (s: DeviceSample) => void): () => void {
    this.sampleListeners.add(cb);
    return () => this.sampleListeners.delete(cb);
  }

  onState(cb: (s: DeviceLink['state']) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private emit(s: DeviceSample) {
    this.sampleListeners.forEach(cb => cb(s));
  }

  private setState(s: DeviceLink['state'], error?: Error) {
    this.state = s;
    this.error = error ? error.message : null;
    this.stateListeners.forEach(cb => cb(s));
  }

  /** 受け取る特性 */
  private notifyRefs(): GattCharacteristicRef[] {
    switch (this.device.kind) {
      case 'racebox': return [{ service: RACEBOX_UART_SERVICE, characteristic: RACEBOX_TX_CHARACTERISTIC }];
      case 'hr': return [{ service: HEART_RATE_SERVICE, characteristic: HEART_RATE_MEASUREMENT }];
      case 'obd': {
        const p = OBD_BLE_PROFILES[this.obdProfile];
        return [{ service: p.service, characteristic: p.notify }];
      }
      case 'gopro': return [GOPRO_COMMAND_RESPONSE, GOPRO_SETTINGS_RESPONSE, GOPRO_QUERY_RESPONSE].map(c => ({ service: GOPRO_SERVICE, characteristic: c }));
    }
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.central.connect(this.device.id, this.notifyRefs(), {
      onState: (s, e) => this.handleState(s, e),
      onNotify: items => this.handleNotify(items)
    });
    if (this.device.kind === 'obd') {
      // つながらなければ、もう一方の形 (FFE0) で試す
      const tried = this.obdProfile;
      setTimeout(() => {
        if (this.closed || this.state === 'connected' || this.obdProfile !== tried || tried + 1 >= OBD_BLE_PROFILES.length) return;
        this.obdProfile = tried + 1;
        void this.central.disconnect(this.device.id).then(() => this.connect());
      }, OBD_PROFILE_WAIT_MS);
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.stopTimers();
    this.obd?.stop();
    this.obd = null;
    await this.central.disconnect(this.device.id);
    this.setState('disconnected');
  }

  private stopTimers() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  private handleState(s: BleLinkState, e?: Error) {
    this.setState(s, e);
    if (s !== 'connected') {
      this.stopTimers();
      this.obd?.stop();
      this.obd = null;
      return;
    }
    if (this.device.kind === 'obd' && !this.obd) {
      const p = OBD_BLE_PROFILES[this.obdProfile];
      const enc = new TextEncoder();
      this.obd = new Elm327Client(
        text => this.central.write(this.device.id, { service: p.service, characteristic: p.write }, enc.encode(text)),
        sample => this.emit({ type: 'values', tMs: sample.tMs, values: { [sample.key]: sample.value } }),
        this.now
      );
      void this.obd.start();
    }
    if (this.device.kind === 'gopro') {
      this.stopTimers();
      const keepAlive = () => this.writeGoPro(GOPRO_SETTINGS, goproKeepAlive()).catch(() => {});
      const status = () => this.writeGoPro(GOPRO_QUERY, goproQueryStatus()).catch(() => {});
      void keepAlive();
      void status();
      this.timers.push(setInterval(keepAlive, GOPRO_KEEP_ALIVE_MS), setInterval(status, GOPRO_STATUS_MS));
    }
  }

  private handleNotify(items: BleNotification[]) {
    for (const it of items) {
      switch (this.device.kind) {
        case 'racebox':
          for (const s of this.raceboxStream.push(it.bytes)) {
            this.emit({
              type: 'fix',
              fix: { tMs: s.tMs, latitude: s.latitude, longitude: s.longitude, speedKmh: s.speedKmh, altitude: s.altitude, valid: s.valid },
              values: { g_x: s.gX, g_y: s.gY, g_z: s.gZ, roll_dps: s.rollRate, pitch_dps: s.pitchRate, yaw_dps: s.yawRate, satellites: s.satellites, ...(s.battery ? { battery_pct: s.battery.percent } : {}) }
            });
          }
          break;
        case 'hr': {
          const hr = parseHeartRate(it.bytes);
          if (hr) this.emit({ type: 'values', tMs: this.now(), values: { bpm: hr.bpm } });
          break;
        }
        case 'obd':
          this.obd?.feed(it.bytes);
          break;
        case 'gopro': {
          const key = (it.characteristic ?? '').toLowerCase();
          let asm = this.goproAsm.get(key);
          if (!asm) { asm = new GoProAssembler(); this.goproAsm.set(key, asm); }
          const msg = asm.push(it.bytes);
          if (msg && key === GOPRO_QUERY_RESPONSE) {
            const status = parseStatusResponse(msg);
            if (status) this.emit({ type: 'gopro', status });
          }
          break;
        }
      }
    }
  }

  private async writeGoPro(characteristic: string, message: Uint8Array): Promise<void> {
    for (const p of packetize(message)) await this.central.write(this.device.id, { service: GOPRO_SERVICE, characteristic }, p);
  }

  /** GoPro: 録画を始める・止める */
  goproShutter(on: boolean): Promise<void> {
    return this.writeGoPro(GOPRO_COMMAND, goproCommands.shutter(on));
  }

  /** GoPro: 録画中の動画に印を付ける */
  goproHilight(): Promise<void> {
    return this.writeGoPro(GOPRO_COMMAND, goproCommands.hilight());
  }

  /** GoPro: カメラの時計を合わせる (時刻は GPS などの正しいもの、時差は端末のもの) */
  goproSetTime(at: Date): Promise<void> {
    return this.writeGoPro(GOPRO_COMMAND, goproCommands.setLocalDateTime(at, -at.getTimezoneOffset()));
  }
}
