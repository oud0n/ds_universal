// ==============================================================================
// デジスパイスIV 制御ツール (Electron メインプロセス)
// ==============================================================================

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1020,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    title: 'DigSpice Universal Tool - デジスパイスIV コントロール',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  // Web Serial API のポート自動選択ハンドラ (デジスパイスIVのVID: 0x2DCF, PID: 0x6002 を自動認識)
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    console.log('[メインプロセス] 検出されたシリアルポート一覧:', portList);

    if (portList && portList.length > 0) {
      // VID: 0x2DCF (11727), PID: 0x6002 (24578) でデジスパイスIVを探索
      const dsPort = portList.find(p => {
        const vid = String(p.vendorId).toLowerCase();
        const pid = String(p.productId).toLowerCase();
        return (vid === '11727' || vid === '0x2dcf' || vid === '2dcf') &&
               (pid === '24578' || pid === '0x6002' || pid === '6002');
      });

      if (dsPort) {
        console.log('[メインプロセス] デジスパイスIVを自動選択しました:', dsPort.portId);
        callback(dsPort.portId);
      } else {
        // VID/PIDで完全一致しなかった場合は先頭のポートを使用
        console.log('[メインプロセス] 候補ポートを選択します:', portList[0].portId);
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

  mainWindow.loadFile('index.html');
}

// ログバイナリ保存用の IPC ハンドラ
ipcMain.handle('save-binary-file', async (event, { defaultName, dataArray }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'デジスパイスIV 走行ログデータの保存',
    defaultPath: defaultName || 'DS4_log.bnx4',
    filters: [
      { name: 'デジスパイスIV ログファイル (*.bnx4)', extensions: ['bnx4'] },
      { name: 'バイナリログファイル (*.bin)', extensions: ['bin'] },
      { name: 'すべてのファイル (*.*)', extensions: ['*'] },
    ],
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

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
