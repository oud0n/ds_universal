import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeRequest } from './contract';

const tick = () => vi.advanceTimersByTimeAsync(10);
const caps = (sessions: boolean) => ({
  contractVersion: 1, platform: 'ios', deviceKind: 'phone', features: { ble: true, ...(sessions ? { bridgeSessions: true } : {}) }
});
const send = (body: unknown) => window.dsNative!.receive(JSON.stringify(body));
const bootstrap = (session?: string) => send({ id: 0, ok: true, result: caps(session !== undefined), session });

function host() {
  const requests: NativeRequest[] = [];
  const sink = { postMessage(text: string) { requests.push(JSON.parse(text)); } };
  return { requests, handlers: { dsNative: sink } };
}
async function documentFor(native: ReturnType<typeof host>) {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { webkit: { messageHandlers: native.handlers } }));
  vi.resetModules();
  return import('./bridge');
}
function stored(initial: string | null = null) {
  let value = initial;
  return { getItem: () => value, setItem: (_: string, end: string) => { value = end; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('読み込み直して同じ要求番号を使っても、古い成功・失敗・番号のない答えを渡さない', async () => {
  const native = host();
  const first = await documentFor(native);
  void first.callNative('system.closeFiles', { all: true });
  bootstrap('11');
  await tick();
  const old = native.requests[1];
  const fresh = await documentFor(native);
  let done = false;
  const reading = fresh.callNative('iap.entitlements', {}).then(result => { done = true; return result; });
  bootstrap('12');
  await tick();
  const now = native.requests[3];
  expect(now.id).toBe(old.id);
  expect([old.session, now.session]).toEqual(['11', '12']);
  for (const wrong of [old.session, undefined, null]) {
    send({ id: now.id, session: wrong, ok: true, result: { open: 42 } });
    send({ id: now.id, session: wrong, ok: false, error: { code: 'io', message: 'old' } });
  }
  for (const message of ['null', '0', 'false', '[]', '"text"', '{']) window.dsNative!.receive(message);
  await tick();
  expect(done).toBe(false);
  send({ id: now.id, session: now.session, ok: true, result: { revision: 1, productIds: [] } });
  expect(await reading).toEqual({ revision: 1, productIds: [] });
});

it('前の画面が受け取らなかった初期応答が先に届いても、一度決めた番号を使い続ける', async () => {
  const native = host();
  const first = await documentFor(native);
  void first.nativeCapabilityResult();
  const fresh = await documentFor(native);
  const one = fresh.callNative('iap.entitlements', {});
  expect(native.requests.map(r => [r.id, r.method, r.requestSession])).toEqual([[0, 'caps.get', true], [0, 'caps.get', true]]);
  bootstrap('20');
  bootstrap('21');
  await tick();
  const req = native.requests[2];
  expect(req).toMatchObject({ id: 1, session: '20', method: 'iap.entitlements' });
  send({ id: req.id, session: '20', ok: false, error: { code: 'io', message: 'reply could not be encoded' } });
  await expect(one).rejects.toThrow('reply could not be encoded');
  const two = fresh.callNative('iap.purchase', { id: 'a' });
  await tick();
  expect(native.requests[3]).toMatchObject({ id: 2, session: '20' });
  send({ id: 2, session: '20', ok: true, result: { status: 'cancelled' } });
  expect(await two).toEqual({ status: 'cancelled' });
});

it('初期応答の欠けた番号や壊れた機能一覧を採用せず、次の問い合わせで確かめ直す', async () => {
  const native = host();
  const bridge = await documentFor(native);
  for (const body of [
    { result: caps(true) }, { result: caps(true), session: '0' }, { result: caps(true), session: 17 },
    { result: caps(false), session: '17' }, { result: { open: 2 } },
    { result: { ...caps(false), platform: '../bad' } }, { result: { ...caps(false), features: { ble: true, bridgeSessions: 'true' } } }
  ]) {
    const result = bridge.nativeCapabilityResult();
    send({ id: 0, ok: true, ...body });
    expect((await result).status).toBe('error');
  }
  const result = bridge.nativeCapabilityResult();
  bootstrap('44');
  expect((await result).status).toBe('ready');
  expect(native.requests.every(r => r.id === 0)).toBe(true);
});

it('旧版は保存した範囲を次の画面に引き継ぎ、返事が遅れても新しい呼び出しと混ざらない', async () => {
  vi.stubGlobal('sessionStorage', stored());
  const native = host();
  const first = await documentFor(native);
  void first.callNative('system.closeFiles', { all: true });
  bootstrap();
  await tick();
  const old = native.requests[1];
  const fresh = await documentFor(native);
  const next = fresh.callNative('iap.entitlements', {});
  bootstrap();
  await tick();
  const now = native.requests[3];
  expect(now.session).toBeUndefined();
  expect(now.id).toBeGreaterThan(old.id);
  send({ id: old.id, ok: true, result: { open: 2 } });
  send({ id: now.id, ok: true, result: { revision: 2, productIds: [] } });
  expect(await next).toEqual({ revision: 2, productIds: [] });
});

it.each([undefined, stored(''), stored('invalid'), stored('2147483647'), { getItem: () => null, setItem: () => { throw Error('blocked'); } }])
('旧版で番号を確保できないときは通常の要求を送らない', async storage => {
  vi.stubGlobal('sessionStorage', storage);
  const native = host();
  const bridge = await documentFor(native);
  const one = bridge.callNative('system.closeFiles', { all: true });
  bootstrap();
  await expect(one).rejects.toThrow();
  expect(native.requests.map(r => r.method)).toEqual(['caps.get']);
});

it('模擬の窓口も、以前の画面への答えと今の画面への状態の知らせを分ける', async () => {
  vi.stubGlobal('window', {});
  vi.resetModules();
  const { installMockNative } = await import('./mockNative');
  const native = installMockNative({ latencyMs: 1 });
  const held = native.holdNextEntitlements();
  const first = await import('./bridge');
  void first.callNative('iap.entitlements', {});
  await tick();
  await held.captured;
  const handlers = window.webkit!.messageHandlers;
  vi.stubGlobal('window', { webkit: { messageHandlers: handlers } });
  vi.resetModules();
  const fresh = await import('./bridge');
  const received: number[] = [];
  fresh.onNative('iap.entitlementsChanged', snapshot => received.push(snapshot.revision));
  const next = native.holdNextEntitlements();
  let resolved = false;
  const reading = fresh.callNative('iap.entitlements', {}).then(value => { resolved = true; return value; });
  await tick();
  await next.captured;
  held.release();
  await tick();
  expect(resolved).toBe(false);
  expect(received).toEqual([1]);
  next.release();
  await tick();
  expect(await reading).toEqual({ revision: 2, productIds: [] });
  const reads = native.requests.filter(r => r.method === 'iap.entitlements');
  expect(reads[0].id).toBe(reads[1].id);
  expect(reads[0].session).not.toBe(reads[1].session);
  native.uninstall();
});

it('開始前と期限後の応答を捨て、再試行で一つの番号を選ぶ。タイムアウトから旧版に切り替えない', async () => {
  const native = host();
  const fresh = await documentFor(native);
  bootstrap('1');
  const timedOut = fresh.callNative('system.closeFiles', { all: true });
  const rejected = expect(timedOut).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  bootstrap('2');
  expect(native.requests.map(r => r.id)).toEqual([0]);
  const failed = fresh.nativeCapabilityResult();
  send({ id: 0, ok: false, error: { code: 'io', message: 'reply could not be encoded' } });
  expect((await failed).status).toBe('error');
  const result = fresh.callNative('iap.entitlements', {});
  bootstrap('3');
  bootstrap('4');
  bootstrap('5');
  await tick();
  const req = native.requests[3];
  expect(req).toMatchObject({ id: 1, session: '3' });
  send({ id: req.id, session: '3', ok: true, result: { revision: 6, productIds: [] } });
  expect(await result).toEqual({ revision: 6, productIds: [] });
});

it('キャッシュから戻る画面は保留処理を終え、同じ番号を使い回さない', async () => {
  const native = host();
  const bridge = await documentFor(native);
  const previous = bridge.callNative('iap.purchase', { id: 'a' });
  bootstrap('8');
  await tick();
  const rejected = expect(previous).rejects.toThrow('Page changed');
  window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
  await rejected;
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  const next = bridge.callNative('iap.entitlements', {});
  await tick();
  expect(native.requests[2]).toMatchObject({ id: 2, session: '8' });
  send({ id: 1, session: '8', ok: true, result: { status: 'purchased' } });
  send({ id: 2, session: '8', ok: true, result: { revision: 1, productIds: [] } });
  expect(await next).toEqual({ revision: 1, productIds: [] });
});

it('旧版は最後の 32 ビット番号までを使い、その次は送らずに失敗する', async () => {
  vi.stubGlobal('sessionStorage', stored('2147483645'));
  const native = host();
  const bridge = await documentFor(native);
  const one = bridge.callNative('iap.entitlements', {});
  bootstrap();
  await tick();
  const two = bridge.callNative('iap.entitlements', {});
  await tick();
  expect(native.requests.slice(1).map(r => r.id)).toEqual([2147483646, 2147483647]);
  await expect(bridge.callNative('iap.entitlements', {})).rejects.toThrow('IDs unavailable');
  for (const r of native.requests.slice(1)) send({ id: r.id, ok: true, result: { revision: r.id, productIds: [] } });
  await Promise.all([one, two]);
});

it('送信時に JSON にできない要求と、番号を読める壊れた返事は待ち続けない', async () => {
  const native = host();
  const bridge = await documentFor(native);
  const ready = bridge.nativeCapabilityResult();
  bootstrap('7');
  await ready;
  const params = { ids: [] as string[] };
  Object.assign(params, { cycle: params });
  await expect(bridge.callNative('iap.products', params)).rejects.toThrow();
  expect(native.requests).toHaveLength(1);
  const result = bridge.callNative('iap.entitlements', {});
  await tick();
  send({ id: native.requests[1].id, session: '7', ok: 'bad' });
  await expect(result).rejects.toThrow('Invalid native response');
});

it('旧版は予約を使い切ったら続きの範囲を確保する', async () => {
  const storage = stored();
  vi.stubGlobal('sessionStorage', storage);
  const native = host();
  const bridge = await documentFor(native);
  const ready = bridge.nativeCapabilityResult();
  bootstrap();
  await ready;
  const results = Array.from({ length: 257 }, () => bridge.callNative('iap.entitlements', {}));
  await tick();
  const ids = native.requests.slice(1).map(r => r.id);
  expect(new Set(ids).size).toBe(257);
  expect(Number(storage.getItem())).toBe(ids[0] + 511);
  for (const id of ids) send({ id, ok: true, result: { revision: id, productIds: [] } });
  await Promise.all(results);
});

it('複数の模擬窓口はモジュールを読み直しても別の番号を発行する', async () => {
  const sessions: string[] = [];
  for (let i = 0; i < 2; i++) {
    vi.stubGlobal('window', {});
    vi.resetModules();
    const { installMockNative } = await import('./mockNative');
    const mock = installMockNative({ latencyMs: 1 });
    const bridge = await import('./bridge');
    const reading = bridge.callNative('iap.entitlements', {});
    await tick();
    await reading;
    sessions.push(mock.requests[1].session!);
    mock.uninstall();
  }
  expect(sessions[0]).not.toBe(sessions[1]);
});
