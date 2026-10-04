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

export class DigSpiceDevice {
  private port: any = null;
  private reader: any = null;
  private readBuffer: string = '';
  private pendingLineResolvers: Array<(line: string) => void> = [];
  private streamingHandler: ((line: string) => void) | null = null;
  private isBusy: boolean = false;
  private keepReading: boolean = false;
  private readLoopPromise: Promise<void> | null = null;

  public onLogMessage?: (type: 'tx' | 'rx' | 'sys' | 'err', msg: string) => void;

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
  public async connect(): Promise<boolean> {
    const nav = navigator as any;
    if (!nav.serial) {
      throw new Error('お使いのブラウザ・環境では Web Serial API がサポートされていません。');
    }

    this.log('sys', 'デジスパイスIV（VID: 0x2DCF, PID: 0x6002）を検出中...');

    this.port = await nav.serial.requestPort({
      filters: [{ usbVendorId: 0x2dcf, usbProductId: 0x6002 }]
    });

    await this.port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      bufferSize: 8192,
      flowControl: 'none'
    });

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

      const resolver = (line: string) => {
        if (line.startsWith(prefix)) {
          if (timer) clearTimeout(timer);
          const idx = this.pendingLineResolvers.indexOf(resolver);
          if (idx >= 0) this.pendingLineResolvers.splice(idx, 1);
          resolve(line);
        }
      };

      this.pendingLineResolvers.push(resolver);

      timer = setTimeout(() => {
        const idx = this.pendingLineResolvers.indexOf(resolver);
        if (idx >= 0) this.pendingLineResolvers.splice(idx, 1);
        reject(new Error(`レスポンス待機タイムアウト: ${prefix} (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  private async startReadLoop(): Promise<void> {
    const decoder = new TextDecoder();
    while (this.port && this.port.readable && this.keepReading) {
      try {
        this.reader = this.port.readable.getReader();
        while (this.keepReading) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            this.readBuffer += chunk;

            let newlineIdx;
            while ((newlineIdx = this.readBuffer.indexOf('\n')) >= 0) {
              const line = this.readBuffer.substring(0, newlineIdx).replace(/\r$/, '');
              this.readBuffer = this.readBuffer.substring(newlineIdx + 1);

              if (line.trim().length > 0) {
                if (this.streamingHandler) {
                  this.streamingHandler(line);
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
        break;
      } finally {
        if (this.reader) {
          try { this.reader.releaseLock(); } catch {}
          this.reader = null;
        }
      }
    }
  }

  // ログ容量情報取得
  public async getLogInfo(): Promise<LogInfo> {
    await this.sendCommand('PMTK605');
    await this.waitForLine('$PMTK705');

    await this.sendCommand('PMTK182,2,8');
    const wpLine = await this.waitForLine('$PMTK182,3,8');
    const wpHex = wpLine.split('*')[0].split(',')[3];
    const wpAddr = parseInt(wpHex, 16);
    const usedBytes = Math.max(0, wpAddr - 0x200);

    return {
      logCapacityBytes: 0x400000, // 4MB flash (DigSpice IV 標準)
      usedBytes,
      writePointerHex: wpHex,
      status: usedBytes > 0 ? `記録あり (${Math.round(usedBytes / 1024)} KB)` : 'ログ空'
    };
  }

  // ログ全消去
  public async eraseLogs(): Promise<void> {
    this.log('sys', 'ロガーのメモリ全消去を実行中...');
    await this.sendCommand('PMTK182,6,1');
    await this.waitForLine('$PMTK001,182,6', 15000); // 消去は最大15秒
    this.log('sys', 'ロガーのメモリ全消去が完了しました。');
  }

  // ログダウンロード
  public async downloadLogs(onProgress?: (p: DownloadProgress) => void): Promise<{
    buffer: Uint8Array;
    fileName: string;
  }> {
    if (this.isBusy) throw new Error('他の操作が実行中です');
    this.isBusy = true;

    const collectedBytes: number[] = [];

    try {
      // 1. 書き込みポインタ確認
      await this.sendCommand('PMTK605');
      await this.waitForLine('$PMTK705');

      await this.sendCommand('PMTK182,2,8');
      const wpLine = await this.waitForLine('$PMTK182,3,8');
      const wpHex = wpLine.split('*')[0].split(',')[3];
      const wpAddr = parseInt(wpHex, 16);

      // 要求サイズの計算: 0x1000 (セクタ境界) に切り上げ
      let reqSize = (wpAddr + 0x0FFF) & ~0x0FFF;
      if (reqSize < 0x1000) reqSize = 0x1000;
      const reqSizeHex = reqSize.toString(16).toUpperCase();
      const totalBlocks = Math.ceil(reqSize / 0x800);

      this.log('sys', `ダウンロード開始: アドレス=0x${wpHex}, 要求サイズ=0x${reqSizeHex} (${totalBlocks} ブロック)`);

      let lastActivityTime = Date.now();
      let receivedBlocks = 0;

      const streamPromise = new Promise<void>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (Date.now() - lastActivityTime > 8000) {
            clearInterval(checkInterval);
            this.streamingHandler = null;
            reject(new Error(`受信タイムアウト: 8秒間データが途絶えました (${receivedBlocks}/${totalBlocks} ブロック受信済)`));
          }
        }, 1000);

        let lastUiUpdate = 0;

        this.streamingHandler = (line: string) => {
          lastActivityTime = Date.now();

          if (line.startsWith('$PMTK182,8,')) {
            const parts = line.split('*')[0].split(',');
            if (parts.length >= 4) {
              const addrHex = parts[2];
              const hexData = parts[3];

              if (addrHex === '00FFFFF0') {
                clearInterval(checkInterval);
                this.streamingHandler = null;
                resolve();
                return;
              }

              for (let j = 0; j < hexData.length; j += 2) {
                collectedBytes.push(parseInt(hexData.substring(j, j + 2), 16));
              }
              receivedBlocks++;

              const now = Date.now();
              if (now - lastUiUpdate > 80 || receivedBlocks >= totalBlocks) {
                lastUiUpdate = now;
                const pct = Math.min(100, Math.round((receivedBlocks / totalBlocks) * 100));
                if (onProgress) {
                  onProgress({
                    receivedBytes: collectedBytes.length,
                    totalBytes: reqSize,
                    percent: pct,
                    receivedBlocks,
                    totalBlocks,
                    statusText: `データ受信中: ${receivedBlocks} / ${totalBlocks} ブロック (${Math.round(collectedBytes.length / 1024)} KB)`
                  });
                }
              }
            }
          }
        };
      });

      // 一括ストリーミング読み出し要求
      await this.sendCommand(`PMTK182,7,0,${reqSizeHex}`);
      await new Promise(r => setTimeout(r, 10));
      await this.sendCommand('PMTK182,7,FFFFF0,10');

      await streamPromise;

      const uint8Array = new Uint8Array(collectedBytes);
      DigSpiceDevice.applyOfficialMetadata(uint8Array);

      const fileName = DigSpiceDevice.generateDefaultFileName();
      this.log('sys', `ダウンロード完了: ${collectedBytes.length} バイト (${fileName})`);

      return {
        buffer: uint8Array,
        fileName
      };
    } finally {
      this.isBusy = false;
      this.streamingHandler = null;
    }
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

    // Delphi x87 FPU 80-bit 拡張倍精度浮動小数点数のエミュレーション
    const PI_MANTISSA = 0xc90fdaa22168c235n;
    const SCALE = 64n;

    function doubleToFixed(d: number): bigint {
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

    let tmp = resFixed;
    let bitLen = 0;
    while (tmp > 0n) { bitLen++; tmp >>= 1n; }

    const exp = bitLen - 65;
    const biasedExp = exp + 16383;
    const shift = BigInt(bitLen - 64);
    const roundBit = shift > 0n ? (1n << (shift - 1n)) : 0n;
    const mantissa64 = ((resFixed + roundBit) >> shift);

    for (let i = 0; i < 8; i++) {
      buffer[0x100 + i] = Number((mantissa64 >> BigInt(i * 8)) & 0xffn);
    }
    const expWord = biasedExp;
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
