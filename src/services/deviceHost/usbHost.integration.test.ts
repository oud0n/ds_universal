import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DeviceHost, HostEvent } from './contract';
import { HostSerialTransport } from './serialTransport';
import { DigSpiceDevice } from '../digspiceDevice';
import { WebSerialTransport } from '../webSerialTransport';
import { webSerialFixture } from './fixtures.test-support';
import { ptyPeer } from './pty.test-support';
const { UsbHostBroker } = createRequire(import.meta.url)(resolve('electron/usb-host.cjs'));
const executable = process.env.LAPLOUPE_USB_TEST_BINARY;
const enabled = !!executable && process.platform !== 'win32';
function createHost(port: string) {
  const listeners = new Set<(e: HostEvent) => void>();
  const broker = new UsbHostBroker({ executable, args: ['--test-port', port], onEvent: (e: HostEvent) => {
    [...listeners].forEach(fn => fn(e));
  } });
  const host: DeviceHost = { async listen(receive) { listeners.add(receive); return () => { listeners.delete(receive); }; },
    request: (method, params) => broker.request(method, params) };
  return { broker, transport: new HostSerialTransport(host), listeners };
}
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(!enabled)('実Rustプロセス＋OS疑似シリアル線', () => {
  it.each([7, 65536])('応答分割%d: 既存Web経路と設定/取得全バイト/送信全バイトが一致', async fragment => {
    const pty = await ptyPeer(fragment), native = createHost(pty.port), old = webSerialFixture(fragment);
    const results = [];
    try {
      for (const transport of [new WebSerialTransport(async () => old.port), native.transport]) {
        const device = new DigSpiceDevice(); await device.connect(transport);
        try { results.push({ config: await device.getDeviceConfig(), buffer: (await device.downloadLogs()).buffer }); }
        finally { await device.disconnect(); }
      }
      expect(results[1]).toEqual(results[0]); expect(results[1].buffer).toEqual(pty.peer.image);
      expect(pty.peer.writes).toEqual(old.peer.writes);
      expect(native.listeners.size).toBe(0); expect(native.broker.active).toBeNull();
    } finally { await native.broker.dispose(); await pty.stop(); }
  }, 30000);

  it.each(['missing', 'conflict', 'bad-checksum'] as const)('%sの異常でも既存Web経路と同じ失敗を返す', async mode => {
    const pty = await ptyPeer(64, mode), native = createHost(pty.port), old = webSerialFixture(64);
    old.peer.mode = mode;
    const errors: string[] = [];
    try {
      for (const transport of [new WebSerialTransport(async () => old.port), native.transport]) {
        const device = new DigSpiceDevice(); await device.connect(transport);
        try { await device.downloadLogs(); errors.push('unexpected success'); }
        catch (error) { errors.push((error as Error).message); }
        finally { await device.disconnect(); }
      }
      expect(errors[1]).toBe(errors[0]); expect(errors[1]).not.toBe('unexpected success');
      expect(pty.peer.writes).toEqual(old.peer.writes);
    } finally { await native.broker.dispose(); await pty.stop(); }
  }, 30000);

  it('疑似ケーブル断で応答待機を直ちに中止し、Rustプロセスも終了する', async () => {
    const pty = await ptyPeer(), native = createHost(pty.port), device = new DigSpiceDevice();
    try {
      await device.connect(native.transport);
      const waiting = expect(device.waitForLine('$never', 60000)).rejects.toBeInstanceOf(Error);
      await pty.unplug(); await waiting;
      expect(device.isConnected()).toBe(false);
      await native.broker.close(native.broker.active?.session ?? 'retired');
      expect(native.broker.active).toBeNull(); expect(native.listeners.size).toBe(0);
    } finally { await native.broker.dispose(); await pty.stop(); }
  }, 10000);
});
