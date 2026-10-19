import { tr } from '../utils/i18n';
import type { LoggerTransport, TransportHandlers } from './loggerTransport';

/**
 * Web Serial API での送受信 (ブラウザ版・Electron 版)。デジスパイスIV (VID: 0x2DCF, PID: 0x6002) を 115200 bps で開く。
 * portProvider を渡すと、実機の代わりにそのシリアルポート (開発用シミュレーター) を使う
 */
export class WebSerialTransport implements LoggerTransport {
  private port: any = null;
  private reader: any = null;
  private keepReading = false;
  private readLoopPromise: Promise<void> | null = null;
  private handlers: TransportHandlers | null = null;

  constructor(private portProvider?: () => Promise<any>) {}

  // 送れる状態か (ポートがあっても、ケーブル抜けの直後などで書き込み口がないときは送れない)
  isOpen(): boolean {
    return this.port !== null && !!this.port.writable;
  }

  async open(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    const log = handlers.onLog ?? (() => {});
    let port: any;
    if (this.portProvider) {
      log('sys', 'シミュレーターのシリアルポートに接続中...');
      port = await this.portProvider();
    } else {
      const nav = navigator as any;
      if (!nav.serial) {
        throw new Error(
          'このブラウザはロガーとの USB 通信（Web Serial API）に対応していません。\n' +
          'パソコンの Chrome または Edge で開いてください。\n' +
          'Safari / Firefox、iPhone・iPad・Android のブラウザでは接続できません（ログの読み込み・解析・変換は使えます）。'
        );
      }

      log('sys', 'デジスパイスIV（VID: 0x2DCF, PID: 0x6002）を検出中...');

      try {
        port = await nav.serial.requestPort({
          filters: [{ usbVendorId: 0x2dcf, usbProductId: 0x6002 }]
        });
      } catch (e: any) {
        // 該当する USB デバイスが OS に認識されていない場合は NotFoundError になる
        if (e?.name === 'NotFoundError') {
          throw new Error(
            'デジスパイスIV が見つかりません (USB シリアルポートとして認識されていません)。\n' +
            '・本体の電源が入っているか\n' +
            '・データ通信対応の USB ケーブルか (充電専用ケーブルでは認識されません)\n' +
            '・USB ハブを介さず PC に直接つないで変わるか\n' +
            'を確認してください。'
          );
        }
        throw e;
      }
    }

    await port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      bufferSize: 8192,
      flowControl: 'none'
    });
    this.port = port;

    try {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (e) {
      console.warn('DTR/RTS skip:', e);
    }

    log('sys', 'シリアルポートを 115200 bps でオープンしました。');
    this.keepReading = true;
    this.readLoopPromise = this.readLoop();
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.port || !this.port.writable) throw new Error(tr('シリアルポートが開いていません', 'The serial port is not open'));
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  async close(): Promise<void> {
    this.keepReading = false;

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch (e) {
        console.warn('reader.cancel warn:', e);
      }
    }

    if (this.readLoopPromise) {
      try {
        await this.readLoopPromise;
      } catch (e) {
        console.warn('readLoopPromise warn:', e);
      }
      this.readLoopPromise = null;
    }

    if (this.port) {
      try {
        await this.port.close();
      } catch (e) {
        console.warn('port.close warn:', e);
      }
      this.port = null;
    }
  }

  private async readLoop(): Promise<void> {
    let streamClosed = false;
    let consecutiveErrors = 0;
    while (this.port && this.port.readable && this.keepReading && !streamClosed) {
      try {
        this.reader = this.port.readable.getReader();
        while (this.keepReading) {
          const { value, done } = await this.reader.read();
          if (done) {
            streamClosed = true;
            break;
          }
          if (value) {
            consecutiveErrors = 0;
            this.handlers?.onData(value);
          }
        }
      } catch (err: any) {
        if (this.port && this.keepReading) {
          this.handlers?.onLog?.('err', `受信ループ例外: ${err?.message || err}`);
        }
        this.handlers?.onInterrupted?.();
        // バッファ溢れ等の一時的なエラーは port.readable が再生成されるので読み直す。
        // ケーブル抜け等の致命的なエラーでは port.readable が null になりループを抜ける
        if (++consecutiveErrors >= 5) break;
      } finally {
        if (this.reader) {
          try { this.reader.releaseLock(); } catch {}
          this.reader = null;
        }
      }
    }

    // close() 以外でループを抜けた = ケーブル抜け等による通信断。待っている処理をすぐ失敗させるため、閉じるより先に知らせる
    if (this.keepReading) {
      this.keepReading = false;
      const port = this.port;
      this.port = null;
      this.handlers?.onLost(new Error(tr('本体との通信が切断されました', 'Communication with the logger was lost')));
      if (port) {
        try { await port.close(); } catch {}
      }
    }
  }
}
