/**
 * ラップタイマーで使う Bluetooth LE の機器 (2026-10-20、PLAN-21・22。2026-10-21 に画面から切り出した。作る順番の 4)。
 * - 位置 (RaceBox・Drogger。出どころに選んだものだけ): 測位を onFix に渡す
 * - センサー (心拍計・OBD-II): 走行のファイルができたら、同じ名前の .csv に値を書く (RaceBox の G・回転の速さも)
 * - カメラ (GoPro): 測り始めたら時計を合わせて録画を始め、周を終えるたびに印を付け、止めたら録画を止める
 * 画面 (React) に依らない。様子は subscribe / getSnapshot で読む
 */

import { getBleCentral } from '../bleCentral';
import { sppCentral } from '../sppCentral';
import { DeviceLink, type DeviceSample } from '../devices/deviceLink';
import { loadDevices, type RegisteredDevice } from '../devices/deviceRegistry';
import { SensorCsvRecorder } from '../sensorCsvRecorder';
import type { LiveFix } from '../liveLapTimer';

/** 画面に出す機器の様子 */
export interface LapDeviceStatus {
  device: RegisteredDevice;
  state: string;
  /** 直近の値 (心拍・回転数・録画中か など) */
  text: string;
  ok: boolean;
}

export type PositionDeviceKind = 'racebox' | 'drogger';

/** 列の名前 (機器の種類ごと) */
const COLUMNS: Record<string, string[]> = {
  hr: ['bpm'],
  obd: ['rpm', 'speed_kmh', 'throttle_pct', 'coolant_c', 'intake_c', 'load_pct'],
  racebox: ['g_x', 'g_y', 'g_z', 'roll_dps', 'pitch_dps', 'yaw_dps', 'satellites', 'battery_pct'],
  drogger: ['satellites', 'fix_quality']
};

export interface LapDeviceSetDeps {
  /** 位置の機器の測位 */
  onFix: (fix: LiveFix) => void;
  /** 今の走行のファイルの名前 (拡張子なし。まだ無ければ null) */
  runBase: () => string | null;
  /** 試験で差し替える */
  getCentral?: typeof getBleCentral;
  devices?: RegisteredDevice[];
}

export class LapDeviceSet {
  /** 登録した機器 (作ったときに読む。開いている間は変えない) */
  readonly devices: RegisteredDevice[];
  private links: DeviceLink[] = [];
  private recorders = new Map<string, SensorCsvRecorder>();
  /** 測定開始の時刻 (走り始めてから、走行のファイルができるまでの値を取っておくため。PLAN-29 の (3)) */
  private runStartMs: number | null = null;
  /** 走行のファイルができる前に届いた値 (機器ごと) */
  private pending = new Map<string, Array<{ tMs: number; values: Record<string, number> }>>();
  private cameraRunning = false;
  /** 測り始めたが、カメラがまだつながっていない (つながったら録画を始める) */
  private pendingCameraStart: Date | null = null;
  private statuses: LapDeviceStatus[] = [];
  private listeners = new Set<() => void>();
  /** つないでいる位置の機器 (null: 位置の機器は使っていない)。undefined: つないでいない */
  private connectedPosition: PositionDeviceKind | null | undefined = undefined;
  private generation = 0;

  constructor(private readonly deps: LapDeviceSetDeps) {
    this.devices = deps.devices ?? loadDevices();
  }

  get racebox(): RegisteredDevice | null {
    return this.devices.find(d => d.kind === 'racebox') ?? null;
  }

  get drogger(): RegisteredDevice | null {
    return this.devices.find(d => d.kind === 'drogger') ?? null;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  getSnapshot = (): LapDeviceStatus[] => this.statuses;

  get isConnected(): boolean {
    return this.connectedPosition !== undefined;
  }

  private setStatuses(next: LapDeviceStatus[]) {
    this.statuses = next;
    this.listeners.forEach(l => l());
  }

  private update(id: string, patch: Partial<LapDeviceStatus>) {
    this.setStatuses(this.statuses.map(s => (s.device.id === id ? { ...s, ...patch } : s)));
  }

  /**
   * つなぐ: 位置の機器 (選んだもの) と、センサー・カメラ。もうつないでいて位置の機器が同じなら何もしない。
   * 位置の機器が替わったら、いったん切ってつなぎ直す
   */
  async connect(position: PositionDeviceKind | null): Promise<void> {
    if (this.connectedPosition === position) return;
    if (this.connectedPosition !== undefined) await this.disconnect();
    const gen = ++this.generation;
    this.connectedPosition = position;
    const positionDevice = position === 'racebox' ? this.racebox : position === 'drogger' ? this.drogger : null;
    // 位置の機器 (RaceBox・Drogger) は選んだものだけ、センサーとカメラはいつも
    const wanted = this.devices.filter(d => (d.kind !== 'racebox' && d.kind !== 'drogger') || d.id === positionDevice?.id);
    if (wanted.length === 0) return;
    this.setStatuses(wanted.map(device => ({ device, state: 'connecting', text: '', ok: false })));
    // Bluetooth Classic の機器 (Android の Drogger DG-PRO1S など) は、BLE と同じ形の SPP の層でつなぐ
    const central = wanted.some(d => d.transport !== 'spp') ? await (this.deps.getCentral ?? getBleCentral)() : null;
    if (gen !== this.generation) return;
    for (const d of wanted) {
      const c = d.transport === 'spp' ? sppCentral : central;
      if (!c) continue;
      const link = new DeviceLink(d, c);
      this.links.push(link);
      link.onState(s => {
        this.update(d.id, { state: s, ok: s === 'connected' });
        // 測定開始のあとにつながったカメラは、つながったところで録画を始める
        if (s === 'connected' && d.kind === 'gopro' && this.pendingCameraStart) this.startCamera(link, this.pendingCameraStart);
      });
      link.onSample((s: DeviceSample) => this.onSample(d, s));
      void link.connect().catch(e => this.update(d.id, { state: 'disconnected', text: e instanceof Error ? e.message : String(e) }));
    }
  }

  private onSample(d: RegisteredDevice, s: DeviceSample) {
    if (s.type === 'fix') {
      this.deps.onFix(s.fix);
      this.record(d, s.fix.tMs, s.values);
      this.update(d.id, { text: s.fix.valid ? `${s.values.satellites ?? ''} SV` : '測位待ち' });
    } else if (s.type === 'values') {
      this.record(d, s.tMs, s.values);
      const v = s.values;
      const text = v.bpm !== undefined ? `${v.bpm} bpm` : v.rpm !== undefined ? `${Math.round(v.rpm)} rpm` : '';
      if (text) this.update(d.id, { text });
    } else {
      this.update(d.id, { text: `${s.status.encoding ? 'REC' : '—'}${s.status.batteryPercent !== undefined ? ` · ${s.status.batteryPercent}%` : ''}`, ok: !!s.status.encoding || !this.cameraRunning });
    }
  }

  /** 切る (録画を止め、センサーの値を書いてから) */
  async disconnect(): Promise<void> {
    if (this.connectedPosition === undefined) return;
    this.generation++;
    this.connectedPosition = undefined;
    this.pendingCameraStart = null;
    const current = this.links;
    this.links = [];
    this.setStatuses([]);
    if (this.cameraRunning) {
      this.cameraRunning = false;
      await Promise.all(current.filter(l => l.device.kind === 'gopro').map(l => l.goproShutter(false).catch(() => {})));
    }
    await Promise.all([...this.recorders.values()].map(r => r.flush()));
    this.recorders.clear();
    await Promise.all(current.map(l => l.disconnect().catch(() => {})));
  }

  /** センサーの値を、走行と同じ名前の .csv にためる (走行のファイルができてから) */
  private record(d: RegisteredDevice, tMs: number, values: Record<string, number>) {
    const base = this.deps.runBase();
    const columns = COLUMNS[d.kind];
    if (!columns) return;
    if (!base) {
      // 走り始めてから走行のファイルができるまで (コースが決まるまで最大 10 秒ほど) の値は取っておく
      if (this.runStartMs !== null && tMs >= this.runStartMs) {
        const list = this.pending.get(d.id) ?? [];
        list.push({ tMs, values });
        if (list.length > 2000) list.shift();
        this.pending.set(d.id, list);
      }
      return;
    }
    const key = `${base}|${d.id}`;
    let rec = this.recorders.get(key);
    if (!rec) {
      rec = new SensorCsvRecorder(base, d.fileName, columns);
      this.recorders.set(key, rec);
      // ファイルができる前に取っておいた値を先に書く
      for (const p of this.pending.get(d.id) ?? []) rec.add(p.tMs, p.values);
      this.pending.delete(d.id);
    }
    rec.add(tMs, values);
  }

  /** ためたセンサーの値を書く (ラップタイマーの保存と一緒に) */
  flush(): void {
    for (const r of this.recorders.values()) void r.flush();
  }

  /** 走り始めた: カメラの時計を合わせて録画を始める (1 回の走行で 1 回)。まだつながっていないカメラは、つながったときに始める */
  startRun(at: Date): void {
    this.runStartMs = at.getTime();
    this.pending.clear();
    if (this.cameraRunning) return;
    this.pendingCameraStart = at;
    const cams = this.links.filter(l => l.device.kind === 'gopro' && l.state === 'connected');
    for (const c of cams) this.startCamera(c, at);
  }

  private startCamera(c: DeviceLink, at: Date): void {
    this.cameraRunning = true;
    void c.goproSetTime(at).catch(() => {}).then(() => c.goproShutter(true)).catch(() => {});
  }

  /** 周を終えた: 動画に印を付ける */
  lap(): void {
    if (!this.cameraRunning) return;
    for (const c of this.links.filter(l => l.device.kind === 'gopro')) void c.goproHilight().catch(() => {});
  }

  /** 走行を終えた (周を数え直す): 録画を止め、センサーの値を書き、次の走行の .csv に替える */
  stopRun(): Promise<void> {
    this.pendingCameraStart = null;
    this.runStartMs = null;
    this.pending.clear();
    if (this.cameraRunning) {
      this.cameraRunning = false;
      for (const c of this.links.filter(l => l.device.kind === 'gopro')) void c.goproShutter(false).catch(() => {});
    }
    // 書き終わるのを返す (書き終えてから選んだフォルダへ写すため)
    const flushes = [...this.recorders.values()].map(r => r.flush());
    this.recorders.clear();
    return Promise.all(flushes).then(() => {});
  }
}
