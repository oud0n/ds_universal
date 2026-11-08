import { vi } from 'vitest';
import type { BleCentral, BleLinkHandlers, GattCharacteristicRef } from '../bleCentral';
import { webBluetoothCentral } from '../webBluetoothCentral';
import { HostBleCentral } from './bleCentral';
import { FakeHost, flush } from './fixtures.test-support';

const key = (uuid: number | string) => typeof uuid === 'number' ? uuid.toString(16).padStart(4, '0') : uuid.toLowerCase();
export interface BleFixture {
  central: BleCentral;
  deviceId: string;
  writes: { ref: GattCharacteristicRef; bytes: number[] }[];
  refs: GattCharacteristicRef[];
  notify: (bytes: number[], ref: GattCharacteristicRef) => void;
  reconnect: () => Promise<void>;
}
let nextDevice = 0;
/** 独立したWeb Bluetoothの模擬GATT。DataViewのoffsetも含めて既存実装を実行する。 */
export function webBleFixture(): BleFixture {
  const deviceId = `synthetic-${++nextDevice}`, writes: BleFixture['writes'] = [], refs: GattCharacteristicRef[] = [];
  const chars = new Map<string, Characteristic>();
  class Characteristic extends EventTarget {
    value = new DataView(new ArrayBuffer(0));
    properties = { write: true };
    constructor(readonly ref: GattCharacteristicRef) { super(); }
    async startNotifications() { refs.push(this.ref); return this; }
    async readValue() { return new DataView(Uint8Array.of(99, 1, 2, 3, 99).buffer, 1, 3); }
    async writeValueWithResponse(bytes: Uint8Array) { writes.push({ ref: this.ref, bytes: Array.from(bytes) }); }
  }
  const char = (ref: GattCharacteristicRef) => {
    const id = `${ref.service}/${ref.characteristic}`;
    if (!chars.has(id)) chars.set(id, new Characteristic(ref));
    return chars.get(id)!;
  };
  const device = Object.assign(new EventTarget(), {
    id: deviceId, name: 'Synthetic', gatt: {
      connected: false,
      async connect() { this.connected = true; return this; },
      disconnect() { this.connected = false; },
      async getPrimaryService(service: number | string) {
        return { getCharacteristic: async (c: number | string) => char({ service: key(service), characteristic: key(c) }) };
      }
    }
  });
  vi.stubGlobal('navigator', { bluetooth: {
    requestDevice: async () => device, getDevices: async () => [device]
  } });
  return {
    central: webBluetoothCentral, deviceId, writes, refs,
    notify(bytes, ref) {
      const c = char(ref), padded = Uint8Array.from([99, ...bytes, 99]);
      c.value = new DataView(padded.buffer, 1, bytes.length);
      c.dispatchEvent(new Event('characteristicvaluechanged'));
    },
    async reconnect() {
      device.gatt.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
      await flush();
    }
  };
}

export function hostBleFixture(): BleFixture {
  const host = new FakeHost(), deviceId = `synthetic-${++nextDevice}`;
  const writes: BleFixture['writes'] = [], refs: GattCharacteristicRef[] = [];
  let session = '', epoch = 1;
  host.onRequest = async (method, params) => {
    if (method === 'ble.scan') {
      host.emit({ type: 'ble.device', session: params.session, device: { id: deviceId, name: 'Synthetic' } });
      host.emit({ type: 'ble.scanEnded', session: params.session });
    } else if (method === 'ble.connect' && 'notify' in params) {
      session = params.session;
      refs.push(...params.notify);
      host.emit({ type: 'ble.state', session, epoch, state: 'connecting' });
      host.emit({ type: 'ble.state', session, epoch, state: 'connected' });
    } else if (method === 'ble.read') return { bytes: [1, 2, 3] };
    else if (method === 'ble.write' && 'ref' in params && 'bytes' in params) writes.push({ ref: params.ref, bytes: params.bytes });
  };
  return {
    central: new HostBleCentral(host), deviceId, writes, refs,
    notify(bytes, ref) { host.emit({ type: 'ble.notify', session, epoch,
      items: [{ tMs: 1234, bytes, characteristic: ref.characteristic }] }); },
    async reconnect() {
      epoch++;
      host.emit({ type: 'ble.state', session, epoch, state: 'reconnecting' });
      refs.push(...refs.slice(0));
      host.emit({ type: 'ble.state', session, epoch, state: 'connected' });
      await flush();
    }
  };
}

export async function recordBle(f: BleFixture, ref: GattCharacteristicRef) {
  const states: string[] = [], notifications: unknown[] = [], found: string[] = [];
  let ended = 0;
  await f.central.scan({ namePrefixes: ['Synthetic'], services: [ref.service] }, d => found.push(d.name), () => ended++);
  const handlers: BleLinkHandlers = { onState: state => states.push(state), onNotify: items => {
    notifications.push(...items.map(i => ({ ...i, bytes: Array.from(i.bytes) })));
  } };
  await f.central.connect(f.deviceId, ref, handlers); await flush();
  f.notify([0, 88], ref);
  const read = await f.central.read(f.deviceId, ref);
  await f.central.write(f.deviceId, ref, Uint8Array.of(1, 2, 3));
  await f.reconnect();
  f.notify([1, 44, 1], ref);
  await f.central.disconnect(f.deviceId);
  f.notify([0, 99], ref);
  return { states, notifications, read, writes: f.writes, found, ended, refs: f.refs };
}
