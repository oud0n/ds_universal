import type { DeviceHost, HostCommands, HostEvent } from './contract';

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
export class FakeHost implements DeviceHost {
  private serial = 0;
  readonly makeId = () => `test-${++this.serial}`;
  readonly listeners = new Set<(event: HostEvent) => void>();
  readonly calls: { method: keyof HostCommands; params: HostCommands[keyof HostCommands]['params'] }[] = [];
  onListen?: () => Promise<void>;
  onRequest: (method: keyof HostCommands, params: HostCommands[keyof HostCommands]['params']) => Promise<unknown> = async (method, params) => {
    if (method === 'serial.write' && 'bytes' in params) return { written: params.bytes.length };
    if (method === 'ble.read') return { bytes: [1, 2, 3] };
  };
  async listen(receive: (event: HostEvent) => void) {
    await this.onListen?.();
    this.listeners.add(receive);
    return () => { this.listeners.delete(receive); };
  }
  async request<K extends keyof HostCommands>(method: K, params: HostCommands[K]['params']): Promise<HostCommands[K]['result']> {
    this.calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
    return await this.onRequest(method, params) as HostCommands[K]['result'];
  }
  emit(event: HostEvent) { [...this.listeners].forEach(receive => receive(JSON.parse(JSON.stringify(event)))); }
  lastSession(method: keyof HostCommands): string {
    return this.calls.filter(call => call.method === method).slice(-1)[0]!.params.session;
  }
}

/** 合成データだけを使う。未知の命令・書込み設定・消去には応答しない。 */
export class SerialPeer {
  readonly writes: number[] = [];
  readonly commands: string[] = [];
  readonly image = new Uint8Array(4096).fill(255);
  private text = '';
  mode: 'normal' | 'missing' | 'conflict' | 'bad-checksum' = 'normal';
  constructor(private deliver: (bytes: Uint8Array) => void, private fragment: number) {
    for (let i = 0; i < 256; i++) this.image[i] = i;
  }
  receive(bytes: Uint8Array) {
    this.writes.push(...bytes);
    this.text += new TextDecoder().decode(bytes);
    for (let at; (at = this.text.indexOf('\n')) >= 0;) {
      const command = this.text.slice(0, at).trim();
      this.text = this.text.slice(at + 1);
      this.commands.push(command);
      const body = command.slice(1, command.indexOf('*'));
      const replies: Record<string, string> = {
        PMTK605: 'PMTK705,DS4,1.01', 'PMTK182,2,8': 'PMTK182,3,8,00000200',
        'PMTK182,2,10': 'PMTK182,3,10,00000000', 'PMTK182,2,2': 'PMTK182,3,2,0004103F',
        'PMTK182,2,3': 'PMTK182,3,3,1', 'PMTK182,2,4': 'PMTK182,3,4,0',
        'PMTK182,2,5': 'PMTK182,3,5,0', 'PMTK182,2,6': 'PMTK182,3,6,2',
        PMTK400: 'PMTK500,50,0,0,0,0', 'PTSI990,2,0': 'PTSI990,2,0,27', 'PTSI777,1': 'PTSI777,0,30.00'
      };
      if (replies[body]) this.send(sentence(replies[body]));
      else if (body === 'PMTK182,7,0,1000') {
        // 逆順・同一ブロック再送も正常な入力として両経路へ流す。
        this.block(0x800);
        if (this.mode !== 'missing') this.block(0);
        if (this.mode === 'conflict') this.block(0x800, true);
        else this.block(0x800);
      } else if (body === 'PMTK182,7,FFFFF0,10') this.send(sentence('PMTK182,8,00FFFFF0,FF'));
      else throw new Error(`Unexpected fixture command: ${command}`);
    }
  }
  private block(at: number, conflict = false) {
    const bytes = this.image.slice(at, at + 2048);
    if (conflict) bytes[0] ^= 1;
    const text = sentence(`PMTK182,8,${at.toString(16)},${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`);
    this.send(this.mode === 'bad-checksum' && at === 0 ? text.replace(/\*../, '*00') : text);
  }
  send(text: string) {
    const bytes = new TextEncoder().encode(text);
    for (let at = 0; at < bytes.length; at += this.fragment) this.deliver(bytes.slice(at, at + this.fragment));
  }
}
export function sentence(body: string): string {
  let sum = 0;
  for (const c of body) sum ^= c.charCodeAt(0);
  return `$${body}*${sum.toString(16).padStart(2, '0').toUpperCase()}\r\n`;
}

export function webSerialFixture(fragment: number) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const peer = new SerialPeer(bytes => controller.enqueue(bytes), fragment);
  const port = {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    async open() {
      this.readable = new ReadableStream({ start: c => { controller = c; } });
      this.writable = new WritableStream({ write: bytes => peer.receive(bytes) });
    },
    async setSignals() {},
    async close() { this.readable = null; this.writable = null; },
    lose() { this.readable = null; controller.close(); },
    interrupt() {
      controller.error(new Error('synthetic interruption'));
      this.readable = new ReadableStream({ start: c => { controller = c; } });
    }
  };
  return { peer, port };
}

export function hostSerialFixture(fragment: number) {
  const host = new FakeHost();
  let session = '';
  const peer = new SerialPeer(bytes => host.emit({ type: 'serial.data', session, bytes: Array.from(bytes) }), fragment);
  host.onRequest = async (method, params) => {
    if (method === 'serial.open') session = params.session;
    if (method === 'serial.write' && 'bytes' in params) {
      peer.receive(Uint8Array.from(params.bytes));
      return { written: params.bytes.length };
    }
  };
  return { host, peer, lose: () => host.emit({ type: 'serial.lost', session, error: { code: 'io' } }),
    interrupt: () => host.emit({ type: 'serial.interrupted', session }) };
}
