/**
 * DigSpice IV (USB / Web Serial API) 通信管理サービス
 */


export interface LogInfo {
  logCapacityBytes: number;
  usedBytes: number;
  writePointerHex: string;
  status: string;
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  receivedBlocks: number;
  totalBlocks: number;
  statusText: string;
}

// 本体の現在設定 (公式アプリの GetConfig シーケンス相当)
export interface DeviceConfig {
  model: string;
  firmwareVersion: string;
  writePointerHex: string;
  usedBytes: number;
  flashStatusHex: string;
  logFormatMaskHex: string;
  recordMode: string;
  timeInterval: string;
  distanceInterval: string;
  speedInterval: string;
  fixIntervalMs: number;
  samplingRateHz: number;
  statusCode: string;       // $PTSI990,2,0 の応答値 (意味は未解明)
  autoLogSpeedKmh: number;
}

export type SamplingRateHz = 5 | 10 | 20;

const FLASH_CAPACITY_BYTES = 0x1000000;
// ログ吸い出しで本体が 1 行に載せて返すデータの大きさ
const DOWNLOAD_BLOCK_SIZE = 0x800;
// 吸い出しで欠けたブロックだけを、範囲を指定して本体に読み直させる (BUG-16)。
// 公式アプリはこの使い方をしておらず、本体が範囲指定の読み出しに正しく応じるかを実機で確かめていないため、無効にしてある
export const PARTIAL_REFETCH_ENABLED = false;
const PARTIAL_REFETCH_ATTEMPTS = 3;
// ログ全消去の完了応答を待つ最大時間
const ERASE_TIMEOUT_MS = 120000;

// 実機キャプチャで確認済みなのは 10 / 20 / 30 / 35 km/h。極端な値で記録が始まらなくなるのを防ぐ
export const AUTO_LOG_SPEED_MIN = 5;
export const AUTO_LOG_SPEED_MAX = 100;

const RATE_INTERVAL_MS: Record<SamplingRateHz, number> = { 20: 50, 10: 100, 5: 200 };

// $PMTK001 ACK のフラグ値
const ACK_FLAG_TEXT: Record<number, string> = {
  0: '無効なコマンド',
  1: '未対応のコマンド',
  2: '実行失敗',
  3: '成功'
};

const READ_BUFFER_LIMIT = 1024 * 1024;

// `$...*HH` 形式のチェックサム検証
function verifyNmeaChecksum(line: string): boolean {
  const m = /^\$([^*]*)\*([0-9A-Fa-f]{2})\s*$/.exec(line);
  if (!m) return false;
  let cs = 0;
  for (let i = 0; i < m[1].length; i++) cs ^= m[1].charCodeAt(i);
  return cs === parseInt(m[2], 16);
}

export class DigSpiceDevice {
  private port: any = null;
  private reader: any = null;
  private readBuffer: string = '';
  private pendingLineResolvers: Array<(line: string) => void> = [];
  private streamingHandler: ((line: string) => void) | null = null;
  private isBusy: boolean = false;
  private keepReading: boolean = false;
  private readLoopPromise: Promise<void> | null = null;

  private pendingCancels = new Set<(err: Error) => void>();
  private streamAbort: ((err: Error) => void) | null = null;

  public onLogMessage?: (type: 'tx' | 'rx' | 'sys' | 'err', msg: string) => void;
  // ケーブル抜け等で通信が途絶えたときの通知
  public onConnectionLost?: () => void;

  private log(type: 'tx' | 'rx' | 'sys' | 'err', msg: string) {
    if (this.onLogMessage) this.onLogMessage(type, msg);
    console.log(`[DigSpice][${type}] ${msg}`);
  }

  // NMEA XORチェックサム計算
  private static calculateChecksum(body: string): string {
    let clean = body.trim();
    if (clean.startsWith('$')) clean = clean.substring(1);
    const starIdx = clean.indexOf('*');
    if (starIdx >= 0) clean = clean.substring(0, starIdx);

    let cs = 0;
    for (let i = 0; i < clean.length; i++) {
      cs ^= clean.charCodeAt(i);
    }
    return cs.toString(16).toUpperCase().padStart(2, '0');
  }

  // NMEA コマンド整形 ($<Body>*<CS>\r\n)
  private static formatCommand(body: string): string {
    const cs = DigSpiceDevice.calculateChecksum(body);
    let clean = body.trim();
    if (clean.startsWith('$')) clean = clean.substring(1);
    const starIdx = clean.indexOf('*');
    if (starIdx >= 0) clean = clean.substring(0, starIdx);
    return `$${clean}*${cs}\r\n`;
  }

  public isConnected(): boolean {
    return this.port !== null;
  }

  // シリアルポート接続 (デジスパイスIV VID: 0x2DCF, PID: 0x6002)
  // portProvider: 実機の代わりに使うシリアルポートの生成関数 (開発用シミュレーター)
  public async connect(portProvider?: () => Promise<any>): Promise<boolean> {
    let port: any;
    if (portProvider) {
      this.log('sys', 'シミュレーターのシリアルポートに接続中...');
      port = await portProvider();
    } else {
      const nav = navigator as any;
      if (!nav.serial) {
        throw new Error(
          'このブラウザはロガーとの USB 通信（Web Serial API）に対応していません。\n' +
          'パソコンの Chrome または Edge で開いてください。\n' +
          'Safari / Firefox、iPhone・iPad・Android のブラウザでは接続できません（ログの読み込み・解析・変換は使えます）。'
        );
      }

      this.log('sys', 'デジスパイスIV（VID: 0x2DCF, PID: 0x6002）を検出中...');

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
    this.readBuffer = '';

    try {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (e) {
      console.warn('DTR/RTS skip:', e);
    }

    this.log('sys', 'シリアルポートを 115200 bps でオープンしました。');
    this.keepReading = true;
    this.readLoopPromise = this.startReadLoop();
    return true;
  }

  public async disconnect(): Promise<void> {
    // 応答待ち・ダウンロード中の処理を中断させる (切断後に残った待機が、次の接続の応答を拾わないように)
    const closed = new Error('シリアルポートを切断しました');
    Array.from(this.pendingCancels).forEach(cancel => cancel(closed));
    if (this.streamAbort) this.streamAbort(closed);
    this.isBusy = false;
    this.streamingHandler = null;
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

    this.log('sys', 'シリアルポートを切断しました。');
  }

  // コマンド送信
  public async sendCommand(body: string): Promise<void> {
    if (!this.port || !this.port.writable) throw new Error('シリアルポートが開いていません');
    const fullCmd = DigSpiceDevice.formatCommand(body);
    this.log('tx', fullCmd.trim());

    const encoder = new TextEncoder();
    const data = encoder.encode(fullCmd);
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  // 行待機
  public async waitForLine(prefix: string, timeoutMs: number = 3000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let timer: any = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        const idx = this.pendingLineResolvers.indexOf(resolver);
        if (idx >= 0) this.pendingLineResolvers.splice(idx, 1);
        this.pendingCancels.delete(cancel);
      };

      const resolver = (line: string) => {
        if (line.startsWith(prefix)) {
          cleanup();
          resolve(line);
        }
      };

      // 通信断のときはタイムアウトを待たずに失敗させる
      const cancel = (err: Error) => {
        cleanup();
        reject(err);
      };

      this.pendingLineResolvers.push(resolver);
      this.pendingCancels.add(cancel);

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`レスポンス待機タイムアウト: ${prefix} (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  // 待機を先に登録してから送信する (応答の取りこぼし防止)
  private async query(body: string, prefix: string, timeoutMs: number = 3000): Promise<string> {
    const waiter = this.waitForLine(prefix, timeoutMs);
    try {
      await this.sendCommand(body);
    } catch (e) {
      waiter.catch(() => {});
      throw e;
    }
    return waiter;
  }

  private static fields(line: string): string[] {
    return line.split('*')[0].split(',');
  }

  // 応答の指定フィールドを取り出す。欠落・空欄は例外にする
  private static field(line: string, index: number): string {
    const value = DigSpiceDevice.fields(line)[index];
    if (value === undefined || value === '') throw new Error(`本体から想定外の応答を受信しました: ${line}`);
    return value;
  }

  // $PMTK001,<Cmd>,...,<Flag> の ACK を待ち、成功 (3) 以外は例外にする
  private async sendExpectAck(body: string, ackPrefix: string, flagIndex: number, timeoutMs: number = 3000): Promise<void> {
    const ack = await this.query(body, ackPrefix, timeoutMs);
    const flag = parseInt(DigSpiceDevice.fields(ack)[flagIndex], 10);
    if (flag !== 3) {
      throw new Error(`本体がコマンドを受理しませんでした: ${body} (${ACK_FLAG_TEXT[flag] ?? `flag=${flag}`})`);
    }
  }

  // 設定・ダウンロード等の排他実行
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.port) throw new Error('シリアルポートが開いていません');
    if (this.isBusy) throw new Error('他の操作が実行中です');
    this.isBusy = true;
    try {
      return await fn();
    } finally {
      this.isBusy = false;
    }
  }

  private async startReadLoop(): Promise<void> {
    const decoder = new TextDecoder();
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
            const chunk = decoder.decode(value, { stream: true });
            this.readBuffer += chunk;
            // 改行のないゴミデータが続いた場合に際限なく溜め込まない
            if (this.readBuffer.length > READ_BUFFER_LIMIT && this.readBuffer.indexOf('\n') < 0) {
              this.readBuffer = '';
            }

            let newlineIdx;
            while ((newlineIdx = this.readBuffer.indexOf('\n')) >= 0) {
              const line = this.readBuffer.substring(0, newlineIdx).replace(/\r$/, '');
              this.readBuffer = this.readBuffer.substring(newlineIdx + 1);

              if (line.trim().length > 0) {
                if (this.streamingHandler) {
                  this.streamingHandler(line);
                } else if (!verifyNmeaChecksum(line)) {
                  // 化けた行を応答として採用しない
                  this.log('err', `チェックサム不一致の行を破棄: ${line.substring(0, 80)}`);
                  continue;
                } else {
                  this.log('rx', line);
                }

                for (let i = this.pendingLineResolvers.length - 1; i >= 0; i--) {
                  this.pendingLineResolvers[i](line);
                }
              }
            }
          }
        }
      } catch (err: any) {
        if (this.port && this.keepReading) {
          this.log('err', `受信ループ例外: ${err?.message || err}`);
        }
        // バッファ溢れ等の一時的なエラーは port.readable が再生成されるので読み直す。
        // ケーブル抜け等の致命的なエラーでは port.readable が null になりループを抜ける
        this.readBuffer = '';
        if (++consecutiveErrors >= 5) break;
      } finally {
        if (this.reader) {
          try { this.reader.releaseLock(); } catch {}
          this.reader = null;
        }
      }
    }

    // disconnect() 以外でループを抜けた = ケーブル抜け等による通信断
    if (this.keepReading) {
      this.keepReading = false;
      this.streamingHandler = null;
      const port = this.port;
      this.port = null;

      // 応答待ち・ダウンロード中の処理をタイムアウトを待たずに失敗させる
      const lost = new Error('本体との通信が切断されました');
      Array.from(this.pendingCancels).forEach(cancel => cancel(lost));
      if (this.streamAbort) this.streamAbort(lost);

      if (port) {
        try { await port.close(); } catch {}
      }
      this.log('err', '本体との通信が切断されました。');
      if (this.onConnectionLost) this.onConnectionLost();
    }
  }

  // ログ容量情報取得
  public async getLogInfo(): Promise<LogInfo> {
    return this.exclusive(async () => {
      await this.query('PMTK605', '$PMTK705');

      const wpLine = await this.query('PMTK182,2,8', '$PMTK182,3,8,');
      const wpHex = DigSpiceDevice.field(wpLine, 3);
      const wpAddr = parseInt(wpHex, 16);
      if (Number.isNaN(wpAddr)) throw new Error(`本体から想定外の応答を受信しました: ${wpLine}`);
      const usedBytes = Math.max(0, wpAddr - 0x200);

      return {
        // 16MB flash。公式アプリが末尾アドレス 0xFFFFF0 を読み出していること、実機で 11MB 超の記録を確認したことからの推定
        logCapacityBytes: FLASH_CAPACITY_BYTES,
        usedBytes,
        writePointerHex: wpHex,
        status: usedBytes > 0 ? `記録あり (${Math.round(usedBytes / 1024)} KB)` : 'ログ空'
      };
    });
  }

  // ログ全消去
  public async eraseLogs(): Promise<void> {
    return this.exclusive(async () => {
      this.log('sys', 'ロガーのメモリ全消去を実行中... (記録量が多いと 1〜2 分かかることがあります)');
      // 本体の完了応答が届いた時点で終了する。記録量によって所要時間が変わるため、待ち時間には余裕を持たせる
      await this.sendExpectAck('PMTK182,6,1', '$PMTK001,182,6,', 3, ERASE_TIMEOUT_MS);
      this.log('sys', 'ロガーのメモリ全消去が完了しました。');
    });
  }

  // 現在設定の一括取得 (公式アプリの GetConfig と同じ問い合わせ順)
  private async readConfig(): Promise<DeviceConfig> {
    const f = DigSpiceDevice.field;

    const fwLine = await this.query('PMTK605', '$PMTK705,');
    const wpHex = f(await this.query('PMTK182,2,8', '$PMTK182,3,8,'), 3);
    const flashStatusHex = f(await this.query('PMTK182,2,10', '$PMTK182,3,10,'), 3);
    const logFormatMaskHex = f(await this.query('PMTK182,2,2', '$PMTK182,3,2,'), 3);
    const recordMode = f(await this.query('PMTK182,2,3', '$PMTK182,3,3,'), 3);
    const timeInterval = f(await this.query('PMTK182,2,4', '$PMTK182,3,4,'), 3);
    const distanceInterval = f(await this.query('PMTK182,2,5', '$PMTK182,3,5,'), 3);
    const speedInterval = f(await this.query('PMTK182,2,6', '$PMTK182,3,6,'), 3);
    const fixIntervalMs = parseInt(f(await this.query('PMTK400', '$PMTK500,'), 1), 10);
    const statusCode = f(await this.query('PTSI990,2,0', '$PTSI990,2,0,'), 3);
    const autoLogSpeedKmh = parseFloat(f(await this.query('PTSI777,1', '$PTSI777,0,'), 2));

    const wpAddr = parseInt(wpHex, 16);
    if (Number.isNaN(wpAddr) || !(fixIntervalMs > 0) || !Number.isFinite(autoLogSpeedKmh)) {
      throw new Error('本体から想定外の設定値を受信しました');
    }

    return {
      model: f(fwLine, 1),
      firmwareVersion: f(fwLine, 2),
      writePointerHex: wpHex,
      usedBytes: Math.max(0, wpAddr - 0x200),
      flashStatusHex,
      logFormatMaskHex,
      recordMode,
      timeInterval,
      distanceInterval,
      speedInterval,
      fixIntervalMs,
      samplingRateHz: Math.round(10000 / fixIntervalMs) / 10,
      statusCode,
      autoLogSpeedKmh
    };
  }

  public async getDeviceConfig(): Promise<DeviceConfig> {
    return this.exclusive(() => this.readConfig());
  }

  // サンプリングレート変更。送信順は公式アプリの SetRate キャプチャ (sample/wireshark/set_rate_*.pcapng) と同一で、
  // 記録マスク等の標準値の再書き込みと PTSI990,2,1,27 も公式アプリが送っているものをそのまま再現している。
  // 本体から読み戻した設定を返す。途中で失敗した場合は本体の状態が不明になるため、呼び出し側で再取得すること
  public async setSamplingRate(hz: SamplingRateHz): Promise<DeviceConfig> {
    const intervalMs = RATE_INTERVAL_MS[hz];
    if (!intervalMs) throw new Error(`サポートされていないレートです: ${hz} Hz`);

    return this.exclusive(async () => {
      this.log('sys', `サンプリングレートを ${hz} Hz (${intervalMs} ms 周期) に変更中...`);

      await this.query('PMTK605', '$PMTK705,');
      await this.query('PMTK182,2,8', '$PMTK182,3,8,');
      await this.query('PMTK182,2,10', '$PMTK182,3,10,');

      // 標準ログ記録マスク・パラメータの適用
      await this.sendExpectAck('PMTK182,1,2,0004103F', '$PMTK001,182,1,', 3);
      await this.sendExpectAck('PMTK182,1,3,1', '$PMTK001,182,1,', 3);
      await this.sendExpectAck('PMTK182,1,4,0', '$PMTK001,182,1,', 3);
      await this.sendExpectAck('PMTK182,1,5,0', '$PMTK001,182,1,', 3);
      await this.sendExpectAck('PMTK182,1,6,2', '$PMTK001,182,1,', 3);

      await this.sendExpectAck(`PMTK300,${intervalMs},0,0,0,0`, '$PMTK001,300,', 2);
      await this.query('PTSI990,2,1,27', '$PTSI990,2,0,');

      // 本体から読み戻した値で反映を検証する
      const config = await this.readConfig();
      if (config.fixIntervalMs !== intervalMs) {
        throw new Error(`設定が反映されませんでした: 設定値=${intervalMs} ms, 本体の現在値=${config.fixIntervalMs} ms`);
      }
      this.log('sys', `[成功] サンプリングレートが ${hz} Hz に変更されました。`);
      return config;
    });
  }

  // ログ記録開始/停止速度の変更。本体から読み戻した値 (km/h) を返す
  public async setAutoLogSpeed(speedKmh: number): Promise<number> {
    if (!Number.isInteger(speedKmh) || speedKmh < AUTO_LOG_SPEED_MIN || speedKmh > AUTO_LOG_SPEED_MAX) {
      throw new Error(`ログ記録開始速度は ${AUTO_LOG_SPEED_MIN}〜${AUTO_LOG_SPEED_MAX} km/h の整数で指定してください`);
    }
    const formatted = speedKmh.toFixed(2);

    return this.exclusive(async () => {
      this.log('sys', `ログ記録開始速度を ${formatted} km/h に設定中...`);
      await this.query('PMTK605', '$PMTK705,');
      await this.query(`PTSI777,2,${formatted}`, '$PTSI777,0,');

      const confirmed = parseFloat(DigSpiceDevice.field(await this.query('PTSI777,1', '$PTSI777,0,'), 2));
      if (!Number.isFinite(confirmed) || Math.abs(confirmed - speedKmh) > 0.005) {
        throw new Error(`設定が反映されませんでした: 設定値=${formatted} km/h, 本体の現在値=${confirmed} km/h`);
      }
      this.log('sys', `[成功] ログ記録開始速度が ${confirmed} km/h に設定されました。`);
      return confirmed;
    });
  }

  // ログダウンロード
  public async downloadLogs(onProgress?: (p: DownloadProgress) => void): Promise<{
    buffer: Uint8Array;
    fileName: string;
  }> {
    if (this.isBusy) throw new Error('他の操作が実行中です');
    this.isBusy = true;

    // 無通信の監視タイマー。成否にかかわらず finally で必ず止める
    let checkInterval: ReturnType<typeof setInterval> | null = null;

    try {
      // 1. 書き込みポインタ確認
      await this.query('PMTK605', '$PMTK705');
      const wpLine = await this.query('PMTK182,2,8', '$PMTK182,3,8,');
      const wpHex = DigSpiceDevice.field(wpLine, 3);
      const wpAddr = parseInt(wpHex, 16);
      if (Number.isNaN(wpAddr)) throw new Error(`本体から想定外の応答を受信しました: ${wpLine}`);

      // 要求サイズの計算: 0x1000 (セクタ境界) に切り上げ
      let reqSize = (wpAddr + 0x0FFF) & ~0x0FFF;
      if (reqSize < 0x1000) reqSize = 0x1000;
      const reqSizeHex = reqSize.toString(16).toUpperCase();
      const totalBlocks = Math.ceil(reqSize / DOWNLOAD_BLOCK_SIZE);

      this.log('sys', `ダウンロード開始: アドレス=0x${wpHex}, 要求サイズ=0x${reqSizeHex} (${totalBlocks} ブロック)`);

      // 受信したブロックは応答に書かれたアドレスの位置へ格納する (未受信の部分は消去状態の 0xFF)
      const image = new Uint8Array(reqSize).fill(0xff);
      const received = new Uint8Array(totalBlocks);
      let receivedBlocks = 0;
      let rejectedLines = 0;
      let lastActivityTime = Date.now();

      // 1 回の読み出し要求 (終端の応答まで) を待つ。欠けたブロックを読み直すときは、もう一度待つ
      let endRound: (() => void) | null = null;
      let failRound: ((err: Error) => void) | null = null;
      const waitRound = () => {
        const round = new Promise<void>((resolve, reject) => {
          endRound = resolve;
          failRound = reject;
        });
        lastActivityTime = Date.now();
        // 送信に失敗した場合でも、後から発火するタイムアウトが未処理の reject にならないようにする
        round.catch(() => {});
        return round;
      };
      const fail = (err: Error) => failRound?.(err);

      checkInterval = setInterval(() => {
        if (Date.now() - lastActivityTime > 8000) {
          fail(new Error(`受信タイムアウト: 8秒間データが途絶えました (${receivedBlocks}/${totalBlocks} ブロック受信済)`));
        }
      }, 1000);

      // 通信断・切断のときは無通信タイムアウトを待たずに中断する
      this.streamAbort = fail;

      {
        let lastUiUpdate = 0;

        this.streamingHandler = (line: string) => {
          if (!line.startsWith('$PMTK182,8,')) return;
          // 位置系 NMEA 等の無関係な行では無通信タイムアウトを延長しない
          lastActivityTime = Date.now();

          const parts = DigSpiceDevice.fields(line);
          const addr = parseInt(parts[2] ?? '', 16);
          const hexData = parts[3] ?? '';
          // 化けた行・書式の合わない行は採用しない (欠落として最後に検出される)
          if (!verifyNmeaChecksum(line) || Number.isNaN(addr) || hexData.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hexData)) {
            rejectedLines++;
            return;
          }

          if (addr === 0xfffff0) {
            // 終端の応答。ここまでに要求したブロックが届いているはず
            endRound?.();
            return;
          }

          const size = hexData.length / 2;
          const blockIndex = addr / DOWNLOAD_BLOCK_SIZE;
          // ブロック境界から始まり、1 ブロック分 (末尾だけは残り全部) そろっている応答だけを採用する
          const expectedSize = Math.min(DOWNLOAD_BLOCK_SIZE, reqSize - addr);
          if (!Number.isInteger(blockIndex) || addr >= reqSize || size !== expectedSize) {
            rejectedLines++;
            return;
          }
          const block = new Uint8Array(size);
          for (let j = 0; j < size; j++) {
            block[j] = parseInt(hexData.substring(j * 2, j * 2 + 2), 16);
          }
          if (received[blockIndex]) {
            // 同じ位置が再度届いた場合、内容が食い違えばどちらが正しいか判断できないため失敗にする
            for (let j = 0; j < size; j++) {
              if (image[addr + j] !== block[j]) {
                fail(new Error(`受信データが食い違っています (位置 0x${addr.toString(16).toUpperCase()})。もう一度ダウンロードしてください。`));
                return;
              }
            }
            return;
          }
          image.set(block, addr);
          received[blockIndex] = 1;
          receivedBlocks++;

          const now = Date.now();
          if (now - lastUiUpdate > 80 || receivedBlocks >= totalBlocks) {
            lastUiUpdate = now;
            const receivedBytes = Math.min(reqSize, receivedBlocks * DOWNLOAD_BLOCK_SIZE);
            if (onProgress) {
              onProgress({
                receivedBytes,
                totalBytes: reqSize,
                percent: Math.min(100, Math.round((receivedBlocks / totalBlocks) * 100)),
                receivedBlocks,
                totalBlocks,
                statusText: `データ受信中: ${receivedBlocks} / ${totalBlocks} ブロック (${Math.round(receivedBytes / 1024)} KB)`
              });
            }
          }
        };
      }

      // 一括ストリーミング読み出し要求
      const mainRound = waitRound();
      await this.sendCommand(`PMTK182,7,0,${reqSizeHex}`);
      await new Promise(r => setTimeout(r, 10));
      await this.sendCommand('PMTK182,7,FFFFF0,10');

      await mainRound;

      // 欠けたブロックだけを読み直す (無効の間は、欠けていればそのまま下でエラーにする)
      for (let attempt = 1; PARTIAL_REFETCH_ENABLED && attempt <= PARTIAL_REFETCH_ATTEMPTS && receivedBlocks < totalBlocks; attempt++) {
        const ranges = DigSpiceDevice.missingRanges(received);
        this.log('sys', `欠けたブロックを読み直します (${attempt} 回目): ${totalBlocks - receivedBlocks} ブロック、${ranges.length} 区間`);
        const round = waitRound();
        for (const [first, count] of ranges) {
          const addr = first * DOWNLOAD_BLOCK_SIZE;
          const size = Math.min(count * DOWNLOAD_BLOCK_SIZE, reqSize - addr);
          await this.sendCommand(`PMTK182,7,${addr.toString(16).toUpperCase()},${size.toString(16).toUpperCase()}`);
          await new Promise(r => setTimeout(r, 10));
        }
        await this.sendCommand('PMTK182,7,FFFFF0,10');
        await round;
      }

      // 欠けたブロックがあるデータを「吸い出し成功」として渡さない (消去前のバックアップに使われるため)
      if (receivedBlocks < totalBlocks) {
        const firstMissing = received.indexOf(0);
        throw new Error(
          `受信データに欠落があります: ${totalBlocks - receivedBlocks} / ${totalBlocks} ブロックが未受信 ` +
          `(最初の欠落位置 0x${(firstMissing * DOWNLOAD_BLOCK_SIZE).toString(16).toUpperCase()}` +
          `${rejectedLines > 0 ? `、破損した行 ${rejectedLines} 件` : ''})。もう一度ダウンロードしてください。`
        );
      }

      DigSpiceDevice.applyOfficialMetadata(image);

      const fileName = DigSpiceDevice.generateDefaultFileName();
      this.log('sys', `ダウンロード完了: ${image.length} バイト (${fileName})`);

      return {
        buffer: image,
        fileName
      };
    } finally {
      if (checkInterval) clearInterval(checkInterval);
      this.isBusy = false;
      this.streamingHandler = null;
      this.streamAbort = null;
    }
  }

  // 受信していないブロックの区間 ([先頭のブロック番号, ブロック数] の並び)
  public static missingRanges(received: Uint8Array): [number, number][] {
    const ranges: [number, number][] = [];
    for (let i = 0; i < received.length; i++) {
      if (received[i]) continue;
      const last = ranges[ranges.length - 1];
      if (last && last[0] + last[1] === i) last[1]++;
      else ranges.push([i, 1]);
    }
    return ranges;
  }

  // 公式後処理メタデータ (0x0100..0x0109: Delphi 80-bit Extended 浮動小数点数) の適用
  public static applyOfficialMetadata(buffer: Uint8Array): void {
    if (buffer.length < 0x200) return;

    const numSectors = Math.floor(buffer.length / 0x1000);
    let recordCount = 0;
    let firstLat: number | null = null;
    let firstLon: number | null = null;

    for (let s = 0; s < numSectors; s++) {
      const secOffset = s * 0x1000;
      let esi = 0x200;
      const recSize = 36;

      while (esi < 0x1000) {
        const pos = secOffset + esi;
        if (pos + 16 <= buffer.length) {
          let isTag = true;
          for (let i = 0; i < 7; i++) {
            if (buffer[pos + i] !== 0xaa) { isTag = false; break; }
          }
          if (isTag) {
            for (let i = 0; i < 4; i++) {
              if (buffer[pos + 12 + i] !== 0xbb) { isTag = false; break; }
            }
          }
          if (isTag) {
            esi += 0x10;
            continue;
          }
        }

        let isFF = true;
        for (let i = 0; i < 6; i++) {
          if (buffer[pos + i] !== 0xff) { isFF = false; break; }
        }
        if (isFF) {
          esi += recSize;
          continue;
        }

        if (esi + recSize > 0x1000) break;

        // レコード末尾のチェックサム ('*' + 先頭 34 バイトの XOR) が合わないもの (破損) は数えない
        let x = 0;
        for (let i = 0; i < 34; i++) x ^= buffer[pos + i];
        if (buffer[pos + 34] !== 0x2a || buffer[pos + 35] !== x) {
          esi += recSize;
          continue;
        }

        const view = new DataView(buffer.buffer, buffer.byteOffset + pos, recSize);
        const fixMode = view.getUint16(4, true);
        const lat = view.getFloat64(6, true);
        const lon = view.getFloat64(14, true);
        const spd = view.getFloat32(26, true);

        if (fixMode === 3 && spd > 0.0 && lat >= -90.0 && lat <= 90.0 && lon >= -180.0 && lon <= 180.0 && lat !== 0.0) {
          if (firstLat === null) {
            firstLat = lat;
            firstLon = lon;
          }
          recordCount++;
        }

        esi += recSize;
      }
    }

    if (recordCount === 0 || firstLat === null || firstLon === null) return;

    // 80-bit 拡張倍精度浮動小数点数の演算の再現
    const PI_MANTISSA = 0xc90fdaa22168c235n;
    const SCALE = 64n;

    function doubleToFixed(d: number): bigint {
      if (d === 0) return 0n;
      const b = new ArrayBuffer(8);
      const v = new DataView(b);
      v.setFloat64(0, d, true);
      const u = v.getBigUint64(0, true);
      const sign = u >> 63n;
      const exp = Number((u >> 52n) & 0x7ffn) - 1023;
      const mant = (u & 0xfffffffffffffn) | 0x10000000000000n;
      const shift = BigInt(exp + 12);
      const val = shift >= 0n ? (mant << shift) : (mant >> -shift);
      return sign ? -val : val;
    }

    function fixedSqrt(valFixed: bigint): bigint {
      let n = valFixed << SCALE;
      if (n <= 0n) return 0n;
      let x0 = n / 2n;
      if (x0 === 0n) return 1n;
      let x1 = (x0 + n / x0) / 2n;
      while (x1 < x0) {
        x0 = x1;
        x1 = (x0 + n / x0) / 2n;
      }
      return x0;
    }

    const sqrtN = fixedSqrt(BigInt(recordCount) << SCALE);
    const piFixed = PI_MANTISSA * 4n;
    const latFixed = doubleToFixed(firstLat);
    const lonFixed = doubleToFixed(firstLon);
    const term1 = (piFixed * latFixed) >> SCALE;
    const term2 = (lonFixed << SCALE) / piFixed;
    const resFixed = sqrtN + term1 + term2;

    // 南半球・西経では結果が負になり得るので、絶対値を符号と分けて Extended に詰める
    const negative = resFixed < 0n;
    const absFixed = negative ? -resFixed : resFixed;
    if (absFixed === 0n) {
      buffer.fill(0, 0x100, 0x10a);
      return;
    }
    let tmp = absFixed;
    let bitLen = 0;
    while (tmp > 0n) { bitLen++; tmp >>= 1n; }

    const exp = bitLen - 65;
    const biasedExp = exp + 16383;
    const shift = BigInt(bitLen - 64);
    const roundBit = shift > 0n ? (1n << (shift - 1n)) : 0n;
    let mantissa64 = shift >= 0n ? ((absFixed + roundBit) >> shift) : (absFixed << -shift);
    let expWord = biasedExp;
    // 丸めで 64 ビットを超えたら、指数を 1 つ上げる
    if (mantissa64 >> 64n) {
      mantissa64 >>= 1n;
      expWord++;
    }

    for (let i = 0; i < 8; i++) {
      buffer[0x100 + i] = Number((mantissa64 >> BigInt(i * 8)) & 0xffn);
    }
    if (negative) expWord |= 0x8000;
    buffer[0x108] = expWord & 0xff;
    buffer[0x109] = (expWord >> 8) & 0xff;
  }

  // ファイル名自動生成 (DS4_YYYYMMDDHHMM.bnx4)
  public static generateDefaultFileName(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `DS4_${yyyy}${MM}${dd}${HH}${mm}.bnx4`;
  }
}
