/**
 * Bluetooth Classic のシリアル (SPP) を、BLE と同じ形 (BleCentral) で使う (2026-10-25。Android のアプリだけ)。
 * Drogger の DG-PRO1S などは Bluetooth Classic で NMEA を送ってくる。読み方 (DroggerStream) とラップタイマーは BLE の Drogger と同じものを使う。
 * 探す (scan) は、OS の機器を選ぶ画面を出して、選ばれた 1 台を知らせる (ペアリングもその画面で済む)
 */
import type { BleCentral, BleLinkHandlers } from './bleCentral';
import { callNative, fromBase64, hasNative, nativeCapabilities, onNative } from '../native/bridge';

const handlers = new Map<string, BleLinkHandlers>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  onNative('spp.state', e => handlers.get(e.deviceId)?.onState(e.state, e.error ? new Error(e.error.message) : undefined));
  onNative('spp.data', e => handlers.get(e.deviceId)?.onNotify(e.items.map(it => ({ tMs: it.t / 1e6, bytes: fromBase64(it.b) }))));
}

export const sppCentral: BleCentral = {
  kind: 'native',
  async scan(options, onDevice, onEnd) {
    try {
      const d = await callNative('spp.pick', { namePrefixes: options.namePrefixes });
      onDevice({ id: d.deviceId, name: d.name });
    } finally {
      onEnd();
    }
  },
  async stopScan() {},
  async connect(deviceId, _notify, h) {
    listen();
    handlers.set(deviceId, h);
    await callNative('spp.connect', { deviceId });
  },
  async disconnect(deviceId) {
    await callNative('spp.disconnect', { deviceId }).catch(() => {});
    handlers.delete(deviceId);
  },
  async read() {
    throw new Error('not supported');
  },
  async write() {
    throw new Error('not supported');
  }
};

/** Bluetooth Classic を使えるか (Android のアプリ) */
export async function sppAvailable(): Promise<boolean> {
  if (!hasNative()) return false;
  return !!(await nativeCapabilities())?.features.spp;
}

/** 確かめの記録を送る */
export function shareSppLog(): Promise<unknown> {
  return callNative('spp.shareLog', {});
}
