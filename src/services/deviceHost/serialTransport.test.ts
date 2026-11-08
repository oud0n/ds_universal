import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DigSpiceDevice } from '../digspiceDevice';
import { LineSplitter } from '../digspiceProtocol';
import { WebSerialTransport } from '../webSerialTransport';
import { LOGGER_SERIAL_OPTIONS, MAX_HOST_BYTES } from './contract';
import { HostSerialTransport } from './serialTransport';
import { deferred, FakeHost, flush, hostSerialFixture, sentence, webSerialFixture } from './fixtures.test-support';

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('USB: Web Serialとホスト経路の差分比較', () => {
  it.each([1, 2, 7, 64, 65536])('受信を%dバイトに分割しても設定・送信・4096バイト全体が一致する', async fragment => {
    const old = webSerialFixture(fragment), next = hostSerialFixture(fragment);
    const transports = [new WebSerialTransport(async () => old.port), new HostSerialTransport(next.host)];
    const results = [];
    for (const transport of transports) {
      const device = new DigSpiceDevice();
      await device.connect(transport);
      try {
        const config = await device.getDeviceConfig();
        const { buffer } = await device.downloadLogs();
        results.push({ config, buffer });
      } finally { await device.disconnect(); }
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[1].config).toMatchObject({ model: 'DS4', firmwareVersion: '1.01', samplingRateHz: 20, autoLogSpeedKmh: 30 });
    expect(results[1].buffer).toEqual(old.peer.image);
    expect(next.peer.writes).toEqual(old.peer.writes);
    expect(next.peer.commands).toHaveLength(15);
    expect(next.peer.commands[0]).toBe('$PMTK605*31');
    expect(next.host.calls.find(c => c.method === 'serial.open')?.params).toMatchObject({ options: LOGGER_SERIAL_OPTIONS });
    expect(next.host.listeners.size).toBe(0);
  });

  it.each(['missing', 'conflict', 'bad-checksum'] as const)('異常%sでは両経路とも成功データを返さない', async mode => {
    const old = webSerialFixture(13), next = hostSerialFixture(13);
    old.peer.mode = next.peer.mode = mode;
    const errors: string[] = [];
    for (const transport of [new WebSerialTransport(async () => old.port), new HostSerialTransport(next.host)]) {
      const device = new DigSpiceDevice();
      await device.connect(transport);
      try { await device.downloadLogs(); throw new Error('Unexpected success'); }
      catch (error) { errors.push((error as Error).message); }
      finally { await device.disconnect(); }
    }
    expect(errors[1]).toBe(errors[0]);
    expect(errors[1]).toMatch(mode === 'conflict' ? /食い違/ : /欠落/);
    expect(next.peer.writes).toEqual(old.peer.writes);
  });

  it('途中行の受信エラー・切断での待機中止・明示closeの無通知が一致する', async () => {
    const old = webSerialFixture(65536), next = hostSerialFixture(65536);
    const outcomes = [];
    for (const [transport, peer, interrupt, lose] of [
      [new WebSerialTransport(async () => old.port), old.peer, () => old.port.interrupt(), () => old.port.lose()],
      [new HostSerialTransport(next.host), next.peer, next.interrupt, next.lose]
    ] as const) {
      const splitter = new LineSplitter(), lines: string[] = [];
      let lost = 0, interrupted = 0;
      await transport.open({ onData: b => lines.push(...splitter.push(b)),
        onInterrupted: () => { interrupted++; splitter.reset(); }, onLost: () => { lost++; } });
      peer.send('$incomplete');
      await flush(); interrupt(); await flush();
      peer.send(sentence('PMTK705,DS4,1.01'));
      await flush(); lose(); await flush();
      await transport.close();
      outcomes.push({ lines, lost, interrupted, open: transport.isOpen() });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[1]).toMatchObject({ lost: 1, interrupted: 1, open: false });
    expect(outcomes[1].lines).toEqual([sentence('PMTK705,DS4,1.01').trim()]);
  });

  it('通信断はDigSpiceDeviceの応答待機をタイムアウト前に中止する', async () => {
    for (const kind of ['web', 'host']) {
      const old = webSerialFixture(10), next = hostSerialFixture(10);
      const device = new DigSpiceDevice();
      await device.connect(kind === 'web' ? new WebSerialTransport(async () => old.port) : new HostSerialTransport(next.host));
      const waiting = device.waitForLine('$never', 60000);
      const rejected = expect(waiting).rejects.toBeInstanceOf(Error);
      if (kind === 'web') old.port.lose(); else next.lose();
      await rejected;
      expect(device.isConnected()).toBe(false);
      await device.disconnect();
    }
  });
});

describe('USBホストの所有と非同期境界', () => {
  it('部分書込みを繰り返し、並行writeと呼出し後の入力変更でも順序と内容を保つ', async () => {
    const host = new FakeHost(), sent: number[] = [];
    host.onRequest = async (method, params) => {
      if (method === 'serial.write' && 'bytes' in params) {
        sent.push(...params.bytes.slice(0, 2)); return { written: Math.min(2, params.bytes.length) };
      }
    };
    const transport = new HostSerialTransport(host);
    await transport.open({ onData() {}, onLost() {} });
    const input = Uint8Array.of(1, 2, 3, 4, 5);
    const first = transport.write(input), second = transport.write(Uint8Array.of(6, 7));
    input.fill(99);
    await Promise.all([first, second]);
    expect(sent).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await transport.close();
  });

  it('大きなwriteをIPC上限で分割する', async () => {
    const host = new FakeHost(), transport = new HostSerialTransport(host);
    await transport.open({ onData() {}, onLost() {} });
    await transport.write(new Uint8Array(MAX_HOST_BYTES + 3));
    expect(host.calls.filter(c => c.method === 'serial.write').map(c => 'bytes' in c.params && c.params.bytes.length)).toEqual([MAX_HOST_BYTES, 3]);
    await transport.close();
  });

  it.each([0, -1, 999, 0.5, NaN])('不正な送信済み長%dを成功扱いしない', async written => {
    const host = new FakeHost(), transport = new HostSerialTransport(host);
    host.onRequest = async method => method === 'serial.write' ? { written } : undefined;
    await transport.open({ onData() {}, onLost() {} });
    await expect(transport.write(Uint8Array.of(1, 2))).rejects.toMatchObject({ code: 'invalid-data' });
    await transport.close();
  });

  it('購読前の取消しはopenを送らず、遅れた購読も解除する', async () => {
    const host = new FakeHost(), listening = deferred();
    host.onListen = () => listening.promise;
    const transport = new HostSerialTransport(host);
    const opening = expect(transport.open({ onData() {}, onLost() {} })).rejects.toMatchObject({ code: 'cancelled' });
    await transport.close(); listening.resolve(); await opening;
    expect(host.calls.some(c => c.method === 'serial.open')).toBe(false);
    expect(host.listeners.size).toBe(0);
  });

  it('open中の切断を先に知らせ、後からopen成功しても復活しない', async () => {
    const host = new FakeHost(), pending = deferred(), close = deferred();
    host.onRequest = async method => method === 'serial.open' ? pending.promise : close.promise;
    const lost = vi.fn(), transport = new HostSerialTransport(host);
    const opening = expect(transport.open({ onData() {}, onLost: lost })).rejects.toMatchObject({ code: 'io' });
    await flush();
    host.emit({ type: 'serial.lost', session: host.lastSession('serial.open'), error: { code: 'io' } });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(transport.isOpen()).toBe(false);
    pending.resolve(); close.resolve(); await opening;
    expect(host.listeners.size).toBe(0);
  });

  it('close後の旧通知と旧write完了を、新しい接続へ持ち込まない', async () => {
    const host = new FakeHost(), pending = deferred<{ written: number }>();
    host.onRequest = async method => method === 'serial.write' ? pending.promise : undefined;
    const data = vi.fn(), lost = vi.fn(), transport = new HostSerialTransport(host);
    await transport.open({ onData: data, onLost: lost });
    const old = host.lastSession('serial.open');
    const writing = expect(transport.write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'cancelled' });
    await flush(); await transport.close();
    await transport.open({ onData: data, onLost: lost });
    host.emit({ type: 'serial.data', session: old, bytes: [99] });
    host.emit({ type: 'serial.lost', session: old, error: { code: 'io' } });
    pending.resolve({ written: 1 }); await writing;
    expect(data).not.toHaveBeenCalled(); expect(lost).not.toHaveBeenCalled();
    expect(transport.isOpen()).toBe(true);
    await transport.close();
  });

  it('権限拒否・不正な受信を失敗として伝え、購読を残さない', async () => {
    const host = new FakeHost(), transport = new HostSerialTransport(host);
    host.onRequest = async method => { if (method === 'serial.open') throw { code: 'permission-denied' }; };
    await expect(transport.open({ onData() {}, onLost() {} })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(host.listeners.size).toBe(0);
    host.onRequest = async () => {};
    const lost = vi.fn();
    await transport.open({ onData() {}, onLost: lost });
    host.emit({ type: 'serial.data', session: host.lastSession('serial.open'), bytes: [256] });
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-data' }));
    expect(host.listeners.size).toBe(0);
  });
});

describe('USBの反復とエラー回数', () => {
  it('Web経路と同じく5回連続の受信エラーで切断し、正常受信で回数を戻す', async () => {
    const old = webSerialFixture(10), next = hostSerialFixture(10), outcomes = [];
    for (const [transport, interrupt, peer] of [
      [new WebSerialTransport(async () => old.port), () => old.port.interrupt(), old.peer],
      [new HostSerialTransport(next.host), next.interrupt, next.peer]
    ] as const) {
      const lost = vi.fn(), interrupted = vi.fn();
      await transport.open({ onData() {}, onLost: lost, onInterrupted: interrupted });
      for (let i = 0; i < 4; i++) { interrupt(); await flush(); }
      peer.send('ok\n'); await flush();
      for (let i = 0; i < 4; i++) { interrupt(); await flush(); }
      expect(transport.isOpen()).toBe(true);
      interrupt(); await flush();
      outcomes.push({ open: transport.isOpen(), lost: lost.mock.calls.length, interrupted: interrupted.mock.calls.length });
      await transport.close();
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[1]).toEqual({ open: false, lost: 1, interrupted: 9 });
  });

  it('100回の接続・切断でも購読が残らない', async () => {
    const host = new FakeHost(), lost = vi.fn(), transport = new HostSerialTransport(host);
    for (let i = 0; i < 100; i++) {
      await transport.open({ onData() {}, onLost: lost });
      await transport.close(); expect(host.listeners.size).toBe(0);
    }
    expect(lost).not.toHaveBeenCalled();
  });
});

describe('USBの終了待ちを新しい接続へ引き継ぐ', () => {
  it('古いcloseが遅ければ、新しいopenを送らない', async () => {
    const host = new FakeHost(), transport = new HostSerialTransport(host), closed = deferred();
    await transport.open({ onData() {}, onLost() {} });
    const old = host.lastSession('serial.open');
    host.onRequest = async (method, params) => method === 'serial.close' && params.session === old ? closed.promise : undefined;
    const closing = transport.close(), opening = transport.open({ onData() {}, onLost() {} });
    await flush(); expect(host.calls.filter(call => call.method === 'serial.open')).toHaveLength(1);
    closed.resolve(); await Promise.all([closing, opening]);
    expect(host.calls.filter(call => call.method === 'serial.open')).toHaveLength(2);
    await transport.close(); expect(host.listeners.size).toBe(0);
  });
});

describe('USBの明示終了を途中で成功扱いしない', () => {
  it('二度目のcloseも、最初の終了が済むまで待つ', async () => {
    const host = new FakeHost(), transport = new HostSerialTransport(host), closing = deferred();
    await transport.open({ onData() {}, onLost() {} });
    host.onRequest = async method => method === 'serial.close' ? closing.promise : undefined;
    const first = transport.close(); let secondDone = false;
    const second = transport.close().then(() => { secondDone = true; });
    await flush(); expect(secondDone).toBe(false);
    closing.resolve(); await Promise.all([first, second]); expect(secondDone).toBe(true);
  });

  it('5回目のonInterruptedから明示closeしたときはonLostを呼ばない', async () => {
    const host = new FakeHost(), transport = new HostSerialTransport(host), lost = vi.fn();
    let count = 0, closing: Promise<void> | undefined;
    await transport.open({ onData() {}, onLost: lost, onInterrupted() { if (++count === 5) closing = transport.close(); } });
    const session = host.lastSession('serial.open');
    for (let i = 0; i < 5; i++) host.emit({ type: 'serial.interrupted', session });
    await closing;
    expect(lost).not.toHaveBeenCalled(); expect(host.listeners.size).toBe(0);
  });
});
