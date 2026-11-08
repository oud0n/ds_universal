import type {
  BleCentral, BleDeviceInfo, BleLinkHandlers, BleLinkState, BleScanOptions, GattCharacteristicRef
} from '../bleCentral';
import {
  type DeviceHost, type HostEvent, type Localize, type SessionId,
  hostBytes, hostError, japanese, MAX_HOST_BYTES, newSessionId
} from './contract';

interface Subscription { id: string; off?: () => void }
interface Link extends Subscription { epoch: number; state: BleLinkState; handlers: BleLinkHandlers; error?: Error }
interface Scan extends Subscription { onEnd: () => void }

/** OS側のBLEを既存BleCentralへ接続する。再接続・MTU分割はホストの担当。 */
export class HostBleCentral implements BleCentral {
  readonly kind = 'native' as const;
  private links = new Map<string, Link>();
  private scanning: Scan | null = null;
  constructor(private readonly host: DeviceHost, private readonly t: Localize = japanese,
    private readonly makeId: SessionId = newSessionId) {}

  async scan(options: BleScanOptions, onDevice: (d: BleDeviceInfo) => void, onEnd: () => void): Promise<void> {
    const previous = this.scanning;
    if (previous) this.endScan(previous);
    const s: Scan = { id: this.makeId(), onEnd };
    this.scanning = s;
    try {
      if (previous) await this.host.request('ble.stopScan', { session: previous.id });
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
      this.endScan(s);
      await this.host.request('ble.stopScan', { session: s.id }).catch(() => {});
      throw hostError(error, this.t);
    }
  }
  async stopScan(): Promise<void> {
    const s = this.scanning;
    if (!s) return;
    this.endScan(s);
    try { await this.host.request('ble.stopScan', { session: s.id }); }
    catch (error) { throw hostError(error, this.t); }
  }
  private endScan(s: Scan): void {
    if (this.scanning !== s) return;
    this.scanning = null;
    s.off?.();
    s.onEnd();
  }

  async connect(deviceId: string, notify: GattCharacteristicRef | GattCharacteristicRef[], handlers: BleLinkHandlers): Promise<void> {
    const previous = this.links.get(deviceId);
    if (previous) this.detach(deviceId, previous);
    const s: Link = { id: this.makeId(), epoch: 0, state: 'connecting', handlers };
    this.links.set(deviceId, s);
    try {
      if (previous) await this.host.request('ble.disconnect', { session: previous.id });
      if (this.links.get(deviceId) !== s) throw s.error ?? hostError({ code: 'cancelled' }, this.t);
      const off = await this.host.listen(event => this.receive(deviceId, s, event));
      s.off = off;
      if (this.links.get(deviceId) !== s) { off(); throw hostError({ code: 'cancelled' }, this.t); }
      await this.host.request('ble.connect', {
        session: s.id, deviceId, notify: (Array.isArray(notify) ? notify : [notify]).map(ref => ({ ...ref })), autoReconnect: true
      });
      if (this.links.get(deviceId) !== s) throw s.error ?? hostError({ code: 'cancelled' }, this.t);
    } catch (error) {
      this.detach(deviceId, s);
      await this.host.request('ble.disconnect', { session: s.id }).catch(() => {});
      throw hostError(error, this.t);
    }
  }
  async disconnect(deviceId: string): Promise<void> {
    const s = this.links.get(deviceId);
    if (!s) return;
    this.detach(deviceId, s);
    try { await this.host.request('ble.disconnect', { session: s.id }); }
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
      try { s.handlers.onState('disconnected', hostError(error, this.t)); }
      finally { void this.host.request('ble.disconnect', { session: s.id }).catch(() => {}); }
    }
  }
}
