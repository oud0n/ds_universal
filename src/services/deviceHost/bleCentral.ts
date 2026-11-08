import type {
  BleCentral, BleDeviceInfo, BleLinkHandlers, BleLinkState, BleScanOptions, GattCharacteristicRef
} from '../bleCentral';
import {
  type DeviceHost, type HostEvent, type Localize, type SessionId,
  finishTeardown, hostBytes, hostError, japanese, MAX_HOST_BYTES, newSessionId
} from './contract';

interface Subscription { id: string; off?: () => void }
interface Link extends Subscription { epoch: number; state: BleLinkState; handlers: BleLinkHandlers; error?: Error }
interface Scan extends Subscription { onEnd: () => void; ended: boolean }

/** OS側のBLEを既存BleCentralへ接続する。再接続・MTU分割はホストの担当。 */
export class HostBleCentral implements BleCentral {
  readonly kind = 'native' as const;
  private links = new Map<string, Link>();
  private scanning: Scan | null = null;
  private scanClosing: Promise<void> | null = null;
  private linkClosing = new Map<string, Promise<void>>();
  constructor(private readonly host: DeviceHost, private readonly t: Localize = japanese,
    private readonly makeId: SessionId = newSessionId) {}

  async scan(options: BleScanOptions, onDevice: (d: BleDeviceInfo) => void, onEnd: () => void): Promise<void> {
    const previous = this.scanning;
    const s: Scan = { id: this.makeId(), onEnd, ended: false };
    this.scanning = s;
    try {
      const closing = previous ? this.closeScan(previous, true) : this.scanClosing;
      if (previous) this.endScan(previous);
      await closing;
      if (this.scanning !== s) return;
      const off = await this.host.listen(event => {
        if (this.scanning !== s || event.session !== s.id) return;
        if (event.type === 'ble.device') onDevice({ ...event.device });
        else if (event.type === 'ble.scanEnded') this.endScan(s);
      });
      s.off = off;
      if (this.scanning !== s) { off(); return; }
      await this.host.request('ble.scan', { session: s.id, options: {
        namePrefixes: [...options.namePrefixes], services: [...options.services],
        ...(options.advertisedServices ? { advertisedServices: [...options.advertisedServices] } : {})
      } });
    } catch (error) {
      const closing = this.closeScan(s, true);
      this.endScan(s);
      await closing.catch(() => {});
      throw hostError(error, this.t);
    }
  }
  async stopScan(): Promise<void> {
    const s = this.scanning;
    if (!s) { await this.scanClosing; return; }
    const closing = this.closeScan(s, true);
    this.endScan(s);
    try { await closing; }
    catch (error) { throw hostError(error, this.t); }
  }
  private endScan(s: Scan): void {
    if (s.ended) return;
    s.ended = true;
    if (this.scanning === s) this.scanning = null;
    s.off?.();
    s.off = undefined;
    s.onEnd();
  }

  async connect(deviceId: string, notify: GattCharacteristicRef | GattCharacteristicRef[], handlers: BleLinkHandlers): Promise<void> {
    const previous = this.links.get(deviceId);
    if (previous) this.detach(deviceId, previous);
    const s: Link = { id: this.makeId(), epoch: 0, state: 'connecting', handlers };
    this.links.set(deviceId, s);
    try {
      await (previous ? this.closeLink(deviceId, previous) : this.linkClosing.get(deviceId));
      if (this.links.get(deviceId) !== s) throw s.error ?? hostError({ code: 'cancelled' }, this.t);
      const off = await this.host.listen(event => this.receive(deviceId, s, event));
      s.off = off;
      if (this.links.get(deviceId) !== s) { this.detach(deviceId, s); throw s.error ?? hostError({ code: 'cancelled' }, this.t); }
      await this.host.request('ble.connect', {
        session: s.id, deviceId, notify: (Array.isArray(notify) ? notify : [notify]).map(ref => ({ ...ref })), autoReconnect: true
      });
      if (this.links.get(deviceId) !== s) throw s.error ?? hostError({ code: 'cancelled' }, this.t);
    } catch (error) {
      this.detach(deviceId, s);
      await this.closeLink(deviceId, s).catch(() => {});
      throw hostError(error, this.t);
    }
  }
  async disconnect(deviceId: string): Promise<void> {
    const s = this.links.get(deviceId);
    if (!s) return;
    this.detach(deviceId, s);
    try { await this.closeLink(deviceId, s); }
    catch (error) { throw hostError(error, this.t); }
  }
  async read(deviceId: string, ref: GattCharacteristicRef): Promise<Uint8Array> {
    const s = this.connected(deviceId), epoch = s.epoch;
    try {
      const result = await this.host.request('ble.read', { session: s.id, epoch, ref: { ...ref } });
      this.check(deviceId, s, epoch);
      return hostBytes(result.bytes, this.t);
    } catch (error) { throw hostError(error, this.t); }
  }
  async write(deviceId: string, ref: GattCharacteristicRef, bytes: Uint8Array): Promise<void> {
    const s = this.connected(deviceId), epoch = s.epoch;
    if (bytes.length > MAX_HOST_BYTES) throw hostError({ code: 'invalid-data' }, this.t);
    try {
      await this.host.request('ble.write', { session: s.id, epoch, ref: { ...ref }, bytes: Array.from(bytes) });
      this.check(deviceId, s, epoch);
    } catch (error) { throw hostError(error, this.t); }
  }
  // 終了命令はすぐ送り、さらに前の終了待ちも引き継ぐ。
  // A→B→Cの置換で、まだ開いていないBの終了だけを待ってAを追い越さない。
  private closeLink(deviceId: string, s: Link, afterNotification = false): Promise<void> {
    const close = () => this.host.request('ble.disconnect', { session: s.id });
    const closing = finishTeardown(this.linkClosing.get(deviceId), afterNotification ? Promise.resolve().then(close) : close());
    this.linkClosing.set(deviceId, closing);
    const clear = () => { if (this.linkClosing.get(deviceId) === closing) this.linkClosing.delete(deviceId); };
    void closing.then(clear, clear);
    return closing;
  }
  private closeScan(s: Scan, afterNotification = false): Promise<void> {
    const close = () => this.host.request('ble.stopScan', { session: s.id });
    const closing = finishTeardown(this.scanClosing, afterNotification ? Promise.resolve().then(close) : close());
    this.scanClosing = closing;
    const clear = () => { if (this.scanClosing === closing) this.scanClosing = null; };
    void closing.then(clear, clear);
    return closing;
  }

  private connected(deviceId: string): Link {
    const s = this.links.get(deviceId);
    if (!s || s.state !== 'connected') throw hostError({ code: 'not-connected' }, this.t);
    return s;
  }
  private check(deviceId: string, s: Link, epoch: number): void {
    if (this.links.get(deviceId) !== s || s.state !== 'connected' || s.epoch !== epoch) {
      throw hostError({ code: 'cancelled' }, this.t);
    }
  }
  private detach(deviceId: string, s: Link): void {
    if (this.links.get(deviceId) === s) this.links.delete(deviceId);
    s.off?.();
    s.off = undefined;
  }
  private receive(deviceId: string, s: Link, event: HostEvent): void {
    if (this.links.get(deviceId) !== s || event.session !== s.id) return;
    if (event.type !== 'ble.state' && event.type !== 'ble.notify') return;
    try {
      if (!Number.isSafeInteger(event.epoch) || event.epoch < 1) throw hostError({ code: 'invalid-data' }, this.t);
      if (event.type === 'ble.state') {
        if (event.epoch < s.epoch) return;
        s.epoch = event.epoch;
        s.state = event.state;
        if (event.state === 'disconnected') {
          s.error = hostError(event.error ?? { code: 'not-connected' }, this.t);
          this.detach(deviceId, s);
        }
        s.handlers.onState(event.state, event.error ? hostError(event.error, this.t) : undefined);
      } else if (event.epoch === s.epoch && s.state === 'connected') {
        const items = event.items.map(item => {
          if (!Number.isFinite(item.tMs) || item.tMs < 0) throw hostError({ code: 'invalid-data' }, this.t);
          return { ...item, bytes: hostBytes(item.bytes, this.t) };
        });
        s.handlers.onNotify(items);
      }
    } catch (error) {
      this.detach(deviceId, s);
      const closing = this.closeLink(deviceId, s, true);
      try { s.handlers.onState('disconnected', hostError(error, this.t)); }
      finally { void closing.catch(() => {}); }
    }
  }
}
