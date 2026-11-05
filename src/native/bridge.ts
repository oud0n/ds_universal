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
  type NativeEvent,
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
    dsNative?: { receive(message: string): void };
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

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<(data: unknown) => void>>();

function receive(message: string): void {
  let parsed: NativeResponse | NativeEvent;
  try {
    parsed = JSON.parse(message);
  } catch {
    console.warn('[native] 読めない知らせ:', message);
    return;
  }
  if ('event' in parsed) {
    listeners.get(parsed.event)?.forEach(fn => {
      try { fn(parsed.data); } catch (e) { console.error('[native] 知らせの処理で失敗:', parsed.event, e); }
    });
    return;
  }
  const waiter = pending.get(parsed.id);
  if (!waiter) return;
  pending.delete(parsed.id);
  if (parsed.ok) waiter.resolve(parsed.result);
  else waiter.reject(toError(parsed.error));
}

function toError(body: NativeErrorBody): NativeError {
  return new NativeError(body.code, body.message);
}

if (typeof window !== 'undefined') window.dsNative = { receive };

/** ネイティブを呼ぶ。答えが失敗なら NativeError */
export function callNative<M extends keyof NativeMethods>(method: M, params: NativeMethods[M]['params'], timeoutMs?: number): Promise<NativeMethods[M]['result']> {
  const target = sink();
  if (!target) return Promise.reject(new NativeError('not-supported', 'native bridge is not available'));
  const id = nextId++;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return new Promise<NativeMethods[M]['result']>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    if (timeoutMs !== undefined) timeout = setTimeout(() => reject(new NativeError('io', `${method} timed out`)), timeoutMs);
    target.postMessage(JSON.stringify({ v: CONTRACT_VERSION, id, method, params }));
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

export function nativeCapabilityResult(): Promise<CapabilityResult> {
  if (!hasNative()) return Promise.resolve({ status: 'unsupported' });
  capsPromise ??= callNative('caps.get', {}, 5000).then(
    (caps): CapabilityResult => {
      if (caps.contractVersion !== CONTRACT_VERSION) {
        console.warn(`[native] 約束の版が違う (アプリ ${caps.contractVersion}・画面 ${CONTRACT_VERSION})`);
        return { status: 'unsupported' };
      }
      return { status: 'ready', caps };
    },
    (err): CapabilityResult => {
      capsPromise = null;
      console.warn('[native] できることを読めない:', err);
      return { status: 'error' };
    }
  );
  return capsPromise;
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
