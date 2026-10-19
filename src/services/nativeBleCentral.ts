/**
 * BLE の層のネイティブ版 (iPhone・Android のアプリ)。窓口の ble.* を呼び、知らせを BleCentral の形にする
 */

import { callNative, fromBase64, NativeError, onNative } from '../native/bridge';
import type { BleCentral, BleLinkHandlers } from './bleCentral';
import type { GattCharacteristicRef } from '../native/contract';
import { tr } from '../utils/i18n';

const links = new Map<string, () => void>();
let scanStop: (() => void) | null = null;

async function ensurePermission(): Promise<void> {
  const { state } = await callNative('ble.permission', { request: true });
  if (state === 'denied') {
    throw new NativeError('permission-denied', tr(
      'Bluetooth の使用が許可されていません。設定でこのアプリの Bluetooth を許可してください。',
      'Bluetooth is not allowed. Allow Bluetooth for this app in Settings.'
    ));
  }
}

function endScan(): void {
  scanStop?.();
  scanStop = null;
}

export const nativeBleCentral: BleCentral = {
  kind: 'native',

  async scan(options, onDevice, onEnd) {
    await ensurePermission();
    endScan();
    const offDevice = onNative('ble.device', d => onDevice({ id: d.deviceId, name: d.name, rssi: d.rssi }));
    const offStopped = onNative('ble.scanStopped', () => { endScan(); onEnd(); });
    scanStop = () => { offDevice(); offStopped(); };
    try {
      await callNative('ble.scan', { namePrefixes: options.namePrefixes });
    } catch (e) {
      endScan();
      throw e;
    }
  },

  async stopScan() {
    await callNative('ble.stopScan', {});
  },

  async connect(deviceId: string, notify: GattCharacteristicRef, handlers: BleLinkHandlers) {
    await ensurePermission();
    links.get(deviceId)?.();
    const offState = onNative('ble.state', e => {
      if (e.deviceId !== deviceId) return;
      handlers.onState(e.state, e.error ? new NativeError(e.error.code, e.error.message) : undefined);
    });
    const offNotify = onNative('ble.notify', e => {
      if (e.deviceId !== deviceId) return;
      handlers.onNotify(e.items.map(it => ({ tMs: it.t / 1e6, bytes: fromBase64(it.b) })));
    });
    links.set(deviceId, () => { offState(); offNotify(); });
    try {
      await callNative('ble.connect', { deviceId, notify: [notify], autoReconnect: true, highThroughput: true });
    } catch (e) {
      links.get(deviceId)?.();
      links.delete(deviceId);
      throw e;
    }
  },

  async disconnect(deviceId) {
    try {
      await callNative('ble.disconnect', { deviceId });
    } finally {
      links.get(deviceId)?.();
      links.delete(deviceId);
    }
  },

  async read(deviceId, ref) {
    const { b } = await callNative('ble.read', { deviceId, ...ref });
    return fromBase64(b);
  },

  async openSettings() {
    await callNative('system.openSettings', {});
  }
};
