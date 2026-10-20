/**
 * OBD-II (ELM327 と同じ命令で話す Bluetooth LE の機器) (2026-10-20、PLAN-22)。
 *
 * 命令 (文字) を書いて、答えを通知で受け取る。答えの終わりは「>」。
 * 機器によってサービスが違うので、よくある 2 つの形を試す (FFF0: 通知 FFF1・書く FFF2 / FFE0: 通知と書くのが FFE1)。
 * 標準の PID (回転数・車速・アクセル開度・水温・吸気温・負荷) を順に問い合わせる。
 * ステアリング角は車ごとの独自の信号なので、ここでは取れない
 */

export const OBD_BLE_PROFILES = [
  { service: 'fff0', notify: 'fff1', write: 'fff2' },
  { service: 'ffe0', notify: 'ffe1', write: 'ffe1' }
] as const;

/** はじめに送る設定 (初期化・エコーなし・改行なし・空白なし・ヘッダーなし・通信方式は自動) */
export const ELM_INIT = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0'];

/** 問い合わせる値 (モード 01) */
export const OBD_PIDS = [
  { pid: 0x0c, key: 'rpm', ja: '回転数', unit: 'rpm', bytes: 2, decode: (a: number, b: number) => (a * 256 + b) / 4 },
  { pid: 0x0d, key: 'speed_kmh', ja: '車速', unit: 'km/h', bytes: 1, decode: (a: number) => a },
  { pid: 0x11, key: 'throttle_pct', ja: 'アクセル開度', unit: '%', bytes: 1, decode: (a: number) => (a * 100) / 255 },
  { pid: 0x05, key: 'coolant_c', ja: '水温', unit: '°C', bytes: 1, decode: (a: number) => a - 40 },
  { pid: 0x0f, key: 'intake_c', ja: '吸気温', unit: '°C', bytes: 1, decode: (a: number) => a - 40 },
  { pid: 0x04, key: 'load_pct', ja: 'エンジン負荷', unit: '%', bytes: 1, decode: (a: number) => (a * 100) / 255 }
] as const;
export type ObdKey = (typeof OBD_PIDS)[number]['key'];

/** 答えの文字 (「>」まで) から、モード 01 の値を読む。読めなければ null (NO DATA・SEARCHING… など) */
export function parseObdResponse(text: string): { key: ObdKey; value: number } | null {
  const hex = text.replace(/SEARCHING\.\.\./gi, '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  // 1 行に「41 PID データ」が来る。複数の ECU が答えたときは最初のもの
  const m = /41([0-9A-F]{2})([0-9A-F]{2,})/.exec(hex);
  if (!m) return null;
  const pid = parseInt(m[1], 16);
  const def = OBD_PIDS.find(p => p.pid === pid);
  if (!def) return null;
  const data = m[2];
  if (data.length < def.bytes * 2) return null;
  const a = parseInt(data.slice(0, 2), 16);
  const b = def.bytes > 1 ? parseInt(data.slice(2, 4), 16) : 0;
  return { key: def.key, value: Number(def.decode(a, b).toFixed(2)) };
}

export interface ObdSample {
  tMs: number;
  key: ObdKey;
  value: number;
}

/**
 * 命令を 1 つずつ送り、「>」までの答えを待つ。初期化のあと、PID を順に問い合わせ続ける。
 * write は機器に文字を書く関数 (つなぐ層の ble.write)。feed に通知のバイト列を渡す
 */
export class Elm327Client {
  private text = '';
  private waiting: ((answer: string) => void) | null = null;
  private running = false;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly write: (text: string) => Promise<void>,
    private readonly onSample: (s: ObdSample) => void,
    private readonly now: () => number = () => Date.now(),
    /** 1 つの命令の答えを待つ長さ (ミリ秒)。過ぎたら次へ */
    private readonly timeoutMs = 1500
  ) {}

  /** 通知で届いたバイト列 */
  feed(bytes: Uint8Array): void {
    this.text += this.decoder.decode(bytes, { stream: true });
    const end = this.text.indexOf('>');
    if (end >= 0) {
      const answer = this.text.slice(0, end);
      this.text = this.text.slice(end + 1);
      const w = this.waiting;
      this.waiting = null;
      w?.(answer);
    }
  }

  /** 命令を送って答えを待つ (待ちきれなければ '') */
  async send(cmd: string): Promise<string> {
    const answer = new Promise<string>(resolve => {
      const timer = setTimeout(() => { if (this.waiting === done) { this.waiting = null; resolve(''); } }, this.timeoutMs);
      const done = (a: string) => { clearTimeout(timer); resolve(a); };
      this.waiting = done;
    });
    await this.write(`${cmd}\r`);
    return answer;
  }

  /** 初期化して、止めるまで問い合わせ続ける */
  async start(keys: ObdKey[] = OBD_PIDS.map(p => p.key)): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const c of ELM_INIT) {
      if (!this.running) return;
      await this.send(c);
    }
    const pids = OBD_PIDS.filter(p => keys.includes(p.key));
    while (this.running && pids.length > 0) {
      for (const p of pids) {
        if (!this.running) return;
        const r = parseObdResponse(await this.send(`01${p.pid.toString(16).padStart(2, '0').toUpperCase()}`));
        if (r) this.onSample({ tMs: this.now(), ...r });
      }
    }
  }

  stop(): void {
    this.running = false;
    const w = this.waiting;
    this.waiting = null;
    w?.('');
  }
}
