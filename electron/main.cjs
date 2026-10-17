const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

// GoPro 4K/60fps 等の H.265 (HEVC) ハードウェアアクセラレーション再生の有効化
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow = null;

// デジスパイスIV の USB シリアル (VID 0x2DCF / PID 0x6002)
const LOGGER_VENDOR_ID = 0x2dcf;
const LOGGER_PRODUCT_ID = 0x6002;
// メニューの「開く」ダイアログで利用者が選んだファイルだけを、レンダラーから読めるようにする
const approvedReadPaths = new Set();
// 1 ファイルとして読み込む大きさの上限
const MAX_READ_BYTES = 512 * 1024 * 1024;

// ポート選択イベントは vendorId / productId (文字列)、デバイス権限の問い合わせは vendor_id / product_id (数値) で渡される
function isLoggerPort(port) {
  const vendorId = Number(port.vendorId ?? port.vendor_id);
  const productId = Number(port.productId ?? port.product_id);
  return vendorId === LOGGER_VENDOR_ID && productId === LOGGER_PRODUCT_ID;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'DS Universal Suite - GPS Data Logger & Telemetry Analyser',
    // 画面が出るまでの背景。テーマ (システムに合わせる場合) と同じく OS の設定に合わせる
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1117' : '#e9edf2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  // 外部リンク (Buy Me a Coffee, GitHub等) をOS標準ブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
    // アプリ内で新しいウインドウは開かない
    return { action: 'deny' };
  });

  // アプリ自身のページ以外へは遷移させない (外部ページにアプリの権限を渡さない)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (url.startsWith('https:') || url.startsWith('http:')) shell.openExternal(url);
    }
  });

  // Web Serial API のポート選択: デジスパイスIV だけを自動で選ぶ (見つからなければ何も選ばない)
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    const dsPort = webContents === mainWindow.webContents ? (portList || []).find(isLoggerPort) : undefined;
    if (dsPort) {
      console.log('[メインプロセス] デジスパイスIVを自動選択:', dsPort.portId);
      callback(dsPort.portId);
    } else {
      callback('');
    }
  });

  // シリアルポートの権限: このアプリの画面からの要求で、対象がデジスパイスIV の場合だけ許可する
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'serial' && webContents === mainWindow.webContents;
  });

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial' && !!details.device && isLoggerPort(details.device);
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  async function loadApp() {
    // 配布版は同梱した画面だけを読み込む (開発サーバーや環境変数の URL は開発時のみ)
    if (app.isPackaged) {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
      return;
    }

    if (process.env.ELECTRON_START_URL) {
      mainWindow.loadURL(process.env.ELECTRON_START_URL);
      return;
    }

    const devUrl = 'http://localhost:5173';
    const indexPath = path.join(__dirname, '../dist/index.html');

    // 1. Vite 開発サーバーの接続確認 (http://localhost:5173)
    const isPortOpen = await new Promise((resolve) => {
      const http = require('http');
      const req = http.get(devUrl, (res) => {
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(800, () => {
        req.destroy();
        resolve(false);
      });
    });

    if (isPortOpen) {
      console.log('[メインプロセス] Vite 開発サーバーに接続します:', devUrl);
      mainWindow.loadURL(devUrl);
      return;
    }

    // 2. ビルド済み dist/index.html が存在する場合はロード
    if (fs.existsSync(indexPath)) {
      console.log('[メインプロセス] ビルド済みファイルをロードします:', indexPath);
      mainWindow.loadFile(indexPath);
      return;
    }

    // 3. どちらもない場合 (Vite 起動待機中など) は少し待機してリトライ
    console.log('[メインプロセス] 開発サーバー起動待機中... (リトライ)');
    let retries = 5;
    const retryInterval = setInterval(async () => {
      retries--;
      const open = await new Promise((resolve) => {
        const http = require('http');
        const req = http.get(devUrl, () => resolve(true));
        req.on('error', () => resolve(false));
        req.setTimeout(800, () => { req.destroy(); resolve(false); });
      });

      if (open) {
        clearInterval(retryInterval);
        mainWindow.loadURL(devUrl);
      } else if (retries <= 0) {
        clearInterval(retryInterval);
        if (fs.existsSync(indexPath)) {
          mainWindow.loadFile(indexPath);
        } else {
          mainWindow.loadURL(devUrl); // 最終フォールバック
        }
      }
    }, 1000);
  }

  loadApp();

  // メニューバー設定
  const template = [
    {
      label: 'ファイル',
      submenu: [
        {
          label: 'ログファイルを開く (.bnx4, .dtb, .csv, .nmea, .vbo)...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const { filePaths } = await dialog.showOpenDialog(mainWindow, {
              properties: ['openFile', 'multiSelections'],
              filters: [
                { name: 'デジスパイス生ログファイル', extensions: ['bnx4', 'bon4', 'binx', 'bon'] },
                { name: 'デジスパイス独自バイナリ (.dtb)', extensions: ['dtb'] },
                { name: 'CSV / NMEA / VBO / GPX ログ', extensions: ['csv', 'txt', 'nmea', 'log', 'vbo', 'gpx'] },
                { name: 'すべてのファイル', extensions: ['*'] }
              ]
            });
            if (filePaths && filePaths.length > 0) {
              filePaths.forEach(p => approvedReadPaths.add(p));
              mainWindow.webContents.send('open-files', filePaths);
            }
          }
        },
        { type: 'separator' },
        {
          label: '終了',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: '表示',
      submenu: [
        { label: '再読み込み', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        { label: 'フルスクリーン切り替え', accelerator: 'F11', click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
        { type: 'separator' },
        { label: '開発者ツール', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow.webContents.toggleDevTools() }
      ]
    },
    {
      label: 'ヘルプ',
      submenu: [
        {
          label: '開発者を支援 (Buy Me a Coffee)...',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('open-donate-modal');
            } else {
              shell.openExternal('https://buymeacoffee.com/oud0n');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'DS Universal Suite について',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'バージョン情報',
              message: `DS Universal Suite v${app.getVersion()}`,
              detail: 'デジスパイスIV USB直接通信・ダウンロード & オフライン走行解析ユニバーサルアプリケーション\n作者: oud0n (https://github.com/oud0n/ds_universal)'
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 外部URL起動 IPC ハンドラ
ipcMain.handle('open-external', async (_event, url) => {
  if (url && (url.startsWith('https:') || url.startsWith('http:'))) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// バイナリファイル保存 IPC ハンドラ
ipcMain.handle('save-binary-file', async (event, { defaultName, dataArray }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'デジスパイスIV 走行ログデータの保存',
    defaultPath: defaultName || 'DS4_log.bnx4',
    filters: [
      { name: 'デジスパイスIV ログファイル (*.bnx4)', extensions: ['bnx4'] },
      { name: 'バイナリログファイル (*.bin)', extensions: ['bin'] },
      { name: 'すべてのファイル (*.*)', extensions: ['*'] }
    ]
  });

  if (canceled || !filePath) {
    return { success: false, error: '保存がキャンセルされました' };
  }

  try {
    const buffer = Buffer.from(dataArray);
    fs.writeFileSync(filePath, buffer);
    return { success: true, filePath, bytesWritten: buffer.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ファイル読み込み IPC ハンドラ
ipcMain.handle('read-file-buffer', async (event, filePath) => {
  try {
    // 「開く」ダイアログで選ばれたファイル以外は読ませない
    if (typeof filePath !== 'string' || !approvedReadPaths.has(filePath)) {
      return { success: false, error: 'このファイルの読み込みは許可されていません' };
    }
    approvedReadPaths.delete(filePath);
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_READ_BYTES) {
      return { success: false, error: 'ファイルが大きすぎます' };
    }
    const buffer = await fs.promises.readFile(filePath);
    return {
      success: true,
      name: path.basename(filePath),
      // バイト列のまま渡す (数値の配列に展開しない)
      dataArray: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
