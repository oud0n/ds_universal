import { useSyncExternalStore } from 'react';
import { callNative, hasNative, NativeError, nativeCapabilityResult, onNative } from '../native/bridge';
import type { EntitlementSnapshot, NativeMethods } from '../native/contract';

export interface EntitlementState {
  readonly status: 'unknown' | 'ready' | 'error' | 'unsupported';
  readonly productIds: readonly string[];
}

const emptyIds: readonly string[] = Object.freeze([]);
let state: EntitlementState = Object.freeze({ status: 'unknown', productIds: emptyIds });
const listeners = new Set<() => void>();
const pendingStates: EntitlementState[] = [];
let notifying = false;
let revision = -1;
let attempt = 0;
let cacheKey = '';
let setup: Promise<boolean> | undefined;
let initialRead: Promise<void> | undefined;

export const getEntitlementState = (): EntitlementState => state;
export function subscribeEntitlements(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function isOwned(productId: string): boolean {
  return state.productIds.includes(productId);
}

export function useOwned(productId: string): boolean {
  return useSyncExternalStore(subscribeEntitlements, () => isOwned(productId), () => false);
}

function publish(status: EntitlementState['status'], ids: readonly string[]) {
  pendingStates.push(Object.freeze({ status, productIds: ids }));
  if (notifying) return;
  notifying = true;
  try {
    while (pendingStates.length) {
      const next = pendingStates.shift()!;
      if (state.status === next.status && next.productIds.length === state.productIds.length && next.productIds.every((id, i) => id === state.productIds[i])) continue;
      state = next;
      for (const listener of [...listeners]) {
        try { listener(); } catch (error) { console.error('[entitlements]', error); }
      }
    }
  } finally { notifying = false; }
}

function normalizeIds(ids: unknown): readonly string[] | null {
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && id.trim().length > 0)) return null;
  return Object.freeze([...new Set<string>(ids)].sort());
}

function cachedIds(): readonly string[] {
  try {
    const cached: unknown = JSON.parse(localStorage.getItem(cacheKey) ?? 'null');
    return normalizeIds(cached) ?? emptyIds;
  } catch { return emptyIds; }
}

function accept(snapshot: EntitlementSnapshot): void {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('Invalid entitlement revision');
  if (snapshot.revision <= revision) return;
  const ids = normalizeIds(snapshot.productIds);
  if (!ids) throw new Error('Invalid entitlement list');
  revision = snapshot.revision;
  // revision は次の起動のものと比べられないので、確認した一覧だけを保存する。
  try { localStorage.setItem(cacheKey, JSON.stringify(ids)); } catch {
    try { localStorage.removeItem(cacheKey); } catch { /* 保存できなくても今の一覧を使う */ }
  }
  publish('ready', ids);
}

function connect(): Promise<boolean> {
  return setup ??= nativeCapabilityResult().then(result => {
    if (result.status === 'error') {
      setup = undefined;
      publish('error', emptyIds);
      return false;
    }
    const caps = result.status === 'ready' ? result.caps : null;
    if (!caps?.features.iap || !caps.features.entitlements) {
      publish('unsupported', emptyIds);
      return false;
    }
    cacheKey = `ds_entitlements_v1_${caps.platform}`;
    onNative('iap.entitlementsChanged', snapshot => {
      try { accept(snapshot); } catch { /* 不完全な知らせでは一覧を変えない */ }
    });
    return true;
  });
}

async function read(method: 'iap.entitlements' | 'iap.restore'): Promise<void> {
  const request = ++attempt;
  const startedAt = revision;
  try {
    accept(await callNative(method, {}, method === 'iap.entitlements' ? 10000 : undefined));
  } catch (error) {
    // 新しい一覧や試みがあるときは、古い失敗でその状態を戻さない。
    if (revision === startedAt && (revision < 0 || request === attempt)) {
      publish('error', revision < 0 ? cachedIds() : state.productIds);
    }
    throw error;
  }
}

/** 起動時に一度だけ。失敗しても次に前面に戻ったときに読み直す。 */
export function initializeEntitlements(): Promise<void> {
  if (!initialRead) {
    if (hasNative()) {
      onNative('system.appState', ({ state }) => {
        if (state === 'active') void refreshEntitlements().catch(() => {});
      });
      window.addEventListener?.('pageshow', e => {
        if (e.persisted) void refreshEntitlements().catch(() => {});
      });
    }
    initialRead = refreshEntitlements().catch(() => {});
  }
  return initialRead;
}

export async function refreshEntitlements(): Promise<void> {
  if (await connect()) await read('iap.entitlements');
}

async function requireStore(): Promise<void> {
  if (!await connect()) throw new NativeError('not-supported', 'Entitlements are unavailable');
}

export async function restore(): Promise<void> {
  await requireStore();
  await read('iap.restore');
}

export async function purchase(productId: string): Promise<NativeMethods['iap.purchase']['result']['status']> {
  await requireStore();
  const before = revision;
  const { status } = await callNative('iap.purchase', { id: productId });
  const confirmed = revision > before && state.status === 'ready' && isOwned(productId);
  if (status === 'purchased' && !confirmed) await refreshEntitlements().catch(() => {});
  return status;
}
