/**
 * ネイティブとのやりとりの窓口 (約束は contract.ts)。ネイティブの機能は、すべてここを通して呼ぶ。
 *
 * ネイティブがいるかは、送り先 (iPhone の WKScriptMessageHandler・Android の JavascriptInterface) があるかで決める。
 * 開発用のふりをするネイティブ (mockNative.ts) も、同じ送り先を作って入る
 */

import {
  CONTRACT_VERSION,
  type Capabilities,
  type NativeErrorBody,
  type NativeErrorCode,
  type NativeEvents,
  type NativeMethods,
  type NativeResponse
} from './contract';

interface NativeSink {
  postMessage(message: string): void;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { dsNative?: NativeSink } };
    dsNativeAndroid?: NativeSink;
    /** ネイティブが答えと知らせを渡すところ */
    dsNative?: { sessionReplies?: true; receive(message: string): void };
  }
}

function sink(): NativeSink | null {
  if (typeof window === 'undefined') return null;
  return window.webkit?.messageHandlers?.dsNative ?? window.dsNativeAndroid ?? null;
}

/** Android のアプリか (画面の文の「iPhone」を「この端末」にするため) */
export function isAndroidApp(): boolean {
  return typeof window !== 'undefined' && !!window.dsNativeAndroid;
}

/** ネイティブのアプリの中で動いているか */
export function hasNative(): boolean {
  return sink() !== null;
}

export class NativeError extends Error {
  constructor(readonly code: NativeErrorCode, message: string) {
    super(message);
    this.name = 'NativeError';
  }
}

// Android の旧版は符号付き 32 ビット整数で id を読む。
const MAX_ID = 0x7fffffff;
const LEGACY_KEY = 'ds_native_id_end_v1';
let nextId = 1;
let lastId = MAX_ID;
let legacyRangeReserved = false;
let session: string | undefined;
let cancelBootstrap: ((error: Error) => void) | undefined;
let bootstrapReply: ((response: NativeResponse) => void) | undefined;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<(data: unknown) => void>>();

function receive(message: string): void {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(message);
  } catch {
    console.warn('[native] 読めない知らせ:', message);
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  if (typeof body.event === 'string') {
    // 取引・測位などの知らせは、今開いている画面に届ける。
    listeners.get(body.event)?.forEach(fn => {
      try { fn(body.data); } catch (e) { console.error('[native] 知らせの処理で失敗:', body.event, e); }
    });
    return;
  }
  if (typeof body.id !== 'number' || !Number.isInteger(body.id)) return;
  const parsed: NativeResponse = typeof body.ok === 'boolean'
    ? body as unknown as NativeResponse
    : { id: body.id, session: body.session as string | undefined, ok: false, error: { code: 'io', message: 'Invalid native response' } };
  if (parsed.id === 0) {
    bootstrapReply?.(parsed);
    return;
  }
  if (parsed.session !== session) return;
  const waiter = pending.get(parsed.id);
  if (!waiter) return;
  pending.delete(parsed.id);
  if (parsed.ok) waiter.resolve(parsed.result);
  else waiter.reject(toError(parsed.error));
}

function toError(body: NativeErrorBody): NativeError {
  if (!body || typeof body.code !== 'string' || typeof body.message !== 'string') return new NativeError('io', 'Invalid native error');
  return new NativeError(body.code, body.message);
}

function cancelPending() {
  const error = new NativeError('io', 'Page changed before the native reply');
  cancelBootstrap?.(error);
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

if (typeof window !== 'undefined') {
  window.dsNative = { sessionReplies: true, receive };
  // ページのキャッシュから戻る場合も、離れる前の呼び出しを待ち続けない。番号は戻さない。
  window.addEventListener?.('pagehide', e => { if (e.persisted) cancelPending(); });
  window.addEventListener?.('pageshow', e => { if (e.persisted) cancelPending(); });
}

/** session を返さない旧版には、同じ WebView が読み直されても重ならない番号を先に予約する。 */
function reserveLegacyIds(): void {
  const stored = sessionStorage.getItem(LEGACY_KEY);
  const previous = stored === null ? 0x40000000 : Number(stored);
  if (!Number.isSafeInteger(previous) || previous < 0x40000000 || previous >= MAX_ID || (stored !== null && String(previous) !== stored)) {
    throw new NativeError('io', 'Legacy native request IDs unavailable');
  }
  if (legacyRangeReserved && previous < lastId) throw new NativeError('io', 'Legacy native request IDs were reset');
  const end = Math.min(MAX_ID, previous + 256);
  sessionStorage.setItem(LEGACY_KEY, String(end));
  nextId = previous + 1;
  lastId = end;
  legacyRangeReserved = true;
}

/** ネイティブを呼ぶ。答えが失敗なら NativeError */
export async function callNative<M extends keyof NativeMethods>(method: M, params: NativeMethods[M]['params'], timeoutMs?: number): Promise<NativeMethods[M]['result']> {
  const target = sink();
  if (!target) throw new NativeError('not-supported', 'native bridge is not available');
  const connection = await nativeCapabilityResult();
  if (connection.status !== 'ready') throw new NativeError(connection.status === 'error' ? 'io' : 'not-supported', 'Native capabilities unavailable');
  if (method === 'caps.get') return connection.caps as NativeMethods[M]['result'];
  if (nextId > lastId) {
    if (session !== undefined) throw new NativeError('io', 'Native request IDs exhausted');
    reserveLegacyIds();
  }
  const id = nextId++;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return new Promise<NativeMethods[M]['result']>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    if (timeoutMs !== undefined) timeout = setTimeout(() => reject(new NativeError('io', `${method} timed out`)), timeoutMs);
    target.postMessage(JSON.stringify({ v: CONTRACT_VERSION, id, session, method, params }));
  }).finally(() => {
    clearTimeout(timeout);
    pending.delete(id);
  });
}

/** ネイティブからの知らせを受け取る。戻り値で受け取りをやめる */
export function onNative<E extends keyof NativeEvents>(event: E, fn: (data: NativeEvents[E]) => void): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, set = new Set());
  const f = fn as (data: unknown) => void;
  set.add(f);
  return () => { set.delete(f); };
}

type CapabilityResult =
  | { status: 'ready'; caps: Capabilities }
  | { status: 'unsupported' | 'error' };
let capsPromise: Promise<CapabilityResult> | null = null;

async function openBridge(target: NativeSink): Promise<CapabilityResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const response = await new Promise<NativeResponse>((resolve, reject) => {
    bootstrapReply = resolve;
    cancelBootstrap = reject;
    timeout = setTimeout(() => reject(new NativeError('io', 'caps.get timed out')), 5000);
    target.postMessage(JSON.stringify({ v: CONTRACT_VERSION, id: 0, method: 'caps.get', params: {}, requestSession: true }));
  }).finally(() => {
    clearTimeout(timeout);
    bootstrapReply = undefined;
    cancelBootstrap = undefined;
  });
  if (!response.ok) throw toError(response.error);
  const caps = response.result as Capabilities;
  if (!caps || !Number.isInteger(caps.contractVersion)) throw new NativeError('io', 'Invalid native capabilities');
  if (caps.contractVersion !== CONTRACT_VERSION) {
    console.warn(`[native] 約束の版が違う (アプリ ${caps.contractVersion}・画面 ${CONTRACT_VERSION})`);
    return { status: 'unsupported' };
  }
  if (!['ios', 'android', 'mock'].includes(caps.platform) || !['phone', 'tablet', 'foldable'].includes(caps.deviceKind)
      || !caps.features || typeof caps.features.ble !== 'boolean'
      || (caps.features.bridgeSessions !== undefined && typeof caps.features.bridgeSessions !== 'boolean')) {
    throw new NativeError('io', 'Invalid native capabilities');
  }
  if (caps.features.bridgeSessions === true) {
    if (typeof response.session !== 'string' || !/^[1-9]\d*$/.test(response.session)) throw new NativeError('io', 'Missing native session');
    session = response.session;
  } else {
    if (response.session !== undefined) throw new NativeError('io', 'Unexpected native session');
    reserveLegacyIds();
  }
  return { status: 'ready', caps };
}

export function nativeCapabilityResult(): Promise<CapabilityResult> {
  const target = sink();
  if (!target) return Promise.resolve({ status: 'unsupported' });
  return capsPromise ??= openBridge(target).catch((err): CapabilityResult => {
    console.warn('[native] できることを読めない:', err);
    if (err instanceof NativeError && err.code === 'not-supported') return { status: 'unsupported' };
    capsPromise = null;
    return { status: 'error' };
  });
}

/** ネイティブのできること。ネイティブがない・版が合わないときは null */
export async function nativeCapabilities(): Promise<Capabilities | null> {
  const result = await nativeCapabilityResult();
  return result.status === 'ready' ? result.caps : null;
}

/** base64 → バイト列 */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** バイト列 → base64 */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
