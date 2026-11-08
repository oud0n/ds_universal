import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLink, type DeviceSample } from '../devices/deviceLink';
import type { RegisteredDevice } from '../devices/deviceRegistry';
import { BleFixAssembler, type BleFix } from '../digspiceBleProtocol';
import { HostBleCentral } from './bleCentral';
import type { GattCharacteristicRef, BleLinkHandlers } from '../bleCentral';
import { deferred, FakeHost, flush, sentence } from './fixtures.test-support';
import { hostBleFixture, recordBle, webBleFixture } from './bleFixtures.test-support';

const ref = { service: '180d', characteristic: '2a37' };
const blank = (): BleLinkHandlers => ({ onState() {}, onNotify() {} });
beforeEach(() => { vi.spyOn(performance, 'now').mockReturnValue(1234); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function notify(host: FakeHost, session: string, epoch: number, bytes = [0, 88]) {
  host.emit({ type: 'ble.notify', session, epoch, items: [{ tMs: 1234, bytes, characteristic: ref.characteristic }] });
}
async function connected(host: FakeHost, central: HostBleCentral, handlers = blank(), id = 'one') {
  await central.connect(id, ref, handlers);
  const session = host.lastSession('ble.connect');
  host.emit({ type: 'ble.state', session, epoch: 1, state: 'connected' });
  return session;
}

describe('BLE: 既存Web経路とホスト経路の差分比較', () => {
  it('探索・接続・通知・特性の読書き・再接続の観測結果が一致する', async () => {
    const old = await recordBle(webBleFixture(), ref);
    const next = await recordBle(hostBleFixture(), ref);
    expect(next).toEqual(old);
    expect(next.states).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
    expect(next.notifications).toHaveLength(2);
    expect(next.read).toEqual(Uint8Array.of(1, 2, 3));
    expect(next.writes).toEqual([{ ref, bytes: [1, 2, 3] }]);
  });

  it.each(['hr', 'drogger', 'racebox', 'gopro', 'obd'] as const)('%sの既存DeviceLinkが同じ通知から同じ値・命令を出す', async kind => {
    const outputs = [];
    for (const fixture of [webBleFixture(), hostBleFixture()]) {
      const device: RegisteredDevice = { id: fixture.deviceId, kind, bleName: 'Synthetic', displayName: 'Synthetic', fileName: kind, addedAt: 0 };
      const link = new DeviceLink(device, fixture.central, () => 1234), samples: DeviceSample[] = [];
      link.onSample(s => samples.push(s));
      await link.connect(); await flush();
      const first = fixture.refs[0];
      if (kind === 'hr') { fixture.notify([0, 88], first); fixture.notify([1, 44, 1], first); }
      if (kind === 'drogger') {
        const text = sentence('GNGGA,012345.20,3524.0000,N,14000.0000,E,4,24,0.6,45.3,M,39.0,M,1.0,0000') +
          sentence('GNRMC,012345.20,A,3524.0000,N,14000.0000,E,54.0,90.0,211026,,,R');
        const bytes = Array.from(new TextEncoder().encode(text));
        fixture.notify(bytes.slice(0, 11), first); fixture.notify(bytes.slice(11), first);
      }
      if (kind === 'racebox') {
        // 合成UBXパケット: 日付/測位有効、速度1000 mm/s。チェックサムは独立計算。
        const bytes = new Uint8Array(88), v = new DataView(bytes.buffer);
        bytes.set([0xb5, 0x62, 0xff, 1, 80, 0]);
        v.setUint16(10, 2026, true); bytes[12] = 11; bytes[13] = 8;
        bytes[17] = 7; bytes[26] = 3; bytes[27] = 1;
        v.setInt32(34, 354000000, true); v.setInt32(30, 1400000000, true); v.setInt32(54, 1000, true);
        let a = 0, b = 0; for (let i = 2; i < 86; i++) { a = (a + bytes[i]) & 255; b = (b + a) & 255; }
        bytes[86] = a; bytes[87] = b;
        fixture.notify(Array.from(bytes.slice(0, 19)), first); fixture.notify(Array.from(bytes.slice(19)), first);
      }
      if (kind === 'gopro') {
        fixture.notify([8, 0x13, 0, 10, 1, 1, 70, 1, 87], fixture.refs[2]);
        await link.goproShutter(true); await flush();
      }
      if (kind === 'obd') {
        // 初期化の最初のATZと、その応答から次のATE0へ進むところを比較。
        fixture.notify(Array.from(new TextEncoder().encode('OK\r\r>')), first); await flush();
      }
      await link.disconnect();
      outputs.push({ samples, writes: fixture.writes, refs: fixture.refs });
    }
    expect(outputs[1]).toEqual(outputs[0]);
    if (kind !== 'obd') expect(outputs[1].samples.length).toBeGreaterThan(0);
    if (kind === 'hr') expect(outputs[1].samples).toEqual([
      { type: 'values', tMs: 1234, values: { bpm: 88 } }, { type: 'values', tMs: 1234, values: { bpm: 300 } }
    ]);
    if (kind === 'gopro') expect(outputs[1].samples[0]).toEqual({ type: 'gopro', status: { encoding: true, batteryPercent: 87 } });
    if (kind === 'obd') expect(outputs[1].writes.map(w => new TextDecoder().decode(Uint8Array.from(w.bytes)))).toEqual(['ATZ\r', 'ATE0\r']);
  });

  it('DigSpiceのA/B通知から同じ測位を作る', async () => {
    const a = new Uint8Array(16), av = new DataView(a.buffer);
    av.setUint16(0, 0x80, true); av.setUint16(2, 1000, true);
    av.setInt32(4, 354000000, true); av.setInt32(8, 1400000000, true); av.setInt32(12, 4500, true);
    const b = Uint8Array.of(0x80, 0, 0xea, 7, 11, 8, 1, 2, 3, 25);
    const results = [];
    const location: GattCharacteristicRef = { service: '1819', characteristic: '2a67' };
    for (const f of [webBleFixture(), hostBleFixture()]) {
      const assembler = new BleFixAssembler(), fixes: BleFix[] = [];
      await f.central.connect(f.deviceId, location, { onState() {}, onNotify(items) {
        for (const item of items) { const fix = assembler.push(item.bytes); if (fix) fixes.push(fix); }
      } }); await flush();
      f.notify(Array.from(a), location); f.notify(Array.from(b), location);
      await f.central.disconnect(f.deviceId); results.push(fixes);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[1][0]).toMatchObject({ latitude: 35.4, longitude: 140, speedKmh: 36, altitude: 45, valid: true });
  });
});

describe('BLEホストの所有と非同期境界', () => {
  it('再接続前の通知・状態・read/write完了を採用しない', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), received = vi.fn(), state = vi.fn();
    const session = await connected(host, central, { onState: state, onNotify: received });
    const read = deferred<{ bytes: number[] }>(), write = deferred();
    host.onRequest = async method => method === 'ble.read' ? read.promise : method === 'ble.write' ? write.promise : undefined;
    const reading = expect(central.read('one', ref)).rejects.toMatchObject({ code: 'cancelled' });
    const writing = expect(central.write('one', ref, Uint8Array.of(1))).rejects.toMatchObject({ code: 'cancelled' });
    host.emit({ type: 'ble.state', session, epoch: 2, state: 'reconnecting' });
    notify(host, session, 1);
    host.emit({ type: 'ble.state', session, epoch: 1, state: 'disconnected' });
    host.emit({ type: 'ble.state', session, epoch: 2, state: 'connected' });
    notify(host, session, 1); notify(host, session, 2);
    read.resolve({ bytes: [99] }); write.resolve(); await Promise.all([reading, writing]);
    expect(received).toHaveBeenCalledTimes(1);
    expect(state.mock.calls.map(c => c[0])).toEqual(['connected', 'reconnecting', 'connected']);
    await central.disconnect('one'); expect(host.listeners.size).toBe(0);
  });

  it('複数機器の通知を混ぜず、同じ機器の旧sessionも捨てる', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), one = vi.fn(), two = vi.fn();
    const old = await connected(host, central, { onState() {}, onNotify: one });
    const second = await connected(host, central, { onState() {}, onNotify: two }, 'two');
    const current = await connected(host, central, { onState() {}, onNotify: one });
    notify(host, old, 1); notify(host, second, 1); notify(host, current, 1);
    expect(one).toHaveBeenCalledTimes(1); expect(two).toHaveBeenCalledTimes(1);
    await central.disconnect('one'); await central.disconnect('two'); expect(host.listeners.size).toBe(0);
  });

  it('connect受付より前の状態通知を受け取り、disconnect後の遅い受付で復活しない', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), pending = deferred(), state = vi.fn();
    host.onRequest = async (method, params) => {
      if (method === 'ble.connect') {
        host.emit({ type: 'ble.state', session: params.session, epoch: 1, state: 'connected' });
        return pending.promise;
      }
    };
    const opening = expect(central.connect('one', ref, { onState: state, onNotify() {} })).rejects.toMatchObject({ code: 'cancelled' });
    await flush(); expect(state).toHaveBeenCalledTimes(1);
    await central.disconnect('one'); pending.resolve(); await opening;
    expect(host.listeners.size).toBe(0);
  });

  it('購読中にconnectを置き換えても一つだけを残す', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), pending = deferred();
    host.onListen = () => pending.promise;
    const first = expect(central.connect('one', ref, blank())).rejects.toMatchObject({ code: 'cancelled' });
    const second = central.connect('one', ref, blank());
    pending.resolve(); await Promise.all([first, second]);
    expect(host.listeners.size).toBe(1);
    expect(host.calls.filter(c => c.method === 'ble.connect')).toHaveLength(1);
    await central.disconnect('one');
  });

  it('権限拒否を伝え、listen/connectの失敗でも購読と途中資源を片づける', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host);
    host.onRequest = async method => { if (method === 'ble.connect') throw { code: 'permission-denied' }; };
    await expect(central.connect('one', ref, blank())).rejects.toMatchObject({ code: 'permission-denied' });
    expect(host.listeners.size).toBe(0);
    expect(host.calls.some(c => c.method === 'ble.disconnect')).toBe(true);
    host.onListen = async () => { throw new Error('listen failed'); };
    await expect(central.connect('one', ref, blank())).rejects.toMatchObject({ code: 'io' });
    expect(host.listeners.size).toBe(0);
  });

  it.each(['bytes', 'time', 'epoch'] as const)('不正な%sを通知せず切断する', async field => {
    const host = new FakeHost(), central = new HostBleCentral(host), data = vi.fn(), state = vi.fn();
    const session = await connected(host, central, { onNotify: data, onState: state });
    host.emit({ type: 'ble.notify', session, epoch: field === 'epoch' ? 0 : 1,
      items: [{ tMs: field === 'time' ? -1 : 1234, bytes: field === 'bytes' ? [256] : [0, 88] }] });
    expect(data).not.toHaveBeenCalled();
    expect(state).toHaveBeenLastCalledWith('disconnected', expect.objectContaining({ code: 'invalid-data' }));
    expect(host.listeners.size).toBe(0);
  });

  it('scan終了を一度だけ通知し、stop後の旧機器通知を捨てる', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), device = vi.fn(), end = vi.fn();
    const options = { namePrefixes: ['DS4'], services: ['1819'], advertisedServices: ['180d'] };
    await central.scan(options, device, end);
    const session = host.lastSession('ble.scan');
    expect(host.calls.find(c => c.method === 'ble.scan')?.params).toEqual({ session, options });
    await central.stopScan();
    host.emit({ type: 'ble.device', session, device: { id: 'old', name: 'old' } });
    host.emit({ type: 'ble.scanEnded', session });
    expect(end).toHaveBeenCalledTimes(1); expect(device).not.toHaveBeenCalled();
    expect(host.listeners.size).toBe(0);
  });

  it('scanの購読中の取消しと、開始失敗も資源を残さない', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), listening = deferred(), end = vi.fn();
    host.onListen = () => listening.promise;
    const scanning = central.scan({ namePrefixes: [], services: [] }, () => {}, end);
    await central.stopScan(); listening.resolve(); await scanning;
    expect(host.calls.some(c => c.method === 'ble.scan')).toBe(false);
    expect(end).toHaveBeenCalledTimes(1); expect(host.listeners.size).toBe(0);
    host.onListen = undefined;
    host.onRequest = async method => { if (method === 'ble.scan') throw { code: 'permission-denied' }; };
    await expect(central.scan({ namePrefixes: [], services: [] }, () => {}, end)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(host.listeners.size).toBe(0); expect(end).toHaveBeenCalledTimes(2);
  });

  it('navigator/windowがない環境でも、ホストだけで使える', async () => {
    vi.stubGlobal('navigator', undefined); vi.stubGlobal('window', undefined);
    const host = new FakeHost(), central = new HostBleCentral(host);
    await connected(host, central);
    expect(await central.read('one', ref)).toEqual(Uint8Array.of(1, 2, 3));
    await central.write('one', ref, Uint8Array.of(4)); await central.disconnect('one');
  });
});

describe('BLEの接続置換と終了理由', () => {
  it('旧disconnect待機中にさらに置き換えても、最新の接続だけを開く', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host);
    await connected(host, central);
    const closing = deferred();
    host.onRequest = async method => method === 'ble.disconnect' ? closing.promise : undefined;
    const second = expect(central.connect('one', ref, blank())).rejects.toMatchObject({ code: 'cancelled' });
    const third = central.connect('one', ref, blank());
    closing.resolve(); await Promise.all([second, third]);
    expect(host.calls.filter(c => c.method === 'ble.connect')).toHaveLength(2);
    expect(host.listeners.size).toBe(1);
    await central.disconnect('one');
  });

  it('受付完了前の終端状態では、本来の失敗理由を保つ', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), state = vi.fn();
    host.onRequest = async (method, params) => {
      if (method === 'ble.connect') host.emit({ type: 'ble.state', session: params.session, epoch: 1,
        state: 'disconnected', error: { code: 'permission-denied' } });
    };
    await expect(central.connect('one', ref, { onState: state, onNotify() {} })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state).toHaveBeenCalledWith('disconnected', expect.objectContaining({ code: 'permission-denied' }));
    expect(host.listeners.size).toBe(0);
  });

  it('100回の探索・接続・切断でも購読が残らない', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host);
    for (let i = 0; i < 100; i++) {
      await central.scan({ namePrefixes: ['DS4'], services: ['1819'] }, () => {}, () => {});
      await central.stopScan();
      await connected(host, central); await central.disconnect('one');
      expect(host.listeners.size).toBe(0);
    }
  });
});

describe('三段階の置換でも実機をまだ所有している接続を追い越さない', () => {
  it('Aだけのdisconnectが遅い場合、空のBの終了ではCを開始しない', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host);
    const a = await connected(host, central), closingA = deferred();
    host.onRequest = async (method, params) => method === 'ble.disconnect' && params.session === a ? closingA.promise : undefined;
    const b = expect(central.connect('one', ref, blank())).rejects.toMatchObject({ code: 'cancelled' });
    const c = central.connect('one', ref, blank());
    await flush();
    expect(host.calls.filter(call => call.method === 'ble.connect')).toHaveLength(1);
    closingA.resolve(); await Promise.all([b, c]);
    expect(host.calls.filter(call => call.method === 'ble.connect')).toHaveLength(2);
    await central.disconnect('one'); expect(host.listeners.size).toBe(0);
  });

  it('AだけのstopScanが遅い場合、空のBの終了ではCを開始しない', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), options = { namePrefixes: ['DS4'], services: ['1819'] };
    const end = vi.fn();
    await central.scan(options, () => {}, end);
    const a = host.lastSession('ble.scan'), closingA = deferred();
    host.onRequest = async (method, params) => method === 'ble.stopScan' && params.session === a ? closingA.promise : undefined;
    const b = central.scan(options, () => {}, end), c = central.scan(options, () => {}, end);
    await flush();
    expect(host.calls.filter(call => call.method === 'ble.scan')).toHaveLength(1);
    closingA.resolve(); await Promise.all([b, c]);
    expect(host.calls.filter(call => call.method === 'ble.scan')).toHaveLength(2);
    await central.stopScan(); expect(host.listeners.size).toBe(0);
    expect(end).toHaveBeenCalledTimes(3);
  });
});

describe('終了の一部が失敗しても、前の終了待ちを落とさない', () => {
  it('Bのdisconnect失敗をAの終了より早く解決せず、Cを開かない', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host);
    const a = await connected(host, central), closingA = deferred();
    host.onRequest = async (method, params) => {
      if (method === 'ble.disconnect') {
        if (params.session === a) return closingA.promise;
        throw { code: 'io' };
      }
    };
    const b = expect(central.connect('one', ref, blank())).rejects.toBeInstanceOf(Error);
    const c = expect(central.connect('one', ref, blank())).rejects.toMatchObject({ code: 'io' });
    await flush();
    expect(host.calls.filter(call => call.method === 'ble.connect')).toHaveLength(1);
    closingA.resolve(); await Promise.all([b, c]);
    expect(host.calls.filter(call => call.method === 'ble.connect')).toHaveLength(1);
    expect(host.listeners.size).toBe(0);
  });
});

describe('終了コールバックからの再入でも後片づけを追い越さない', () => {
  it('不正通知による切断通知の中からつなぎ直しても、旧disconnectを待つ', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), closingA = deferred();
    let reopening: Promise<void> | undefined;
    const a = await connected(host, central, { onNotify() {}, onState(state) {
      if (state === 'disconnected') reopening = central.connect('one', ref, blank());
    } });
    host.onRequest = async (method, params) => method === 'ble.disconnect' && params.session === a ? closingA.promise : undefined;
    notify(host, a, 1, [256]); await flush();
    expect(reopening).toBeDefined();
    expect(host.calls.filter(c => c.method === 'ble.connect')).toHaveLength(1);
    closingA.resolve(); await reopening;
    expect(host.calls.filter(c => c.method === 'ble.connect')).toHaveLength(2);
    await central.disconnect('one'); expect(host.listeners.size).toBe(0);
  });

  it('stopの終了通知からscanを始めても、旧stopを待つ', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), closingA = deferred();
    let reopening: Promise<void> | undefined;
    const options = { namePrefixes: ['DS4'], services: ['1819'] };
    await central.scan(options, () => {}, () => { reopening = central.scan(options, () => {}, () => {}); });
    const a = host.lastSession('ble.scan');
    host.onRequest = async (method, params) => method === 'ble.stopScan' && params.session === a ? closingA.promise : undefined;
    const stopping = central.stopScan(); await flush();
    expect(reopening).toBeDefined();
    expect(host.calls.filter(c => c.method === 'ble.scan')).toHaveLength(1);
    closingA.resolve(); await Promise.all([stopping, reopening]);
    expect(host.calls.filter(c => c.method === 'ble.scan')).toHaveLength(2);
    await central.stopScan(); expect(host.listeners.size).toBe(0);
  });

  it('scan置換の終了通知でさらに置換した場合も、最後の要求だけを開く', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), closingA = deferred();
    let c: Promise<void> | undefined;
    const opts = (name: string) => ({ namePrefixes: [name], services: ['1819'] });
    await central.scan(opts('A'), () => {}, () => { c = central.scan(opts('C'), () => {}, () => {}); });
    const a = host.lastSession('ble.scan');
    host.onRequest = async (method, params) => method === 'ble.stopScan' && params.session === a ? closingA.promise : undefined;
    const b = central.scan(opts('B'), () => {}, () => {}); await flush();
    expect(host.calls.filter(call => call.method === 'ble.scan')).toHaveLength(1);
    closingA.resolve(); await Promise.all([b, c]);
    expect(host.calls.filter(call => call.method === 'ble.scan').map(call => 'options' in call.params && 'namePrefixes' in call.params.options && call.params.options.namePrefixes)).toEqual([['A'], ['C']]);
    await central.stopScan(); expect(host.listeners.size).toBe(0);
  });
});

describe('BLEの自然終了と重複終了', () => {
  it('二度目のdisconnectも、最初の終了が済むまで待つ', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), closing = deferred();
    await connected(host, central);
    host.onRequest = async method => method === 'ble.disconnect' ? closing.promise : undefined;
    const first = central.disconnect('one'); let done = false;
    const second = central.disconnect('one').then(() => { done = true; });
    await flush(); expect(done).toBe(false);
    closing.resolve(); await Promise.all([first, second]); expect(done).toBe(true);
  });

  it('自然切断のonStateから再接続しても、旧資源の解放を待つ', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), closing = deferred();
    let reopening: Promise<void> | undefined;
    const a = await connected(host, central, { onNotify() {}, onState(state) {
      if (state === 'disconnected') reopening = central.connect('one', ref, blank());
    } });
    host.onRequest = async (method, params) => method === 'ble.disconnect' && params.session === a ? closing.promise : undefined;
    host.emit({ type: 'ble.state', session: a, epoch: 1, state: 'disconnected' });
    await flush(); expect(host.calls.filter(c => c.method === 'ble.connect')).toHaveLength(1);
    closing.resolve(); await reopening;
    expect(host.calls.filter(c => c.method === 'ble.connect')).toHaveLength(2);
    await central.disconnect('one');
  });

  it('自然なscanEndedのonEndから再探索しても、旧資源の解放を待つ', async () => {
    const host = new FakeHost(), central = new HostBleCentral(host), closing = deferred();
    let reopening: Promise<void> | undefined;
    const options = { namePrefixes: ['DS4'], services: ['1819'] };
    await central.scan(options, () => {}, () => { reopening = central.scan(options, () => {}, () => {}); });
    const a = host.lastSession('ble.scan');
    host.onRequest = async (method, params) => method === 'ble.stopScan' && params.session === a ? closing.promise : undefined;
    host.emit({ type: 'ble.scanEnded', session: a });
    await flush(); expect(host.calls.filter(c => c.method === 'ble.scan')).toHaveLength(1);
    closing.resolve(); await reopening;
    expect(host.calls.filter(c => c.method === 'ble.scan')).toHaveLength(2);
    await central.stopScan();
  });
});
