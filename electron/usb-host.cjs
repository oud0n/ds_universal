const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const MAX_BYTES = 65536, MAX_FRAME = 512 * 1024;
const OPTIONS = { vendorId: 0x2dcf, productId: 0x6002, baudRate: 115200, dataBits: 8, stopBits: 1,
  parity: 'none', flowControl: 'none', dataTerminalReady: true, requestToSend: true };
const CODES = new Set(['permission-denied', 'not-found', 'not-connected', 'cancelled', 'not-supported', 'io', 'invalid-data']);
const fault = (code, detail) => ({ code, detail });
const cancelled = () => fault('cancelled', 'USB session closed');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function object(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function bytes(value) {
  if (!Array.isArray(value) || value.length > MAX_BYTES) return false;
  for (const b of value) if (!Number.isInteger(b) || b < 0 || b > 255) return false;
  return true;
}
function validate(method, params) {
  if (!['serial.open', 'serial.write', 'serial.close'].includes(method)) throw fault('not-supported', 'Only USB serial requests are enabled');
  const keys = method === 'serial.open' ? ['session', 'options'] : method === 'serial.write' ? ['session', 'bytes'] : ['session'];
  if (!object(params, keys) || typeof params.session !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(params.session)) throw fault('invalid-data', 'Invalid USB request');
  if (method === 'serial.open' && (!object(params.options, Object.keys(OPTIONS)) ||
    Object.keys(OPTIONS).some(k => params.options[k] !== OPTIONS[k]))) throw fault('invalid-data', 'Unsupported USB options');
  if (method === 'serial.write' && (!bytes(params.bytes) || !params.bytes.length)) throw fault('invalid-data', 'Invalid USB bytes');
}

/** 1接続に一つのRustプロセス。終了はpipe/OS資源が閉じたcloseイベントまで待つ。 */
class UsbHostBroker {
  constructor({ executable, args = [], onEvent, spawnProcess = spawn, readyMs = 3000, requestMs = 15000, closeMs = 500 }) {
    Object.assign(this, { executable, args, onEvent, spawnProcess, readyMs, requestMs, closeMs });
    this.active = null;
    this.retired = new Set();
    this.disposed = false;
  }
  async request(method, params) {
    validate(method, params);
    if (this.disposed) throw cancelled();
    if (method === 'serial.close') return this.close(params.session);
    if (this.retired.has(params.session)) throw cancelled();
    if (method === 'serial.open') {
      if (this.active) throw fault('io', 'A USB session already owns the host');
      if (this.retired.size >= 4096) throw fault('io', 'Session limit reached; reload window');
      const r = this.start(params.session);
      try {
        await r.ready.promise;
        if (r.closing) throw cancelled();
        const value = await this.rpc(r, method, params);
        if (r.closing) throw cancelled();
        if (value !== null) throw fault('invalid-data', 'Invalid USB open response');
        r.opened = true;
      } catch (error) { await this.close(r.session); throw error; }
      return;
    }
    const r = this.active;
    if (!r || r.session !== params.session || !r.opened || r.closing) throw fault('not-connected', 'No open USB session');
    const result = await this.rpc(r, method, params);
    if (r.closing) throw cancelled();
    if (!object(result, ['written']) || !Number.isInteger(result.written) || result.written <= 0 || result.written > params.bytes.length) {
      this.fail(r, fault('invalid-data', 'Invalid USB write response'));
      throw fault('invalid-data', 'Invalid USB write response');
    }
    return result;
  }
  start(session) {
    const r = { session, opened: false, closing: false, ready: deferred(), exited: deferred(), pending: new Map(),
      nextId: 1, buffer: '', decoder: new StringDecoder('utf8'), timers: [], closePromise: null, child: null };
    this.active = r;
    try {
      r.child = this.spawnProcess(this.executable, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (_) {
      this.active = null; this.retired.add(session); throw fault('io', 'Unable to start USB host');
    }
    r.readyTimer = setTimeout(() => this.fail(r, fault('io', 'USB host handshake timed out')), this.readyMs);
    r.child.stdout.on('data', chunk => this.output(r, chunk));
    r.child.stderr.on('data', () => {});
    r.child.stdin.on('error', () => this.fail(r, fault('io', 'USB host input closed')));
    r.child.on('error', () => this.fail(r, fault('io', 'Unable to start USB host')));
    r.child.on('close', () => {
      clearTimeout(r.readyTimer); r.timers.forEach(clearTimeout);
      const error = r.closing ? cancelled() : fault('io', 'USB host exited');
      this.rejectPending(r, error); r.ready.reject(error);
      this.retired.add(session);
      if (this.active === r) this.active = null;
      if (!r.closing) this.emit({ type: 'serial.lost', session, error });
      r.closing = true; r.exited.resolve();
    });
    return r;
  }
  rpc(r, method, params) {
    if (r.pending.size >= 32) return Promise.reject(fault('io', 'USB request queue full'));
    const id = r.nextId++, d = deferred();
    const timer = setTimeout(() => this.fail(r, fault('io', 'USB request timed out')), this.requestMs);
    r.pending.set(id, { ...d, timer });
    try { r.child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
    catch (_) { this.fail(r, fault('io', 'USB host input failed')); }
    return d.promise;
  }
  output(r, chunk) {
    if (this.active !== r) return;
    r.buffer += r.decoder.write(chunk);
    try {
      let at;
      while ((at = r.buffer.indexOf('\n')) >= 0) {
        const line = r.buffer.slice(0, at); r.buffer = r.buffer.slice(at + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('frame');
        this.message(r, JSON.parse(line));
      }
      if (Buffer.byteLength(r.buffer) > MAX_FRAME) throw new Error('frame');
    } catch (_) { this.fail(r, fault('invalid-data', 'Invalid USB host output')); }
  }
  message(r, message) {
    if (message.type === 'ready') {
      if (!object(message, ['type', 'version']) || message.version !== 1 || r.handshaken) throw new Error('handshake');
      r.handshaken = true; clearTimeout(r.readyTimer); r.ready.resolve(); return;
    }
    if (!r.handshaken) throw new Error('missing handshake');
    if (message.type === 'response') {
      if (!Number.isSafeInteger(message.id) || message.id < 1) throw new Error('response id');
      const pending = r.pending.get(message.id);
      if (!pending) { if (r.closing) return; throw new Error('unknown response'); }
      r.pending.delete(message.id); clearTimeout(pending.timer);
      if (object(message, ['type', 'id', 'result'])) pending.resolve(message.result);
      else if (object(message, ['type', 'id', 'error']) && message.error && CODES.has(message.error.code)) {
        pending.reject(fault(message.error.code, typeof message.error.detail === 'string' ? message.error.detail.slice(0, 256) : 'USB host error'));
      } else { pending.reject(fault('invalid-data', 'Invalid USB response')); throw new Error('response'); }
      return;
    }
    if (message.type !== 'event' || !object(message, ['type', 'event'])) throw new Error('event');
    const e = message.event;
    if (!e || e.session !== r.session) throw new Error('event session');
    if (e.type === 'serial.data') { if (!object(e, ['type', 'session', 'bytes']) || !bytes(e.bytes)) throw new Error('bytes'); }
    else if (e.type === 'serial.interrupted') { if (!object(e, ['type', 'session'])) throw new Error('interrupted'); }
    else if (e.type === 'serial.lost') { if (!object(e, ['type', 'session', 'error']) || !e.error || !CODES.has(e.error.code)) throw new Error('lost'); }
    else throw new Error('event type');
    if (r.closing) return;
    this.emit(e);
    if (e.type === 'serial.lost') void this.close(r.session).catch(() => {});
  }
  emit(event) { try { this.onEvent(event); } catch (_) {} }
  rejectPending(r, error) {
    for (const pending of r.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    r.pending.clear();
  }
  fail(r, error) {
    if (this.active !== r) return;
    const notify = !r.closing;
    r.closing = true; r.closePromise ??= r.exited.promise;
    this.retired.add(r.session); r.ready.reject(error); this.rejectPending(r, error);
    if (notify) this.emit({ type: 'serial.lost', session: r.session, error });
    try { r.child.kill('SIGKILL'); } catch (_) {}
  }
  async close(session) {
    const r = this.active;
    if (!r || r.session !== session) {
      if (this.retired.size >= 4096 && !this.retired.has(session)) throw fault('io', 'Session limit reached; reload window');
      this.retired.add(session); return;
    }
    if (r.closePromise) return r.closePromise;
    r.closing = true; this.retired.add(session);
    r.closePromise = r.exited.promise;
    r.ready.reject(cancelled()); this.rejectPending(r, cancelled());
    r.timers.push(setTimeout(() => { try { r.child.kill('SIGTERM'); } catch (_) {} }, this.closeMs));
    r.timers.push(setTimeout(() => { try { r.child.kill('SIGKILL'); } catch (_) {} }, this.closeMs * 2));
    void this.rpc(r, 'serial.close', { session }).then(() => { r.child.stdin.end(); }, () => { try { r.child.kill('SIGKILL'); } catch (_) {} });
    return r.closePromise;
  }
  async dispose() {
    this.disposed = true;
    const r = this.active;
    if (!r) return;
    r.closing = true; r.closePromise ??= r.exited.promise;
    r.ready.reject(cancelled()); this.rejectPending(r, cancelled());
    try { r.child.kill('SIGKILL'); } catch (_) {}
    await r.exited.promise;
  }
}
module.exports = { UsbHostBroker, validate, OPTIONS, MAX_FRAME };
