/**
 * BLE の層の Web Bluetooth 版 (パソコン・Android の Chrome / Edge と Electron。Safari にはない)。
 *
 * Web Bluetooth は周りの機器を一覧にできないので、探すときはブラウザの機器の選択画面を出す。
 * ページを開き直したあとは、前に選んだ機器を navigator.bluetooth.getDevices() で探す (ない・使えないブラウザでは、もう一度選んでもらう)。
 * つなぎ直しはここで行う (切れたら、間をあけて試し続ける)
 */

import type { BleCentral, BleLinkHandlers } from './bleCentral';
import { uuidForWeb } from './bleCentral';
import type { GattCharacteristicRef } from '../native/contract';
import { NativeError } from '../native/bridge';
import { tr } from '../utils/i18n';

// Web Bluetooth の型 (TypeScript の標準の型にないので、使う分だけ)
interface WbCharacteristic extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<WbCharacteristic>;
  readValue(): Promise<DataView>;
  writeValue?(value: BufferSource): Promise<void>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  properties?: { write?: boolean; writeWithoutResponse?: boolean };
}
interface WbService {
  getCharacteristic(uuid: number | string): Promise<WbCharacteristic>;
}
interface WbServer {
  connected: boolean;
  connect(): Promise<WbServer>;
  disconnect(): void;
  getPrimaryService(uuid: number | string): Promise<WbService>;
}
interface WbDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: WbServer;
}
interface WbBluetooth {
  requestDevice(options: { filters: Array<{ namePrefix: string }>; optionalServices: Array<number | string> }): Promise<WbDevice>;
  getDevices?: () => Promise<WbDevice[]>;
}

function bluetooth(): WbBluetooth {
  return (navigator as unknown as { bluetooth: WbBluetooth }).bluetooth;
}

/** 選ばれた機器 (このページを開いている間) */
const known = new Map<string, WbDevice>();

/** つなぎ直しの間隔 (ミリ秒)。最後の値をくり返す */
const RETRY_MS = [1000, 2000, 3000, 5000];

interface Link {
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cleanup: () => void;
}
const links = new Map<string, Link>();

async function findDevice(id: string): Promise<WbDevice | null> {
  const cached = known.get(id);
  if (cached) return cached;
  const all = await bluetooth().getDevices?.().catch(() => [] as WbDevice[]);
  const found = all?.find(d => d.id === id) ?? null;
  if (found) known.set(id, found);
  return found;
}

export const webBluetoothCentral: BleCentral = {
  kind: 'web',

  async scan(options, onDevice, onEnd) {
    try {
      const device = await bluetooth().requestDevice({
        filters: options.namePrefixes.map(namePrefix => ({ namePrefix })),
        optionalServices: options.services.map(uuidForWeb)
      });
      known.set(device.id, device);
      onDevice({ id: device.id, name: device.name ?? '' });
    } catch (e) {
      // 選択画面を閉じた (NotFoundError) ときは、見つからなかっただけ
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    } finally {
      onEnd();
    }
  },

  async stopScan() {
    // 選択画面はブラウザのものなので、こちらからは閉じられない
  },

  async connect(deviceId: string, notifyRefs: GattCharacteristicRef | GattCharacteristicRef[], handlers: BleLinkHandlers) {
    const notifyList = Array.isArray(notifyRefs) ? notifyRefs : [notifyRefs];
    links.get(deviceId)?.cleanup();
    const device = await findDevice(deviceId);
    // 探している間に、もう一度 connect が呼ばれていたら、そちらのつなぎを片づけてから始める (つなぎを 2 つ持たない)
    links.get(deviceId)?.cleanup();
    if (!device?.gatt) {
      throw new NativeError('not-found', tr(
        '前に選んだ機器が見つかりません。「探す」からもう一度選んでください。',
        'The device chosen before was not found. Choose it again with "Search".'
      ));
    }
    const gatt = device.gatt;
    const link: Link = { closed: false, timer: null, cleanup: () => {} };
    links.set(deviceId, link);

    // 通知はどの特性からかも付けて渡す (通知を複数受け取るとき)
    const listeners = new Map<WbCharacteristic, (ev: Event) => void>();
    const onValueOf = (uuid: string) => (ev: Event) => {
      const v = (ev.target as WbCharacteristic).value;
      if (!v) return;
      handlers.onNotify([{ tMs: performance.now(), bytes: new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)), characteristic: uuid }]);
    };
    const unsubscribe = () => {
      listeners.forEach((fn, c) => c.removeEventListener('characteristicvaluechanged', fn));
      listeners.clear();
    };
    let attempt = 0;

    const tryConnect = async (state: 'connecting' | 'reconnecting') => {
      if (link.closed) return;
      handlers.onState(state);
      try {
        const server = await gatt.connect();
        unsubscribe();
        for (const ref of notifyList) {
          const service = await server.getPrimaryService(uuidForWeb(ref.service));
          const c = await service.getCharacteristic(uuidForWeb(ref.characteristic));
          const fn = onValueOf(ref.characteristic);
          c.addEventListener('characteristicvaluechanged', fn);
          listeners.set(c, fn);
          await c.startNotifications();
        }
        if (link.closed) { gatt.disconnect(); return; }
        attempt = 0;
        handlers.onState('connected');
      } catch (e) {
        if (link.closed) return;
        console.warn('[ble] つなげない、あとで試す:', e);
        link.timer = setTimeout(() => tryConnect(state), RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
      }
    };

    const onLost = () => {
      if (link.closed) return;
      void tryConnect('reconnecting');
    };
    device.addEventListener('gattserverdisconnected', onLost);
    link.cleanup = () => {
      link.closed = true;
      if (link.timer) clearTimeout(link.timer);
      device.removeEventListener('gattserverdisconnected', onLost);
      unsubscribe();
      if (gatt.connected) gatt.disconnect();
    };
    void tryConnect('connecting');
  },

  async disconnect(deviceId) {
    links.get(deviceId)?.cleanup();
    links.delete(deviceId);
  },

  async read(deviceId, ref) {
    const gatt = known.get(deviceId)?.gatt;
    if (!gatt?.connected) throw new NativeError('not-connected', tr('つながっていません。', 'Not connected.'));
    const service = await gatt.getPrimaryService(uuidForWeb(ref.service));
    const v = await (await service.getCharacteristic(uuidForWeb(ref.characteristic))).readValue();
    return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  },

  async write(deviceId, ref, bytes) {
    const gatt = known.get(deviceId)?.gatt;
    if (!gatt?.connected) throw new NativeError('not-connected', tr('つながっていません。', 'Not connected.'));
    const service = await gatt.getPrimaryService(uuidForWeb(ref.service));
    const c = await service.getCharacteristic(uuidForWeb(ref.characteristic));
    const data = bytes.slice();
    // 答えのある書き込みができればそれで、できなければ答えなしで書く
    if (c.properties?.write === false && c.writeValueWithoutResponse) await c.writeValueWithoutResponse(data);
    else if (c.writeValueWithResponse) await c.writeValueWithResponse(data);
    else if (c.writeValue) await c.writeValue(data);
    else throw new NativeError('not-supported', tr('この機器には書けません。', 'This device cannot be written to.'));
  }
};
