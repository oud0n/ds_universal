// ==============================================================================
// デジスパイスIV Web Serial 通信・プロトコル制御ロジック (renderer.js)
// ==============================================================================

// 通信ステート変数
let serialPort = null;
let reader = null;
let writer = null;
let isBusy = false;
let readBuffer = '';

// DOM 要素
const btnConnect = document.getElementById('btnConnect');
const btnDisconnect = document.getElementById('btnDisconnect');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const btnRefreshConfig = document.getElementById('btnRefreshConfig');
const terminalBody = document.getElementById('terminalBody');
const btnClearLog = document.getElementById('btnClearLog');
const chkAutoScroll = document.getElementById('chkAutoScroll');

// 情報表示要素
const valFwVersion = document.getElementById('valFwVersion');
const valLogRate = document.getElementById('valLogRate');
const valStartSpeed = document.getElementById('valStartSpeed');
const valDeviceStatus = document.getElementById('valDeviceStatus');
const valWritePointer = document.getElementById('valWritePointer');

// 操作要素
const btnRates = document.querySelectorAll('.btn-rate');
const btnPresetSpeeds = document.querySelectorAll('.btn-preset-speed');
const inputCustomSpeed = document.getElementById('inputCustomSpeed');
const btnApplySpeed = document.getElementById('btnApplySpeed');
const btnDownload = document.getElementById('btnDownload');
const downloadProgressContainer = document.getElementById('downloadProgressContainer');
const downloadProgressBar = document.getElementById('downloadProgressBar');
const downloadStatusText = document.getElementById('downloadStatusText');
const downloadPercentText = document.getElementById('downloadPercentText');
const chkConfirmErase = document.getElementById('chkConfirmErase');
const btnErase = document.getElementById('btnErase');

// ==============================================================================
// ターミナルログ表示
// ==============================================================================

function getTimestamp() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function appendLog(dir, text) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = `[${getTimestamp()}]`;

  const dirSpan = document.createElement('span');
  dirSpan.className = `log-dir ${dir.toLowerCase()}`;
  dirSpan.textContent = dir.toUpperCase();

  const textSpan = document.createElement('span');
  textSpan.className = 'log-text';
  textSpan.textContent = text;

  entry.appendChild(timeSpan);
  entry.appendChild(dirSpan);
  entry.appendChild(textSpan);

  terminalBody.appendChild(entry);

  if (chkAutoScroll.checked) {
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }
}

btnClearLog.addEventListener('click', () => {
  terminalBody.innerHTML = '';
});

// ==============================================================================
// NMEA プロトコル計算ヘルパー
// ==============================================================================

// NMEA XORチェックサム計算 ($ と * の間のバイトを排他的論理和)
function calculateChecksum(sentenceBody) {
  let clean = sentenceBody.trim();
  if (clean.StartsWith && clean.startsWith('$')) clean = clean.substring(1);
  if (clean.charAt(0) === '$') clean = clean.substring(1);
  const starIdx = clean.indexOf('*');
  if (starIdx >= 0) clean = clean.substring(0, starIdx);

  let cs = 0;
  for (let i = 0; i < clean.length; i++) {
    cs ^= clean.charCodeAt(i);
  }
  return cs.toString(16).toUpperCase().padStart(2, '0');
}

// NMEA コマンド文字列の構築 ($<Body>*<CS>\r\n)
function formatCommand(sentenceBody) {
  let clean = sentenceBody.trim();
  if (clean.charAt(0) === '$') clean = clean.substring(1);
  const starIdx = clean.indexOf('*');
  if (starIdx >= 0) clean = clean.substring(0, starIdx);

  const cs = calculateChecksum(clean);
  return `$${clean}*${cs}\r\n`;
}

// ==============================================================================
// Web Serial API によるシリアル通信管理
// ==============================================================================

// シリアルポート接続
async function connectSerial() {
  if (!navigator.serial) {
    alert('お使いの環境では Web Serial API がサポートされていません。');
    return;
  }

  try {
    statusBadge.className = 'status-badge connecting';
    statusText.textContent = '接続中 (Connecting...)';
    appendLog('sys', 'デジスパイスIV（VID: 0x2DCF, PID: 0x6002）を検出中...');

    // デジスパイスIVの VID: 0x2DCF, PID: 0x6002 でポートを要求
    serialPort = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x2dcf, usbProductId: 0x6002 }],
    });

    appendLog('sys', 'ポート選択完了。115200 bps 8N1 でオープンします...');
    await serialPort.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      bufferSize: 8192,
      flowControl: 'none',
    });

    // DTR/RTS 信号の設定
    try {
      await serialPort.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (e) {
      console.warn('DTR/RTS 信号設定スキップ:', e);
    }

    statusBadge.className = 'status-badge connected';
    statusText.textContent = '接続中 (Connected)';
    btnConnect.style.display = 'none';
    btnDisconnect.style.display = 'inline-flex';
    enableControls(true);

    appendLog('sys', 'デジスパイスIV との通信接続に成功しました。');

    // バックグラウンド受信ループ開始
    readLoop();

    // 接続時に自動で現在設定を取得
    await queryConfiguration();
  } catch (err) {
    console.error('シリアル接続エラー:', err);
    statusBadge.className = 'status-badge disconnected';
    statusText.textContent = '接続失敗 (Failed)';
    appendLog('err', `接続エラー: ${err.message}`);
    disconnectSerial();
  }
}

// シリアルポート切断
async function disconnectSerial() {
  enableControls(false);
  streamingLineHandler = null;
  isBusy = false;
  if (reader) {
    try {
      await reader.cancel();
      reader.releaseLock();
    } catch (e) {
      console.warn(e);
    }
    reader = null;
  }
  if (writer) {
    try {
      writer.releaseLock();
    } catch (e) {
      console.warn(e);
    }
    writer = null;
  }
  if (serialPort) {
    try {
      await serialPort.close();
    } catch (e) {
      console.warn(e);
    }
    serialPort = null;
  }

  statusBadge.className = 'status-badge disconnected';
  statusText.textContent = '未接続 (Disconnected)';
  btnConnect.style.display = 'inline-flex';
  btnDisconnect.style.display = 'none';
  appendLog('sys', 'シリアルポートを切断しました。');
}

// コマンド送信
async function sendLine(nmeaBody) {
  if (!serialPort || !serialPort.writable) throw new Error('シリアルポートが開いていません');

  const fullCmd = formatCommand(nmeaBody);
  appendLog('tx', fullCmd.trim());

  const encoder = new TextEncoder();
  const data = encoder.encode(fullCmd);

  const writer = serialPort.writable.getWriter();
  try {
    await writer.write(data);
  } finally {
    writer.releaseLock();
  }
}

// 行バッファリング付き受信ループ
let pendingLineResolvers = [];
let streamingLineHandler = null;

async function readLoop() {
  const decoder = new TextDecoder();
  while (serialPort && serialPort.readable) {
    try {
      reader = serialPort.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          readBuffer += chunk;

          let newlineIdx;
          while ((newlineIdx = readBuffer.indexOf('\n')) >= 0) {
            const line = readBuffer.substring(0, newlineIdx).replace(/\r$/, '');
            readBuffer = readBuffer.substring(newlineIdx + 1);

            if (line.trim().length > 0) {
              handleIncomingLine(line.trim());
            }
          }
        }
      }
    } catch (err) {
      console.warn('受信ループエラー:', err);
      break;
    } finally {
      if (reader) {
        reader.releaseLock();
        reader = null;
      }
    }
  }
}

function handleIncomingLine(line) {
  // 高速ストリーミング受信時はDOM描画や通常キューをバイパス
  if (streamingLineHandler) {
    streamingLineHandler(line);
    return;
  }

  appendLog('rx', line);

  // 待機中のレスポンス解決関数に渡す
  if (pendingLineResolvers.length > 0) {
    const resolver = pendingLineResolvers.shift();
    resolver(line);
  }
}

// 特定のプレフィックスを持つ行が返るまで待機
function waitForLine(prefix, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = pendingLineResolvers.indexOf(listener);
      if (idx >= 0) pendingLineResolvers.splice(idx, 1);
      reject(new Error(`応答タイムアウト: "${prefix}" で始まる行を受信できませんでした`));
    }, timeoutMs);

    const listener = (line) => {
      if (!prefix || line.startsWith(prefix)) {
        clearTimeout(timeout);
        resolve(line);
      } else {
        pendingLineResolvers.unshift(listener);
      }
    };

    pendingLineResolvers.push(listener);
  });
}

// ==============================================================================
// デジスパイスIV プロトコル操作関数
// ==============================================================================

// 現在設定の一括取得 (GetConfig)
async function queryConfiguration() {
  if (isBusy) return;
  isBusy = true;
  appendLog('sys', 'デバイス設定情報を取得中...');

  try {
    // 1. FWバージョン確認 ($PMTK605 -> $PMTK705)
    await sendLine('PMTK605');
    const fwLine = await waitForLine('$PMTK705');
    const fwParts = fwLine.split('*')[0].split(',');
    valFwVersion.textContent = `${fwParts[1]} v${fwParts[2]}`;

    // 2. 次回書き込みポインタ確認 ($PMTK182,2,8 -> $PMTK182,3,8)
    await sendLine('PMTK182,2,8');
    const wpLine = await waitForLine('$PMTK182,3,8');
    const wpHex = wpLine.split('*')[0].split(',')[3];
    const wpDec = parseInt(wpHex, 16);
    const logBytes = Math.max(0, wpDec - 0x200);
    valWritePointer.textContent = `0x${wpHex} (${logBytes} バイト保存済)`;

    // 3. フラッシュ状態確認 ($PMTK182,2,10)
    await sendLine('PMTK182,2,10');
    await waitForLine('$PMTK182,3,10');

    // 4. 測位レート確認 ($PMTK400 -> $PMTK500)
    await sendLine('PMTK400');
    const rateLine = await waitForLine('$PMTK500');
    const intervalMs = parseInt(rateLine.split('*')[0].split(',')[1], 10);
    const hz = intervalMs > 0 ? Math.round(1000 / intervalMs) : 0;
    valLogRate.textContent = `${hz} Hz (${intervalMs} ms)`;

    // アクティブなレートボタンをハイライト
    btnRates.forEach(btn => {
      if (parseInt(btn.dataset.rate, 10) === hz) {
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
      } else {
        btn.classList.add('btn-secondary');
        btn.classList.remove('btn-primary');
      }
    });

    // 5. バッテリー・内部ステータス ($PTSI990,2,0)
    await sendLine('PTSI990,2,0');
    const battLine = await waitForLine('$PTSI990,2,0');
    const battCode = battLine.split('*')[0].split(',')[3];
    valDeviceStatus.textContent = `Code ${battCode}`;

    // 6. 記録開始/停止速度閾値 ($PTSI777,1 -> $PTSI777,0)
    await sendLine('PTSI777,1');
    const speedLine = await waitForLine('$PTSI777,0');
    const speedVal = speedLine.split('*')[0].split(',')[2];
    valStartSpeed.textContent = `${speedVal} km/h`;
    inputCustomSpeed.value = parseFloat(speedVal);

    appendLog('sys', '設定情報を正常に取得しました。');
  } catch (err) {
    appendLog('err', `設定取得エラー: ${err.message}`);
  } finally {
    isBusy = false;
  }
}

// 記録レート変更 (SetRate)
async function setLogRate(hz) {
  if (isBusy) return;
  isBusy = true;

  const intervalMap = { 20: 50, 10: 100, 5: 200 };
  const interval = intervalMap[hz];
  if (!interval) return;

  appendLog('sys', `記録レートを ${hz} Hz (${interval}ms周期) に変更中...`);

  try {
    await sendLine('PMTK605');
    await waitForLine('$PMTK705');

    await sendLine('PMTK182,2,8');
    await waitForLine('$PMTK182,3,8');

    await sendLine('PMTK182,2,10');
    await waitForLine('$PMTK182,3,10');

    // 標準ログ記録マスク・パラメータの適用
    await sendLine('PMTK182,1,2,0004103F');
    await waitForLine('$PMTK001,182,1,3');

    await sendLine('PMTK182,1,3,1');
    await waitForLine('$PMTK001,182,1,3');

    await sendLine('PMTK182,1,4,0');
    await waitForLine('$PMTK001,182,1,3');

    await sendLine('PMTK182,1,5,0');
    await waitForLine('$PMTK001,182,1,3');

    await sendLine('PMTK182,1,6,2');
    await waitForLine('$PMTK001,182,1,3');

    // PMTK300 による測位周期設定
    await sendLine(`PMTK300,${interval},0,0,0,0`);
    await waitForLine('$PMTK001,300');

    await sendLine('PTSI990,2,1,27');
    await waitForLine('$PTSI990,2,0');

    // 設定反映の検証
    await sendLine('PMTK400');
    const verifyLine = await waitForLine('$PMTK500');
    const verifiedMs = parseInt(verifyLine.split('*')[0].split(',')[1], 10);

    if (verifiedMs === interval) {
      appendLog('sys', `[成功] 記録レートが ${hz} Hz に変更されました。`);
      valLogRate.textContent = `${hz} Hz (${verifiedMs} ms)`;
      btnRates.forEach(b => {
        if (parseInt(b.dataset.rate, 10) === hz) {
          b.classList.add('btn-primary');
          b.classList.remove('btn-secondary');
        } else {
          b.classList.add('btn-secondary');
          b.classList.remove('btn-primary');
        }
      });
    } else {
      appendLog('err', `設定不一致: 設定値=${interval}ms, 取得値=${verifiedMs}ms`);
    }
  } catch (err) {
    appendLog('err', `レート変更失敗: ${err.message}`);
  } finally {
    isBusy = false;
  }
}

// 記録開始/停止速度閾値の変更 (SetSpeed)
async function setSpeedThreshold(speedKmh) {
  if (isBusy) return;
  isBusy = true;

  const formatted = Number(speedKmh).toFixed(2);
  appendLog('sys', `記録開始/停止速度閾値を ${formatted} km/h に設定中...`);

  try {
    await sendLine('PMTK605');
    await waitForLine('$PMTK705');

    await sendLine(`PTSI777,2,${formatted}`);
    await waitForLine('$PTSI777,0');

    // 設定反映の検証
    await sendLine('PTSI777,1');
    const verifyLine = await waitForLine('$PTSI777,0');
    const confirmedSpeed = verifyLine.split('*')[0].split(',')[2];

    appendLog('sys', `[成功] 速度閾値が ${confirmedSpeed} km/h に設定されました。`);
    valStartSpeed.textContent = `${confirmedSpeed} km/h`;
  } catch (err) {
    appendLog('err', `速度設定失敗: ${err.message}`);
  } finally {
    isBusy = false;
  }
}

// 本体メモリ消去 (Erase)
async function eraseFlash() {
  if (!chkConfirmErase.checked) {
    alert('消去を実行するには「ログ消去を許可する」チェックボックスをオンにしてください。');
    return;
  }

  if (!confirm('【警告】デジスパイスIV 本体の全走行ログを完全に消去します。本当によろしいですか？')) {
    return;
  }

  if (isBusy) return;
  isBusy = true;
  appendLog('sys', 'フラッシュメモリ消去コマンド ($PMTK182,6,1) 送信中...');

  try {
    await sendLine('PMTK605');
    await waitForLine('$PMTK705');

    await sendLine('PMTK182,6,1');
    await waitForLine('$PMTK001,182,6,3', 10000);

    appendLog('sys', '[成功] デバイスから消去完了応答を受信しました。');

    // 消去後にポインタが 0x00000200 に初期化されたか確認
    await new Promise(r => setTimeout(r, 500));
    await sendLine('PMTK182,2,8');
    const postWp = await waitForLine('$PMTK182,3,8');
    const postHex = postWp.split('*')[0].split(',')[3];

    valWritePointer.textContent = `0x${postHex} (0 バイト保存済)`;
    chkConfirmErase.checked = false;
    btnErase.disabled = true;

    if (postHex === '00000200') {
      appendLog('sys', 'メモリ初期化完了（書き込みポインタ: 0x00000200）。');
      alert('ログの全消去が完了しました。');
    }
  } catch (err) {
    appendLog('err', `ログ消去エラー: ${err.message}`);
  } finally {
    isBusy = false;
  }
}

// ログデータのダウンロード (Download)
async function downloadLogs() {
  if (isBusy) return;
  isBusy = true;
  enableControls(false);

  downloadProgressContainer.classList.add('active');
  downloadProgressBar.style.width = '0%';
  downloadPercentText.textContent = '0%';
  downloadStatusText.textContent = '書き込みポインタ確認中...';

  const collectedBytes = [];

  try {
    // 1. バージョンと書き込みポインタ確認
    await sendLine('PMTK605');
    await waitForLine('$PMTK705');

    await sendLine('PMTK182,2,8');
    const wpLine = await waitForLine('$PMTK182,3,8');
    const wpHex = wpLine.split('*')[0].split(',')[3];
    const wpAddr = parseInt(wpHex, 16);
    const logBytes = Math.max(0, wpAddr - 0x200);

    // 2. フラッシュステータス確認
    await sendLine('PMTK182,2,10');
    await waitForLine('$PMTK182,3,10');

    // 要求サイズの計算: 0x1000 (セクタ境界) に切り上げ、最低 0x1000
    let reqSize = (wpAddr + 0x0FFF) & ~0x0FFF;
    if (reqSize < 0x1000) reqSize = 0x1000;
    const reqSizeHex = reqSize.toString(16).toUpperCase();
    const totalBlocks = Math.ceil(reqSize / 0x800);

    appendLog('sys', `ダウンロード開始: アドレス=0x${wpHex}, ログ容量=${logBytes} バイト, 要求サイズ=0x${reqSizeHex} (${totalBlocks} ブロック)`);
    downloadStatusText.textContent = `ストリーミング受信中 (0 / ${totalBlocks} ブロック)...`;

    // 3. 高速ストリーミング受信用 Promise の準備
    let lastActivityTime = Date.now();
    let receivedBlocks = 0;

    const streamPromise = new Promise((resolve, reject) => {
      // 8秒間データが途絶えたらタイムアウト
      const checkInterval = setInterval(() => {
        if (Date.now() - lastActivityTime > 8000) {
          clearInterval(checkInterval);
          streamingLineHandler = null;
          reject(new Error(`受信タイムアウト: 8秒間データが途絶えました (${receivedBlocks}/${totalBlocks} ブロック受信済)`));
        }
      }, 1000);

      let lastUiUpdate = 0;

      streamingLineHandler = (line) => {
        lastActivityTime = Date.now();

        if (line.startsWith('$PMTK182,8,')) {
          const parts = line.split('*')[0].split(',');
          if (parts.length >= 4) {
            const addrHex = parts[2];
            const hexData = parts[3];

            if (addrHex === '00FFFFF0') {
              clearInterval(checkInterval);
              streamingLineHandler = null;
              resolve();
              return;
            }

            // バイナリデータの蓄積
            for (let j = 0; j < hexData.length; j += 2) {
              collectedBytes.push(parseInt(hexData.substring(j, j + 2), 16));
            }
            receivedBlocks++;

            // UI更新のスロットル (100msごと、または最終ブロック)
            const now = Date.now();
            if (now - lastUiUpdate > 100 || receivedBlocks >= totalBlocks) {
              lastUiUpdate = now;
              const pct = Math.min(100, Math.round((receivedBlocks / totalBlocks) * 100));
              downloadProgressBar.style.width = `${pct}%`;
              downloadPercentText.textContent = `${pct}%`;
              downloadStatusText.textContent = `データ受信中: ${receivedBlocks} / ${totalBlocks} ブロック (${Math.round(collectedBytes.length / 1024)} KB)`;
            }
          }
        }
      };
    });

    // 4. 一括ストリーミング読み出し要求の送信
    await sendLine(`PMTK182,7,0,${reqSizeHex}`);

    // 5. 10ms後にフラッシュ末尾情報要求をパイプライン送信
    await new Promise(r => setTimeout(r, 10));
    await sendLine('PMTK182,7,FFFFF0,10');

    // 6. 全ブロックおよび末尾情報の受信完了待機
    await streamPromise;

    downloadProgressBar.style.width = '100%';
    downloadPercentText.textContent = '100%';
    downloadStatusText.textContent = 'ファイル保存中...';

    appendLog('sys', `ダウンロード完了 (${collectedBytes.length} バイト)。ファイルに保存します...`);

    // ファイル保存の実行
    const uint8Array = new Uint8Array(collectedBytes);
    applyDigSpiceMetadata(uint8Array);
    const defaultFileName = generateDefaultFileName(uint8Array);
    await saveFile(uint8Array, defaultFileName);

    downloadStatusText.textContent = `完了 (${collectedBytes.length} バイト保存済)`;
    alert(`ダウンロードが完了しました (${collectedBytes.length} バイト)。\n保存先: ${defaultFileName}`);
  } catch (err) {
    appendLog('err', `ダウンロードエラー: ${err.message}`);
    downloadStatusText.textContent = 'エラー発生';
  } finally {
    streamingLineHandler = null;
    isBusy = false;
    enableControls(serialPort !== null);
  }
}

// 公式分析ソフト (DigSpice.exe) 互換メタデータの計算・付加 (0x00000100〜0x00000109)
// DigSpice.exe の検証式: meta = Sqrt(RecordCount) + (PI * lat0) + (lon0 / PI)
// 80-bit IEEE 754 拡張倍精度浮動小数点数 (Delphi Extended 型, リトルエンディアン)
function applyDigSpiceMetadata(buffer) {
  if (!buffer || buffer.length < 0x1000) return;

  const numSectors = Math.floor(buffer.length / 0x1000);
  let recordCount = 0;
  let firstLat = null;
  let firstLon = null;

  for (let s = 0; s < numSectors; s++) {
    const secOffset = s * 0x1000;
    let esi = 0x200;
    const recSize = 36;

    while (esi < 0x1000) {
      const pos = secOffset + esi;
      if (pos + 16 <= buffer.length) {
        // プリアンブルタグのスキップ (7バイトの0xAA + 4バイトの0xBB)
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

      // 0xFF（未記録レコード領域）のスキップ
      let isFF = true;
      for (let i = 0; i < 6; i++) {
        if (buffer[pos + i] !== 0xff) { isFF = false; break; }
      }
      if (isFF) {
        esi += recSize;
        continue;
      }

      if (esi + recSize > 0x1000) break;

      // 36バイトGPSレコードのパース
      const view = new DataView(buffer.buffer, buffer.byteOffset + pos, recSize);
      const fixMode = view.getUint16(4, true);
      const lat = view.getFloat64(6, true);
      const lon = view.getFloat64(14, true);
      const spd = view.getFloat32(26, true);

      // 公式ソフトの検証フィルタ: 3D Fix (fixMode == 3), spd > 0.0, 有効な緯度経度
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

  if (recordCount === 0 || firstLat === null) {
    return; // 有効レコードなし時は更新しない
  }

  // Delphi x87 FPU 80-bit 拡張倍精度浮動小数点数の精密シミュレーション
  // Delphi 内蔵 Pi 定数: mantissa = 0xc90fdaa22168c235, exp = 1
  const PI_MANTISSA = 0xc90fdaa22168c235n;
  const SCALE = 64n;

  function doubleToFixed(d) {
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

  function fixedSqrt(valFixed) {
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

  // オフセット 0x00000100 〜 0x00000109（10バイト）に書き込み
  for (let i = 0; i < 8; i++) {
    buffer[0x100 + i] = Number((mantissa64 >> BigInt(i * 8)) & 0xffn);
  }
  const expWord = biasedExp;
  buffer[0x108] = expWord & 0xff;
  buffer[0x109] = (expWord >> 8) & 0xff;
}

// 保存ファイル名（DS4_YYYYMMDDHHMM.bnx4）の生成
function generateDefaultFileName(bytes) {
  let targetDate = new Date();

  // ログバイナリから先頭の有効なUTCタイムスタンプ（0x0440番地）を取得できるか試行
  if (bytes && bytes.length >= 0x444) {
    const ts = bytes[0x440] | (bytes[0x441] << 8) | (bytes[0x442] << 16) | (bytes[0x443] << 24);
    // 有効なUNIX時間 (2020年〜2040年: 1577836800 〜 2208988800) の場合
    if (ts > 1577836800 && ts < 2208988800) {
      targetDate = new Date(ts * 1000);
    }
  }

  const yyyy = targetDate.getFullYear();
  const MM = String(targetDate.getMonth() + 1).padStart(2, '0');
  const dd = String(targetDate.getDate()).padStart(2, '0');
  const HH = String(targetDate.getHours()).padStart(2, '0');
  const mm = String(targetDate.getMinutes()).padStart(2, '0');
  return `DS4_${yyyy}${MM}${dd}${HH}${mm}.bnx4`;
}

// ファイル保存処理 (Electron IPC または ブラウザ File System Access)
async function saveFile(uint8Array, defaultName) {
  // Electron 環境の場合
  if (window.electronAPI && window.electronAPI.saveBinaryFile) {
    const res = await window.electronAPI.saveBinaryFile({
      defaultName,
      dataArray: Array.from(uint8Array),
    });
    if (res.success) {
      appendLog('sys', `ファイルを保存しました: ${res.filePath}`);
    } else {
      appendLog('sys', `保存キャンセル: ${res.error}`);
    }
    return;
  }

  // 一般ブラウザ環境 (File System Access API)
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: defaultName,
        types: [
          { description: 'デジスパイスIV ログファイル (*.bnx4)', accept: { 'application/octet-stream': ['.bnx4'] } },
          { description: 'バイナリログファイル (*.bin)', accept: { 'application/octet-stream': ['.bin'] } },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(uint8Array);
      await writable.close();
      appendLog('sys', 'ファイルの保存が完了しました。');
      return;
    } catch (e) {
      console.warn(e);
    }
  }

  // フォールバック: 通常のダウンロードリンク生成
  const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
}

// ==============================================================================
// UI イベントリスナー
// ==============================================================================

function enableControls(enabled) {
  btnRefreshConfig.disabled = !enabled;
  btnRates.forEach(b => (b.disabled = !enabled));
  btnPresetSpeeds.forEach(b => (b.disabled = !enabled));
  inputCustomSpeed.disabled = !enabled;
  btnApplySpeed.disabled = !enabled;
  btnDownload.disabled = !enabled;
  btnErase.disabled = !enabled || !chkConfirmErase.checked;
}

btnConnect.addEventListener('click', connectSerial);
btnDisconnect.addEventListener('click', disconnectSerial);
btnRefreshConfig.addEventListener('click', queryConfiguration);

btnRates.forEach(btn => {
  btn.addEventListener('click', () => {
    const rate = parseInt(btn.dataset.rate, 10);
    setLogRate(rate);
  });
});

btnPresetSpeeds.forEach(btn => {
  btn.addEventListener('click', () => {
    const spd = parseFloat(btn.dataset.speed);
    inputCustomSpeed.value = spd;
    setSpeedThreshold(spd);
  });
});

btnApplySpeed.addEventListener('click', () => {
  const spd = parseFloat(inputCustomSpeed.value);
  if (!isNaN(spd) && spd > 0) {
    setSpeedThreshold(spd);
  } else {
    alert('有効な速度（正の数値）を入力してください。');
  }
});

chkConfirmErase.addEventListener('change', () => {
  btnErase.disabled = !serialPort || !chkConfirmErase.checked;
});

btnErase.addEventListener('click', eraseFlash);
btnDownload.addEventListener('click', downloadLogs);
