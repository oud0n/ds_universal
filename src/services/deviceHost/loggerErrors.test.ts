import { describe, expect, it } from 'vitest';
import { BleLoggerLink } from '../bleLoggerLink';
import type { BleCentral } from '../bleCentral';
import { NativeError } from '../../native/bridge';
import { HostBleCentral } from './bleCentral';
import { FakeHost } from './fixtures.test-support';

describe('既存ロガーのエラー判定も通信経路に依存しない', () => {
  it('権限拒否は既存NativeErrorとホストエラーの両方で設定案内を有効にする', async () => {
    const host = new FakeHost();
    host.onRequest = async method => { if (method === 'ble.scan') throw { code: 'permission-denied' }; };
    const native: BleCentral = {
      kind: 'native', async scan() { throw new NativeError('permission-denied', 'denied'); },
      async stopScan() {}, async connect() {}, async disconnect() {}, async read() { return new Uint8Array(); }, async write() {}
    };
    for (const central of [native, new HostBleCentral(host)]) {
      const link = new BleLoggerLink(async () => central);
      await link.startScan();
      expect(link.getSnapshot()).toMatchObject({ permissionDenied: true, scanning: false });
      await link.stopScan();
    }
  });

  it('前の機器が見つからない自動接続は、両方のエラー型で通知を抑える', async () => {
    const host = new FakeHost();
    host.onRequest = async method => { if (method === 'ble.connect') throw { code: 'not-found' }; };
    const native: BleCentral = {
      kind: 'native', async scan() {}, async stopScan() {},
      async connect() { throw new NativeError('not-found', 'missing'); },
      async disconnect() {}, async read() { return new Uint8Array(); }, async write() {}
    };
    for (const central of [native, new HostBleCentral(host)]) {
      const link = new BleLoggerLink(async () => central);
      await link.start(); await link.register({ id: 'synthetic', name: 'Synthetic' });
      expect(link.getSnapshot().error).not.toBeNull();
      await link.connect(true);
      expect(link.getSnapshot().error).toBeNull();
      await link.forget();
    }
    expect(host.listeners.size).toBe(0);
  });
});
