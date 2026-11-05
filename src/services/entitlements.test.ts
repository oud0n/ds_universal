import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockNativeOptions } from '../native/mockNative';
import type { EntitlementSnapshot } from '../native/contract';

const legacyCacheKey = 'ds_entitlements_v1_mock';
const tick = () => vi.advanceTimersByTimeAsync(25);
async function host(options?: MockNativeOptions) {
  const { installMockNative } = await import('../native/mockNative');
  return { mock: installMockNative({ latencyMs: 1, ...options }), service: await import('./entitlements') };
}

function sendSnapshot(snapshot: EntitlementSnapshot) {
  window.dsNative!.receive(JSON.stringify({ event: 'iap.entitlementsChanged', data: snapshot }));
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('window', {});
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('買い切り商品の状態', () => {
  it('最初の返事より先に届く購入を残し、初期化を重ねても一度だけ読む', async () => {
    const { mock, service } = await host();
    const hold = mock.holdNextEntitlements();
    const init = service.initializeEntitlements();
    expect(service.initializeEntitlements()).toBe(init);
    await tick();
    await hold.captured;
    expect(service.getEntitlementState().status).toBe('unknown');
    const heard: boolean[] = [];
    const off = service.subscribeEntitlements(() => heard.push(service.isOwned('a')));
    mock.setOwned(['a', 'a']);
    await tick();
    hold.release();
    await tick();
    await init;
    expect(heard).toEqual([true]);
    expect(mock.requests.filter(r => r.method === 'iap.entitlements')).toHaveLength(1);
    off();
    mock.setOwned([]);
    await tick();
    expect(heard).toEqual([true]);
    expect(service.getEntitlementState()).toEqual({ status: 'ready', productIds: [] });
  });

  it('前面に戻ったときの新しい返事が先に届けば、遅れた読み取りで取り消しを戻さない', async () => {
    const { mock, service } = await host();
    mock.setOwned(['a'], false);
    const init = service.initializeEntitlements();
    await tick();
    await init;
    const hold = mock.holdNextEntitlements();
    const stale = service.refreshEntitlements();
    await tick();
    await hold.captured;
    mock.setOwned([], false);
    window.dsNative!.receive(JSON.stringify({ event: 'system.appState', data: { state: 'active' } }));
    await tick();
    hold.release();
    await tick();
    await stale;
    expect(service.isOwned('a')).toBe(false);
    expect(service.getEntitlementState().productIds).toEqual([]);
  });

  it('最初の確認が間に合わなければ所有は空のまま、遅れた答えと壊れた知らせでは取り消しを戻さない', async () => {
    localStorage.setItem(legacyCacheKey, JSON.stringify(['a']));
    const { mock, service } = await host();
    mock.setOwned(['a'], false);
    const hold = mock.holdNextEntitlements();
    const init = service.initializeEntitlements();
    await tick();
    expect(service.isOwned('a')).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    await init;
    expect(service.getEntitlementState()).toEqual({ status: 'error', productIds: [] });
    mock.setOwned([]);
    await tick();
    hold.release();
    await tick();
    sendSnapshot({ revision: 999, productIds: [null as unknown as string] });
    sendSnapshot({ revision: -1, productIds: ['a'] });
    expect(service.getEntitlementState()).toEqual({ status: 'ready', productIds: [] });
    mock.failNextEntitlements();
    const failed = expect(service.refreshEntitlements()).rejects.toThrow();
    await tick();
    await failed;
    expect(service.getEntitlementState()).toEqual({ status: 'error', productIds: [] });
  });

  it('読み取り失敗を確認済みの空と区別し、復元で全件を入れ替える', async () => {
    const { mock, service } = await host();
    mock.failNextEntitlements();
    const init = service.initializeEntitlements();
    await tick();
    await init;
    expect(service.getEntitlementState()).toEqual({ status: 'error', productIds: [] });
    mock.setOwned(['b', 'a', 'b'], false);
    const restored = service.restore();
    await tick();
    await restored;
    expect(service.getEntitlementState()).toEqual({ status: 'ready', productIds: ['a', 'b'] });
    mock.setOwned([], false);
    const cleared = service.restore();
    await tick();
    await cleared;
    expect(service.getEntitlementState()).toEqual({ status: 'ready', productIds: [] });
  });

  it('取り消しを保存できず古い控えが残っても、次の起動で確認するまでは所有を戻さない', async () => {
    const disk = new Map([[legacyCacheKey, JSON.stringify(['a'])]]);
    let writable = true;
    const store = {
      getItem: vi.fn((key: string) => disk.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        if (!writable) throw Error('storage unavailable');
        disk.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        if (!writable) throw Error('storage unavailable');
        disk.delete(key);
      })
    };
    vi.stubGlobal('localStorage', store);
    const first = await host();
    first.mock.setOwned(['a'], false);
    const firstInit = first.service.initializeEntitlements();
    await tick();
    await firstInit;
    expect(first.service.isOwned('a')).toBe(true);
    writable = false;
    first.mock.setOwned([]);
    await tick();
    expect(first.service.getEntitlementState()).toEqual({ status: 'ready', productIds: [] });
    first.mock.uninstall();

    writable = true;
    vi.resetModules();
    vi.stubGlobal('window', {});
    const next = await host();
    next.mock.failNextEntitlements();
    const seen = [next.service.isOwned('a')];
    next.service.subscribeEntitlements(() => seen.push(next.service.isOwned('a')));
    const nextInit = next.service.initializeEntitlements();
    await tick();
    await nextInit;
    expect(next.service.getEntitlementState()).toEqual({ status: 'error', productIds: [] });
    expect(seen).toEqual([false, false]);
    expect(disk.get(legacyCacheKey)).toBe('["a"]');
    expect(store.getItem).not.toHaveBeenCalled();
    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.removeItem).not.toHaveBeenCalled();
    next.mock.setOwned(['a']);
    await tick();
    expect(seen).toEqual([false, false, true]);
  });

  it('Web の保存領域を開けなくても、端末で確認した所有と取り消しを使う', async () => {
    const touched = vi.fn(() => { throw Error('storage unavailable'); });
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: touched });
    Object.defineProperty(window, 'localStorage', { configurable: true, get: touched });
    try {
      const { mock, service } = await host();
      mock.setOwned(['a'], false);
      const init = service.initializeEntitlements();
      await tick();
      await init;
      expect(service.getEntitlementState()).toEqual({ status: 'ready', productIds: ['a'] });
      mock.failNextEntitlements();
      const failed = expect(service.refreshEntitlements()).rejects.toThrow();
      await tick();
      await failed;
      expect(service.getEntitlementState()).toEqual({ status: 'error', productIds: ['a'] });
      mock.setOwned([]);
      await tick();
      mock.failNextEntitlements();
      const failureAfterRemoval = expect(service.refreshEntitlements()).rejects.toThrow();
      await tick();
      await failureAfterRemoval;
      expect(service.getEntitlementState()).toEqual({ status: 'error', productIds: [] });
      expect(touched).not.toHaveBeenCalled();
    } finally { Object.defineProperty(globalThis, 'localStorage', original); }
  });

  it('購入結果だけで所有とせず、承認待ち・取り消し・失敗と消耗型を扱う', async () => {
    const { mock, service } = await host();
    const init = service.initializeEntitlements();
    await tick();
    await init;
    for (const result of ['pending', 'cancelled', 'error'] as const) {
      mock.setPurchaseResult(result);
      const purchase = service.purchase('a');
      const check = result === 'error' ? expect(purchase).rejects.toThrow() : expect(purchase).resolves.toBe(result);
      await tick();
      await check;
      expect(service.isOwned('a')).toBe(false);
    }
    mock.setPurchaseResult('purchased');
    const { TIP_PRODUCT_IDS, buyTip } = await import('./tips');
    const tip = buyTip(TIP_PRODUCT_IDS[0]);
    await tick();
    expect(await tip).toBe('purchased');
    expect(service.isOwned(TIP_PRODUCT_IDS[0])).toBe(false);
    const readsBeforePurchase = mock.requests.filter(r => r.method === 'iap.entitlements').length;
    const bought = service.purchase('a');
    await tick();
    expect(await bought).toBe('purchased');
    expect(service.isOwned('a')).toBe(true);
    expect(mock.requests.filter(r => r.method === 'iap.entitlements')).toHaveLength(readsBeforePurchase);
  });

  it('支払いの直後に別商品の知らせが届いても読み直し、読み取り失敗を決済失敗にしない', async () => {
    const { mock, service } = await host();
    const init = service.initializeEntitlements();
    await tick();
    await init;
    const sink = window.webkit!.messageHandlers!.dsNative!;
    const post = sink.postMessage.bind(sink);
    sink.postMessage = message => {
      const req = JSON.parse(message);
      if (req.method !== 'iap.purchase') { post(message); return; }
      // 支払いは通ったが、ストアの新しい一覧はまだ取得できない。
      sendSnapshot({ revision: 5, productIds: ['b'] });
      window.dsNative!.receive(JSON.stringify({ id: req.id, session: req.session, ok: true, result: { status: 'purchased' } }));
    };
    const hold = mock.holdNextEntitlements();
    const bought = service.purchase('a');
    await tick();
    await hold.captured;
    await vi.advanceTimersByTimeAsync(10000);
    expect(await bought).toBe('purchased');
    expect(service.getEntitlementState()).toEqual({ status: 'error', productIds: ['b'] });
    hold.release();
    await tick();
    expect(service.isOwned('a')).toBe(false);
    sendSnapshot({ revision: 6, productIds: ['a', 'b'] });
    expect(service.isOwned('a')).toBe(true);
  });

  it.each([{ entitlements: false }, { iap: false }])('以前のアプリや非対応端末では課金を呼ばない (%j)', async options => {
    localStorage.setItem(legacyCacheKey, '["a"]');
    const { mock, service } = await host(options);
    const init = service.initializeEntitlements();
    await tick();
    await init;
    expect(service.getEntitlementState()).toEqual({ status: 'unsupported', productIds: [] });
    await expect(service.purchase('a')).rejects.toThrow();
    await expect(service.restore()).rejects.toThrow();
    expect(mock.requests.map(r => r.method)).toEqual(['caps.get']);
  });

  it('ブラウザでは保存した購入を使わず、窓口を呼ばない', async () => {
    localStorage.setItem(legacyCacheKey, '["a"]');
    const service = await import('./entitlements');
    await service.initializeEntitlements();
    expect(service.getEntitlementState()).toEqual({ status: 'unsupported', productIds: [] });
    await expect(service.restore()).rejects.toThrow();
  });

  it('初回読出しが期限超過、あとから始めた読出しは応答待ちのまま', async () => {
    localStorage.setItem(legacyCacheKey, JSON.stringify(['a']));
    const { mock, service } = await host();
    const holdFirst = mock.holdNextEntitlements();
    const init = service.initializeEntitlements();
    await tick();
    await holdFirst.captured;
    await vi.advanceTimersByTimeAsync(5000);
    const holdSecond = mock.holdNextEntitlements();
    const refresh = service.refreshEntitlements();
    await tick();
    await holdSecond.captured;
    await vi.advanceTimersByTimeAsync(5000);
    await init;
    expect(service.getEntitlementState()).toEqual({ status: 'error', productIds: [] });
    holdFirst.release();
    holdSecond.release();
    await tick();
    await refresh;
  });

  it('期限の後に読み取りが終わったら、新しい状態がまだなければ知らせで回復する', async () => {
    const { mock, service } = await host();
    mock.setOwned(['a'], false);
    const hold = mock.holdNextEntitlements();
    const init = service.initializeEntitlements();
    await vi.advanceTimersByTimeAsync(10050);
    await init;
    expect(service.getEntitlementState().status).toBe('error');
    hold.release();
    await tick();
    expect(service.getEntitlementState()).toEqual({ status: 'ready', productIds: ['a'] });
  });

  it('取得失敗の後に以前と同じ版の知らせが重ねて届いても、再確認済みにはしない', async () => {
    const { mock, service } = await host();
    const init = service.initializeEntitlements();
    await tick();
    await init;
    sendSnapshot({ revision: 7, productIds: ['a'] });
    mock.failNextEntitlements();
    const failed = expect(service.refreshEntitlements()).rejects.toThrow();
    await tick();
    await failed;
    sendSnapshot({ revision: 7, productIds: ['a'] });
    expect(service.getEntitlementState()).toEqual({ status: 'error', productIds: ['a'] });
    sendSnapshot({ revision: 8, productIds: ['a'] });
    expect(service.getEntitlementState()).toEqual({ status: 'ready', productIds: ['a'] });
  });

  it('復元と読み取りの完了順が逆でも、新しい結果を採用する', async () => {
    const { mock, service } = await host();
    mock.setOwned(['a'], false);
    const hold = mock.holdNextEntitlements('iap.restore');
    const restore = service.restore();
    await tick();
    await hold.captured;
    mock.setOwned([], false);
    const refresh = service.refreshEntitlements();
    await tick();
    await refresh;
    hold.release();
    await tick();
    await restore;
    expect(service.getEntitlementState()).toEqual({ status: 'ready', productIds: [] });
    mock.failNextEntitlements();
    const failure = expect(service.restore()).rejects.toThrow('Store unavailable');
    await tick();
    await failure;
    expect(service.getEntitlementState()).toEqual({ status: 'error', productIds: [] });
  });

  it('窓口の版違いは非対応として扱い、課金を呼ばない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mock, service } = await host({ contractVersion: 99 });
    const init = service.initializeEntitlements();
    await tick();
    await init;
    expect(service.getEntitlementState().status).toBe('unsupported');
    await service.refreshEntitlements();
    expect(mock.requests.map(r => r.method)).toEqual(['caps.get']);
  });

  it('機能確認の一時的な失敗から前面復帰で回復する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mock, service } = await host();
    const sink = window.webkit!.messageHandlers!.dsNative!;
    const realPost = sink.postMessage.bind(sink);
    sink.postMessage = vi.fn().mockImplementationOnce(() => {}).mockImplementation(realPost);
    const init = service.initializeEntitlements();
    await vi.advanceTimersByTimeAsync(5100);
    await init;
    expect(service.getEntitlementState().status).toBe('error');
    window.dsNative!.receive(JSON.stringify({ event: 'system.appState', data: { state: 'active' } }));
    await tick();
    expect(service.getEntitlementState().status).toBe('ready');
    expect(mock.requests.map(r => r.method)).toEqual(['caps.get', 'iap.entitlements']);
  });

  it('別の購読者が例外を投げたり知らせを重ねても、取り消しと再購入を順に受け取れる', async () => {
    const { service } = await host();
    const init = service.initializeEntitlements();
    await tick();
    await init;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.subscribeEntitlements(() => { throw Error('observer'); });
    service.subscribeEntitlements(() => {
      if (!service.isOwned('a')) sendSnapshot({ revision: 4, productIds: ['a'] });
    });
    const seen: boolean[] = [];
    service.subscribeEntitlements(() => { seen.push(service.isOwned('a')); });
    sendSnapshot({ revision: 2, productIds: ['a'] });
    sendSnapshot({ revision: 3, productIds: [] });
    expect(seen).toEqual([true, false, true]);
  });
});
