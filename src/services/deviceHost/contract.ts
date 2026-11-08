import type { BleDeviceInfo, BleLinkState, BleScanOptions, GattCharacteristicRef } from '../bleCentral';

/** IPCへ渡す値はJSONだけ。実機の所有・権限・再接続はホストが受け持つ。 */
export interface HostFault {
  code: 'permission-denied' | 'not-found' | 'not-connected' | 'cancelled' | 'not-supported' | 'io' | 'invalid-data';
  /** 診断用。利用者向けの文言はcodeから作る。 */
  detail?: string;
}
export interface SerialOptions {
  vendorId: number;
  productId: number;
  baudRate: number;
  dataBits: 8;
  stopBits: 1;
  parity: 'none';
  flowControl: 'none';
  dataTerminalReady: boolean;
  requestToSend: boolean;
}
export const LOGGER_SERIAL_OPTIONS: Readonly<SerialOptions> = Object.freeze({
  vendorId: 0x2dcf, productId: 0x6002, baudRate: 115200, dataBits: 8,
  stopBits: 1, parity: 'none', flowControl: 'none', dataTerminalReady: true, requestToSend: true
});
export interface HostCommands {
  'serial.open': { params: { session: string; options: SerialOptions }; result: void };
  'serial.write': { params: { session: string; bytes: number[] }; result: { written: number } };
  'serial.close': { params: { session: string }; result: void };
  'ble.scan': { params: { session: string; options: BleScanOptions }; result: void };
  'ble.stopScan': { params: { session: string }; result: void };
  'ble.connect': { params: { session: string; deviceId: string; notify: GattCharacteristicRef[]; autoReconnect: true }; result: void };
  'ble.disconnect': { params: { session: string }; result: void };
  'ble.read': { params: { session: string; epoch: number; ref: GattCharacteristicRef }; result: { bytes: number[] } };
  'ble.write': { params: { session: string; epoch: number; ref: GattCharacteristicRef; bytes: number[] }; result: void };
}
export type HostEvent = { session: string } & (
  | { type: 'serial.data'; bytes: number[] }
  | { type: 'serial.interrupted' }
  | { type: 'serial.lost'; error: HostFault }
  | { type: 'ble.device'; device: BleDeviceInfo }
  | { type: 'ble.scanEnded' }
  | { type: 'ble.state'; epoch: number; state: BleLinkState; error?: HostFault }
  | { type: 'ble.notify'; epoch: number; items: { tMs: number; bytes: number[]; characteristic?: string }[] }
);
export interface DeviceHost {
  /** 返した時点で購読済み。解除は同期。画面を跨いでsessionを再利用しない。 */
  listen(receive: (event: HostEvent) => void): Promise<() => void>;
  request<K extends keyof HostCommands>(method: K, params: HostCommands[K]['params']): Promise<HostCommands[K]['result']>;
}
export type Localize = (ja: string, en: string) => string;
export class DeviceHostError extends Error {
  constructor(readonly code: HostFault['code'], message: string, readonly detail?: string) {
    super(message);
    this.name = 'DeviceHostError';
  }
}
const messages: Record<HostFault['code'], [string, string]> = {
  'permission-denied': ['機器の使用が許可されていません。', 'Device access is not allowed.'],
  'not-found': ['機器が見つかりません。', 'The device was not found.'],
  'not-connected': ['機器につながっていません。', 'The device is not connected.'],
  cancelled: ['機器の操作を取り消しました。', 'The device operation was cancelled.'],
  'not-supported': ['この機器の操作には対応していません。', 'This device operation is not supported.'],
  io: ['機器との通信に失敗しました。', 'Communication with the device failed.'],
  'invalid-data': ['機器の通信窓口から不正なデータを受信しました。', 'Invalid data was received from the device host.']
};
export const japanese: Localize = ja => ja;
export function hostError(error: unknown, t: Localize): DeviceHostError {
  if (error instanceof DeviceHostError) return error;
  const fault = error as Partial<HostFault> | null;
  const code = typeof fault?.code === 'string' && Object.prototype.hasOwnProperty.call(messages, fault.code) ? fault.code : 'io';
  return new DeviceHostError(code, t(...messages[code]), typeof fault?.detail === 'string' ? fault.detail : undefined);
}
/** 1回のIPCを制限。ホストは大きな受信を分割し、USBの送信はアダプターが分割する。 */
export const MAX_HOST_BYTES = 65536;
export function hostBytes(bytes: number[], t: Localize): Uint8Array {
  if (!Array.isArray(bytes) || bytes.length > MAX_HOST_BYTES) {
    throw hostError({ code: 'invalid-data' }, t);
  }
  for (const b of bytes) {
    if (!Number.isInteger(b) || b < 0 || b > 255) throw hostError({ code: 'invalid-data' }, t);
  }
  return Uint8Array.from(bytes);
}
export type SessionId = () => string;
export const newSessionId: SessionId = () => globalThis.crypto.randomUUID();

/** 片方が失敗しても、すでに始めた他の終了が済むまで次の接続を許さない。 */
export async function finishTeardown(previous: Promise<void> | null | undefined, operation: Promise<void>): Promise<void> {
  const results = await Promise.allSettled(previous ? [previous, operation] : [operation]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
