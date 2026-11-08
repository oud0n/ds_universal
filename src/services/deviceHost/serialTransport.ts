import type { LoggerTransport, TransportHandlers } from '../loggerTransport';
import {
  type DeviceHost, type HostEvent, type Localize, type SessionId,
  finishTeardown, hostBytes, hostError, japanese, LOGGER_SERIAL_OPTIONS, MAX_HOST_BYTES, newSessionId
} from './contract';

interface SerialSession {
  id: string;
  opened: boolean;
  interruptions: number;
  handlers: TransportHandlers;
  off?: () => void;
  error?: Error;
  writes: Promise<void>;
}
/** Web Serialを使わず、同じDigSpiceDeviceへ差し込めるUSB通信部品。 */
export class HostSerialTransport implements LoggerTransport {
  private current: SerialSession | null = null;
  private closing: Promise<void> | null = null;
  constructor(private readonly host: DeviceHost, private readonly t: Localize = japanese,
    private readonly makeId: SessionId = newSessionId) {}

  isOpen(): boolean { return !!this.current?.opened; }

  async open(handlers: TransportHandlers): Promise<void> {
    if (this.current) throw hostError({ code: 'io', detail: 'Already open or opening' }, this.t);
    const s: SerialSession = { id: this.makeId(), opened: false, interruptions: 0, handlers, writes: Promise.resolve() };
    this.current = s;
    try {
      await this.closing;
      if (this.current !== s) throw s.error ?? this.cancelled();
      const off = await this.host.listen(event => this.receive(s, event));
      s.off = off;
      if (this.current !== s) { this.detach(s); throw s.error ?? this.cancelled(); }
      await this.host.request('serial.open', { session: s.id, options: { ...LOGGER_SERIAL_OPTIONS } });
      if (this.current !== s) throw s.error ?? this.cancelled();
      s.opened = true;
    } catch (error) {
      this.detach(s);
      // open失敗時もホスト側の途中資源を解放する。closeは冪等。
      await this.closeSession(s).catch(() => {});
      throw hostError(s.error ?? error, this.t);
    }
  }

  write(data: Uint8Array): Promise<void> {
    const s = this.current;
    if (!s?.opened) return Promise.reject(hostError({ code: 'not-connected' }, this.t));
    const bytes = data.slice();
    // 呼出し時点でコピーし、並行writeも呼出し順に全量を送る。
    const work = s.writes.catch(() => {}).then(async () => {
      this.check(s);
      for (let at = 0; at < bytes.length;) {
        const part = Array.from(bytes.subarray(at, at + MAX_HOST_BYTES));
        const { written } = await this.host.request('serial.write', { session: s.id, bytes: part });
        this.check(s);
        if (!Number.isInteger(written) || written <= 0 || written > part.length) {
          throw hostError({ code: 'invalid-data' }, this.t);
        }
        at += written;
      }
    }).catch(error => { throw hostError(error, this.t); });
    s.writes = work;
    return work;
  }

  async close(): Promise<void> {
    const s = this.current;
    if (!s) return;
    s.error = this.cancelled();
    this.detach(s);
    // pending open/writeの完了を待たない。ホストのcloseはそれらも中止する。
    try { await this.closeSession(s); }
    catch (error) { throw hostError(error, this.t); }
  }

  private cancelled(): Error { return hostError({ code: 'cancelled' }, this.t); }
  private check(s: SerialSession): void {
    if (this.current !== s || !s.opened) throw s.error ?? this.cancelled();
  }
  private detach(s: SerialSession): void {
    if (this.current === s) this.current = null;
    s.opened = false;
    s.off?.();
    s.off = undefined;
  }
  private lost(s: SerialSession, error: unknown): void {
    s.error = hostError(error, this.t);
    this.detach(s);
    // 待機する後片づけは先に予約するが、実際のclose命令より先にonLostを呼ぶ。
    const closing = this.closeSession(s, true);
    try { s.handlers.onLost(s.error); }
    finally { void closing.catch(() => {}); }
  }
  private closeSession(s: SerialSession, afterNotification = false): Promise<void> {
    const close = () => this.host.request('serial.close', { session: s.id });
    const closing = finishTeardown(this.closing, afterNotification ? Promise.resolve().then(close) : close());
    this.closing = closing;
    const clear = () => { if (this.closing === closing) this.closing = null; };
    void closing.then(clear, clear);
    return closing;
  }
  private receive(s: SerialSession, event: HostEvent): void {
    if (this.current !== s || event.session !== s.id) return;
    try {
      if (event.type === 'serial.data') {
        s.interruptions = 0;
        s.handlers.onData(hostBytes(event.bytes, this.t));
      } else if (event.type === 'serial.interrupted') {
        s.handlers.onInterrupted?.();
        if (++s.interruptions >= 5) this.lost(s, { code: 'io' });
      } else if (event.type === 'serial.lost') this.lost(s, event.error);
    } catch (error) {
      if (this.current === s) this.lost(s, error);
    }
  }
}
