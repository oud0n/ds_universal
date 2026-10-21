import { describe, expect, it, vi } from 'vitest';
import { DeviceLink, type DeviceSample } from './deviceLink';
import type { BleCentral, BleLinkHandlers, GattCharacteristicRef } from '../bleCentral';
import type { RegisteredDevice } from './deviceRegistry';

/** 偽のつなぐ層 (つないだら connected を知らせ、書いたものを覚える) */
function fakeCentral() {
  const writes: Array<{ ref: GattCharacteristicRef; bytes: number[] }> = [];
  let handlers: BleLinkHandlers | null = null;
  let notify: GattCharacteristicRef[] = [];
  const central: BleCentral = {
    kind: 'native',
    scan: async () => {},
    stopScan: async () => {},
    connect: async (_id, refs, h) => { handlers = h; notify = Array.isArray(refs) ? refs : [refs]; setTimeout(() => h.onState('connected'), 0); },
    disconnect: async () => {},
    read: async () => new Uint8Array(),
    write: async (_id, ref, bytes) => { writes.push({ ref, bytes: Array.from(bytes) }); }
  };
  return { central, writes, send: (bytes: number[], characteristic?: string) => handlers!.onNotify([{ tMs: 0, bytes: Uint8Array.from(bytes), characteristic }]), notify: () => notify };
}
const dev = (kind: RegisteredDevice['kind']): RegisteredDevice => ({ id: 'x', kind, bleName: 'x', displayName: 'x', fileName: kind, addedAt: 0 });
const tick = () => new Promise(r => setTimeout(r, 5));

describe('機器につなぐ', () => {
  it('心拍計: 標準の特性を受け取り、心拍を出す', async () => {
    const f = fakeCentral();
    const link = new DeviceLink(dev('hr'), f.central, () => 123);
    const got: DeviceSample[] = [];
    link.onSample(s => got.push(s));
    await link.connect();
    expect(f.notify()).toEqual([{ service: '180d', characteristic: '2a37' }]);
    f.send([0x00, 88]);
    expect(got).toEqual([{ type: 'values', tMs: 123, values: { bpm: 88 } }]);
  });

  it('GoPro: 3 つの答えの特性を受け取り、つながったら合図と状態の問い合わせを送る。録画の命令を書く', async () => {
    vi.useFakeTimers();
    const f = fakeCentral();
    const link = new DeviceLink(dev('gopro'), f.central);
    const got: DeviceSample[] = [];
    link.onSample(s => got.push(s));
    await link.connect();
    expect(f.notify().length).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.map(w => w.bytes)).toEqual([[0x03, 0x5b, 0x01, 0x42], [0x05, 0x13, 0x08, 0x0a, 0x23, 0x46]]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.writes.length).toBe(3);
    await link.goproShutter(true);
    expect(f.writes[f.writes.length - 1].bytes).toEqual([0x03, 0x01, 0x01, 0x01]);
    // 状態の答え (分かれずに届く): 録画中・電池 87%
    f.send([0x08, 0x13, 0x00, 10, 1, 1, 70, 1, 87], 'b5f90077-aa8d-11e3-9046-0002a5d5c51b');
    expect(got).toEqual([{ type: 'gopro', status: { encoding: true, batteryPercent: 87 } }]);
    await link.disconnect();
    vi.useRealTimers();
  });

  it('OBD-II: つながったら初期化の命令を書く', async () => {
    const f = fakeCentral();
    const link = new DeviceLink(dev('obd'), f.central);
    await link.connect();
    await tick();
    expect(f.notify()).toEqual([{ service: 'fff0', characteristic: 'fff1' }]);
    expect(new TextDecoder().decode(Uint8Array.from(f.writes[0].bytes))).toBe('ATZ\r');
    expect(f.writes[0].ref).toEqual({ service: 'fff0', characteristic: 'fff2' });
    await link.disconnect();
  });
});
