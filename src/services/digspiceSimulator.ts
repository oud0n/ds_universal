/**
 * 開発用 DigSpice IV シミュレーター (Web Serial の SerialPort 互換オブジェクト)
 *
 * 実機なしでロガー画面の動作確認を行うためのもの。開発サーバーで `?sim=1` を付けて開くと使用される。
 * 応答は protocol_analysis.md のキャプチャ結果 (PMTK605 / 182 / 300 / 400, PTSI777 / PTSI990) に合わせている。
 * それ以外のコマンドには実機と同じく応答しない。
 */

function checksum(body: string): string {
  let cs = 0;
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
  return cs.toString(16).toUpperCase().padStart(2, '0');
}

function sentence(body: string): string {
  return `$${body}*${checksum(body)}\r\n`;
}

export function createSimulatedPort(): any {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let rxBuffer = '';

  // 本体の内部状態
  let fixIntervalMs = 50;
  let autoLogSpeed = '30.00';
  let writePointer = 0x200;
  const logSettings: Record<string, string> = { '2': '0004103F', '3': '1', '4': '0', '5': '0', '6': '2' };

  const send = (body: string) => {
    if (controller) controller.enqueue(encoder.encode(sentence(body)));
  };
  const reply = (body: string, delayMs: number = 15) => setTimeout(() => send(body), delayMs);

  const handleCommand = (line: string): void => {
    const m = /^\$([^*]+)\*([0-9A-Fa-f]{2})$/.exec(line.trim());
    if (!m || checksum(m[1]) !== m[2].toUpperCase()) return;
    const f = m[1].split(',');
    const id = f[0];

    if (id === 'PMTK605') {
      reply('PMTK705,DS4,1.01');
    } else if (id === 'PMTK400') {
      reply(`PMTK500,${fixIntervalMs},0,0,0.0,0.0`);
    } else if (id === 'PMTK300') {
      fixIntervalMs = parseInt(f[1], 10) || fixIntervalMs;
      reply(m[1]);
      reply('PMTK001,300,3', 25);
    } else if (id === 'PTSI777') {
      if (f[1] === '2') autoLogSpeed = f[2];
      reply(`PTSI777,0,${autoLogSpeed}`);
    } else if (id === 'PTSI990') {
      reply('PTSI990,2,0,27');
    } else if (id === 'PMTK182') {
      if (f[1] === '2') {
        const type = f[2];
        const value =
          type === '8' ? writePointer.toString(16).toUpperCase().padStart(8, '0') :
          type === '10' ? '00000000' :
          logSettings[type] ?? '0';
        reply(`PMTK182,3,${type},${value}`);
        reply('PMTK001,182,2,3', 25);
      } else if (f[1] === '1') {
        logSettings[f[2]] = f[3];
        reply('PMTK001,182,1,3');
      } else if (f[1] === '6') {
        writePointer = 0x200;
        reply('PMTK001,182,6,3', 400);
      } else if (f[1] === '7') {
        const offset = parseInt(f[2], 16);
        const length = parseInt(f[3], 16);
        // 空ログ (全バイト 0xFF) を 2048 バイト単位で返す
        setTimeout(() => {
          for (let pos = 0; pos < length; pos += 0x800) {
            const size = Math.min(0x800, length - pos);
            send(`PMTK182,8,${(offset + pos).toString(16).toUpperCase().padStart(8, '0')},${'FF'.repeat(size)}`);
          }
        }, offset === 0 ? 30 : 120);
      }
    }
  };

  return {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,

    async open() {
      this.readable = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
        cancel() { controller = null; }
      });
      this.writable = new WritableStream<Uint8Array>({
        write(chunk) {
          rxBuffer += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = rxBuffer.indexOf('\n')) >= 0) {
            const line = rxBuffer.substring(0, idx);
            rxBuffer = rxBuffer.substring(idx + 1);
            handleCommand(line);
          }
        }
      });
    },

    async setSignals() {},

    async close() {
      controller = null;
      this.readable = null;
      this.writable = null;
    },

    getInfo() {
      return { usbVendorId: 0x2dcf, usbProductId: 0x6002 };
    }
  };
}
