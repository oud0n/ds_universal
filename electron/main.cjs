const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// GoPro 4K/60fps 等の H.265 (HEVC) ハードウェアアクセラレーション再生の有効化
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'DigiSpice Universal Suite - GPS Data Logger & Telemetry Analyser',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  // Web Serial API の自動検出 & 自動選択ハンドラ (デジスパイスIV VID: 0x2DCF / 11727, PID: 0x6002 / 24578)
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    console.log('[メインプロセス] 検出されたシリアルポート:', portList);

    if (portList && portList.length > 0) {
      const dsPort = portList.find(p => {
        const vid = String(p.vendorId).toLowerCase();
        const pid = String(p.productId).toLowerCase();
        return (vid === '11727' || vid === '0x2dcf' || vid === '2dcf') &&
               (pid === '24578' || pid === '0x6002' || pid === '6002');
      });

      if (dsPort) {
        console.log('[メインプロセス] デジスパイスIVを自動選択:', dsPort.portId);
        callback(dsPort.portId);
      } else {
        console.log('[メインプロセス] 候補ポートを選択:', portList[0].portId);
        callback(portList[0].portId);
      }
    } else {
      callback('');
    }
  });

  // シリアルポートアクセス権限の自動許可
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'serial') return true;
    return false;
  });

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'serial') return true;
    return false;
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  async function loadApp() {
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
          label: 'ログファイルを開く (.bnx4, .dtb, .csv, .nmea)...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const { filePaths } = await dialog.showOpenDialog(mainWindow, {
              properties: ['openFile', 'multiSelections'],
              filters: [
                { name: 'デジスパイス生ログファイル', extensions: ['bnx4', 'bon4', 'binx', 'bon'] },
                { name: 'デジスパイス独自バイナリ (.dtb)', extensions: ['dtb'] },
                { name: 'CSV / NMEA ログ', extensions: ['csv', 'txt', 'nmea', 'log'] },
                { name: 'すべてのファイル', extensions: ['*'] }
              ]
            });
            if (filePaths && filePaths.length > 0) {
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
          label: 'DigiSpice Universal Suite について',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'バージョン情報',
              message: 'DigiSpice Universal Suite v1.0.0',
              detail: 'デジスパイスIV USB直接通信・ダウンロード & オフライン走行解析ユニバーサルアプリケーション'
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
    const buffer = fs.readFileSync(filePath);
    return {
      success: true,
      name: path.basename(filePath),
      dataArray: Array.from(buffer)
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
