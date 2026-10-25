const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, protocol } = require('electron');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');

// GoPro 4K/60fps 等の H.265 (HEVC) ハードウェアアクセラレーション再生の有効化
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// アプリ名を「DS Universal Suite」から「DS Universal」、さらに「LapLoupe」に変えたので、データ (保存したユーザーコース・設定など) の
// 保存先は前の名前のフォルダを使い続ける (名前に合わせて変わると、更新した人のデータが引き継がれないため)。
// 開発中 (npm run electron:dev など、パッケージしていないとき) は従来どおり
// 起動のときに --user-data-dir で置き場所を指定したとき (試験など) は、その置き場所を使う
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'DS Universal Suite'));
}

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

// メニューバー。言語は画面で選んだものに合わせる (最初は OS の言語。画面から set-language で知らせる)
// (OS の言語は起動の準備ができてからでないと読めないので、使うときに読む)
let menuLang = null;
const L = (ja, en) => ((menuLang ?? (/^ja/i.test(app.getLocale()) ? 'ja' : 'en')) === 'en' ? en : ja);
function buildMenu() {
  const template = [
    {
      label: L('ファイル', 'File'),
      submenu: [
        {
          label: L('ログファイルを開く (.bnx4, .dtb, .csv, .nmea, .vbo, .xrk, .ibt)... (GoPro の動画は画面の「ファイル読込」から)', 'Open log file (.bnx4, .dtb, .csv, .nmea, .vbo, .xrk, .ibt)... (open GoPro videos with "Open file" in the window)'),
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const { filePaths } = await dialog.showOpenDialog(mainWindow, {
              properties: ['openFile', 'multiSelections'],
              filters: [
                { name: L('デジスパイス生ログファイル', 'DigSpice raw logs'), extensions: ['bnx4', 'bon4', 'binx', 'bon'] },
                { name: L('デジスパイス独自バイナリ (.dtb)', 'DigSpice binary (.dtb)'), extensions: ['dtb'] },
                { name: L('CSV / NMEA / VBO / GPX ログ', 'CSV / NMEA / VBO / GPX logs'), extensions: ['csv', 'txt', 'nmea', 'log', 'vbo', 'gpx'] },
                { name: 'AiM (.xrk / .xrz)', extensions: ['xrk', 'xrz'] },
                { name: L('iRacing のテレメトリ (.ibt)', 'iRacing telemetry (.ibt)'), extensions: ['ibt'] },
                { name: L('すべてのファイル', 'All files'), extensions: ['*'] }
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
          label: L('終了', 'Quit'),
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => app.quit()
        }
      ]
    },
    // 編集: Mac では、このメニューがないと入力欄やコンソールで ⌘C・⌘V・⌘A が効かない
    {
      label: L('編集', 'Edit'),
      submenu: [
        { role: 'undo', label: L('取り消す', 'Undo') },
        { role: 'redo', label: L('やり直す', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: L('カット', 'Cut') },
        { role: 'copy', label: L('コピー', 'Copy') },
        { role: 'paste', label: L('ペースト', 'Paste') },
        { role: 'selectAll', label: L('すべてを選択', 'Select all') }
      ]
    },
    {
      label: L('表示', 'View'),
      submenu: [
        { label: L('再読み込み', 'Reload'), accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        { label: L('フルスクリーン切り替え', 'Toggle full screen'), accelerator: 'F11', click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
        // 開発者ツールは、開発中だけメニューに出す (配布版では出さない)
        ...(app.isPackaged ? [] : [
          { type: 'separator' },
          { label: L('開発者ツール', 'Developer tools'), accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow.webContents.toggleDevTools() }
        ])
      ]
    },
    {
      label: L('ヘルプ', 'Help'),
      submenu: [
        {
          label: L('開発者を支援 (Buy Me a Coffee)...', 'Support the developer (Buy Me a Coffee)...'),
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
          label: L('LapLoupe について', 'About LapLoupe'),
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: L('バージョン情報', 'About'),
              message: `LapLoupe v${app.getVersion()}`,
              detail: L('ラップ・走行ログの解析と、デジスパイスIV の USB 通信・ログのダウンロード (旧名 DS Universal)\n作者: oud0n (https://github.com/oud0n/ds_universal)', 'Lap and driving log analysis, and DigSpice IV USB communication and download (formerly DS Universal)\nAuthor: oud0n (https://github.com/oud0n/ds_universal)')
            });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'LapLoupe — Lap / Track Analyzer',
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
  // 画面が閉じるのを止めたとき (ロガーのログを消している間など、beforeunload で止める): 確かめてから閉じる。
  // Electron は、止めたことを何も知らせずに閉じるのをやめるだけなので、ここで聞く
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: [L('閉じない', 'Stay'), L('閉じる', 'Close anyway')],
      defaultId: 0,
      cancelId: 0,
      title: L('処理中です', 'Busy'),
      message: L('ロガーの処理 (ログの消去など) の途中です。', 'The logger is still working (erasing logs, etc.).'),
      detail: L('いま閉じると、本体の処理が途中で止まるおそれがあります。終わるまで待つことをおすすめします。', 'Closing now may interrupt the logger. It is best to wait until it finishes.')
    });
    // 「閉じる」を選んだら、止めたのを取り消して閉じる
    if (choice === 1) event.preventDefault();
  });

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

  // Web Bluetooth の機器の選択: Electron には選択画面がないので、名前が DS3 / DS4 で始まる機器を自動で選ぶ。
  // 見つかるまで何度も呼ばれる。10 秒で見つからなければ取りやめる (画面には「見つからなかった」として返る)
  let bluetoothPick = null;
  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    if (!bluetoothPick || bluetoothPick.callback !== callback) {
      if (bluetoothPick) clearTimeout(bluetoothPick.timer);
      bluetoothPick = {
        callback,
        timer: setTimeout(() => {
          bluetoothPick = null;
          // 探している間にウインドウを閉じていたら、答える先がもうないので何もしない
          try { callback(''); } catch (e) { console.warn('[メインプロセス] Bluetooth の選択の取りやめに失敗:', e); }
        }, 10000)
      };
    }
    const ds = (deviceList || []).find(d => /^DS[34]/.test(d.deviceName || ''));
    if (ds) {
      clearTimeout(bluetoothPick.timer);
      bluetoothPick = null;
      console.log('[メインプロセス] デジスパイスを Bluetooth で自動選択:', ds.deviceName);
      callback(ds.deviceId);
    }
  });

  // シリアルポート・Bluetooth の権限: このアプリの画面からの要求だけ許可する (シリアルの機器は下でデジスパイスIV に絞る)
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    return (permission === 'serial' || permission === 'bluetooth') && webContents === mainWindow.webContents;
  });

  // 機器の権限: シリアルはデジスパイスIV のポートだけ、Bluetooth は名前が DS3 / DS4 で始まる機器だけ許可する
  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    if (!details.device) return false;
    if (details.deviceType === 'serial') return isLoggerPort(details.device);
    if (details.deviceType === 'bluetooth') return /^DS[34]/.test(details.device.deviceName || details.device.name || '');
    return false;
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
  buildMenu();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 画面で言語を切り替えたら、メニューもその言語で作り直す
ipcMain.on('set-language', (_event, lang) => {
  if ((lang === 'ja' || lang === 'en') && lang !== menuLang) {
    menuLang = lang;
    if (mainWindow) buildMenu();
  }
});

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
    title: L('デジスパイスIV 走行ログデータの保存', 'Save DigSpice IV driving log'),
    defaultPath: defaultName || 'DS4_log.bnx4',
    filters: [
      { name: L('デジスパイスIV ログファイル (*.bnx4)', 'DigSpice IV log (*.bnx4)'), extensions: ['bnx4'] },
      { name: L('バイナリログファイル (*.bin)', 'Binary log (*.bin)'), extensions: ['bin'] },
      { name: L('すべてのファイル (*.*)', 'All files (*.*)'), extensions: ['*'] }
    ]
  });

  if (canceled || !filePath) {
    return { success: false, error: L('保存がキャンセルされました', 'Save cancelled') };
  }

  try {
    const buffer = Buffer.from(dataArray);
    fs.writeFileSync(filePath, buffer);
    return { success: true, filePath, bytesWritten: buffer.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// テキストファイル保存 IPC ハンドラ (コース編集の .cln / .sci の書き出し)
// <a download> で 2 つ続けて書き出すと、1 つ目の保存ダイアログが開いている間の 2 つ目が捨てられる (issue #7) ので、
// 画面から 1 ファイルずつ呼んで、保存ダイアログを順に出す
// 直前に保存したフォルダ (.cln を保存したフォルダに、続く .sci の保存ダイアログを開くため)
let lastTextSaveDir = null;
ipcMain.handle('save-text-file', async (_event, { defaultName, text } = {}) => {
  if (typeof text !== 'string') return { success: false, error: 'invalid text' };
  const name = path.basename(String(defaultName || 'course.txt'));
  const ext = path.extname(name).slice(1);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(lastTextSaveDir || app.getPath('downloads'), name),
    filters: [
      ...(ext ? [{ name: `.${ext}`, extensions: [ext] }] : []),
      { name: L('すべてのファイル (*.*)', 'All files (*.*)'), extensions: ['*'] }
    ]
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  lastTextSaveDir = path.dirname(filePath);
  try {
    await fs.promises.writeFile(filePath, text, 'utf8');
    return { success: true, filePath };
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

// ---- ラップタイムの一覧の保管場所 (2026-10-20、PLAN-19) ----
// 利用者が選んだフォルダ (iCloud Drive のフォルダなど) の <サーキットのフォルダ>/*.bon4 から周を数え、
// 同じフォルダの laptimes.json に控えておく。読めるのは選んだフォルダの中だけ、書けるのは laptimes.json だけ
const LAP_FOLDER_SETTING = () => path.join(app.getPath('userData'), 'lap-folder.json');
let lapFolder = null;
function loadLapFolder() {
  if (lapFolder !== null) return lapFolder || null;
  try {
    const v = JSON.parse(fs.readFileSync(LAP_FOLDER_SETTING(), 'utf8'));
    lapFolder = typeof v.folder === 'string' && fs.existsSync(v.folder) ? v.folder : '';
  } catch {
    lapFolder = '';
  }
  return lapFolder || null;
}
/** 控えとして読み書きしてよいファイルの名前と、読む大きさの上限 */
const LAP_TEXT_NAMES = new Set(['laptimes.json', 'runs.json', 'corners.json', 'corners.json.bak']);
// 保管場所の course/ (デジスパイスのコースフォルダにならった形。2026-10-24): コーナー (Corner/<フォルダ>.json と .bak)・
// コース編集で直したコースの計測線 (ControlLine/*.cln)・セクター線 (Sector/*.sci)・その名前などの一覧 (courses.json)
const COURSE_TEXT = /^course\/(Corner\/[a-z0-9_]+\.json(\.bak)?|ControlLine\/[^/\\]+\.cln|Sector\/[^/\\]+\.sci|courses\.json)$/;
// 解析用のセッション (sessions/<名前>.lapsession.json。保存した比べ方。PLAN-18。2026-10-25)
const SESSION_TEXT = /^sessions\/[^/\\]+\.lapsession\.json$/;
// メーターの並び (PLAN-08)
const OVERLAY_TEXT = /^overlays\/[^/\\]+\.overlay\.json$/;
const lapTextAllowed = (rel, full) => {
  const r = String(rel).replace(/\\/g, '/');
  return LAP_TEXT_NAMES.has(path.basename(full)) || COURSE_TEXT.test(r) || SESSION_TEXT.test(r) || OVERLAY_TEXT.test(r);
};
const MAX_LAP_TEXT_BYTES = 20 * 1024 * 1024;
/**
 * 保管場所からの道を、保管場所の中の実際の場所にする (外へ出る道は断る)。
 * 別名 (シンボリックリンク) をたどった先も保管場所の中か確かめる。ファイルがまだ無いとき (書くとき) は、入るフォルダで確かめる
 */
async function lapPath(rel) {
  const root = loadLapFolder();
  if (!root || typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  let realRoot;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return null;
  }
  // ドライブの直下 (/ や C:\) を選んだときも、区切りを二重にしない
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const full = path.resolve(realRoot, rel);
  if (!full.startsWith(prefix)) return null;
  let real;
  try {
    real = await fs.promises.realpath(full);
  } catch {
    // まだ無いフォルダの中 (course/Corner/ を初めて書くときなど) は、いちばん近くのある親フォルダで確かめる
    let dir = path.dirname(full);
    const rest = [path.basename(full)];
    for (;;) {
      try {
        real = path.join(await fs.promises.realpath(dir), ...rest);
        break;
      } catch {
        if (!dir.startsWith(prefix)) return null;
        rest.unshift(path.basename(dir));
        dir = path.dirname(dir);
      }
    }
  }
  return real.startsWith(prefix) ? real : null;
}
ipcMain.handle('laps-get-folder', async () => loadLapFolder());
ipcMain.handle('laps-pick-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: L('ラップタイムの記録の保管場所を選ぶ', 'Choose where lap timer runs are kept'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths?.[0]) return loadLapFolder();
  lapFolder = filePaths[0];
  try {
    await fs.promises.writeFile(LAP_FOLDER_SETTING(), JSON.stringify({ folder: lapFolder }), 'utf8');
  } catch {
    // 覚えられなくても、今回は使う
  }
  return lapFolder;
});
ipcMain.handle('laps-list', async () => {
  const root = loadLapFolder();
  if (!root) return { success: false, error: 'no folder' };
  try {
    const files = [];
    for (const dir of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
      for (const f of await fs.promises.readdir(path.join(root, dir.name), { withFileTypes: true })) {
        if (f.isFile() && icloudPlaceholder(f.name)) {
          files.push(await placeholderEntry(dir.name, path.join(root, dir.name), f.name));
          continue;
        }
        if (f.name.startsWith('.')) continue;
        // 日付のフォルダ (YYYYMMDD。2026-10-20 から、1 日の走行と動画をまとめる) の中も 1 段だけ見る
        if (f.isDirectory() && /^\d{8}$/.test(f.name)) {
          // 読めない日付のフォルダがあっても、ほかの走行は出す
          let inner = [];
          try { inner = await fs.promises.readdir(path.join(root, dir.name, f.name), { withFileTypes: true }); } catch { continue; }
          for (const g of inner) {
            if (g.isFile() && icloudPlaceholder(g.name)) {
              files.push(await placeholderEntry(`${dir.name}/${f.name}`, path.join(root, dir.name, f.name), g.name));
              continue;
            }
            if (!g.isFile() || g.name.startsWith('.')) continue;
            const st = await fs.promises.stat(path.join(root, dir.name, f.name, g.name));
            files.push({ path: `${dir.name}/${f.name}/${g.name}`, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
          }
          continue;
        }
        // デジスパイスのコースフォルダと同じ形の digspice/ (Circuit/・ControlLine/・Sector/ と 海外/ などの下) は、コースデータだけ深く見る
        if (f.isDirectory() && (dir.name.toLowerCase() === 'digspice' || dir.name === 'course')) {
          const walk = async (rel, depth) => {
            let entries = [];
            try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
            for (const g of entries) {
              if (g.name.startsWith('.')) continue;
              if (g.isDirectory() && depth < 3) await walk(`${rel}/${g.name}`, depth + 1);
              else if (g.isFile() && /\.(cln|pth|sci|json)$/i.test(g.name)) {
                const st = await fs.promises.stat(path.join(root, rel, g.name));
                files.push({ path: `${rel}/${g.name}`, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
              }
            }
          };
          await walk(`${dir.name}/${f.name}`, 1);
          continue;
        }
        if (!f.isFile()) continue;
        const st = await fs.promises.stat(path.join(root, dir.name, f.name));
        files.push({ path: `${dir.name}/${f.name}`, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      }
    }
    return { success: true, files };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('laps-read', async (_event, rel) => {
  const full = await lapPath(rel);
  if (!full) return { success: false, error: 'not allowed' };
  try {
    const st = await fs.promises.stat(full);
    if (st.size > MAX_READ_BYTES) return { success: false, error: 'too large' };
    const buffer = await fs.promises.readFile(full);
    return { success: true, data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
// iCloud Drive にだけあって、この Mac にまだ落ちてきていないファイル (.<名前>.icloud)。
// 一覧では、元の名前で「この Mac に無い」(local: false) として出す (出さないと、消した走行とみなされ、ラップの控え・隠した周の印が消えるため)
function icloudPlaceholder(name) {
  const m = /^\.(.+)\.icloud$/.exec(name);
  return m && !m[1].startsWith('.') ? m[1] : null;
}
async function placeholderEntry(relDir, absDir, name) {
  const st = await fs.promises.stat(path.join(absDir, name));
  return { path: `${relDir}/${icloudPlaceholder(name)}`, size: 0, mtimeMs: Math.round(st.mtimeMs), local: false };
}
ipcMain.handle('laps-file-status', async (_event, rel) => {
  const full = await lapPath(rel);
  if (!full) return { local: false, downloading: false };
  if (await fs.promises.stat(full).then(() => true, () => false)) return { local: true, downloading: false };
  const placeholder = path.join(path.dirname(full), `.${path.basename(full)}.icloud`);
  return { local: false, downloading: await fs.promises.stat(placeholder).then(() => true, () => false) };
});
// 走行のファイルを消す (走行の画面の「この走行を消す」。2026-10-25)。ゴミ箱へ移す (戻せるように)。
// サーキットのフォルダの中のものだけ (共有の控え・コース・セッションは消さない)
const lapDeletable = rel => {
  const r = String(rel).replace(/\\/g, '/');
  const name = path.posix.basename(r);
  // . や .. の区切りは断る (道を解いたあとに、守っているフォルダ・ファイルを指せないように)
  if (r.split('/').some(s => s === '' || s === '.' || s === '..')) return false;
  return r.includes('/') && !/^(course|sessions|exports)\//.test(r) && !name.startsWith('.') && !['runs.json', 'laptimes.json', 'corners.json', 'corners.json.bak'].includes(name);
};
ipcMain.handle('laps-delete', async (_event, rels) => {
  const deleted = [];
  const failed = [];
  for (const rel of Array.isArray(rels) ? rels : []) {
    const full = lapDeletable(rel) ? await lapPath(rel) : null;
    if (!full) { failed.push({ path: String(rel), error: 'not deletable' }); continue; }
    // iCloud にだけあるもの (.名前.icloud) は、その置き場所のファイルを消す
    const placeholder = path.join(path.dirname(full), `.${path.basename(full)}.icloud`);
    const target = await fs.promises.stat(full).then(() => full, () => fs.promises.stat(placeholder).then(() => placeholder, () => null));
    if (!target) { deleted.push(rel); continue; }
    try {
      await shell.trashItem(target);
      deleted.push(rel);
    } catch (e) {
      failed.push({ path: rel, error: String(e && e.message || e) });
    }
  }
  return { deleted, failed };
});
ipcMain.handle('laps-start-download', async (_event, rel) => {
  const full = await lapPath(rel);
  if (!full || process.platform !== 'darwin') return { success: false };
  // iCloud Drive から落とす (brctl は macOS に入っている)
  await new Promise(resolve => require('child_process').execFile('/usr/bin/brctl', ['download', full], () => resolve(undefined)));
  return { success: true };
});
ipcMain.handle('laps-read-text', async (_event, rel) => {
  const full = await lapPath(rel);
  // iCloud がぶつかったときに作る runs.json の写し (runs 2.json など) も読める (書くのは runs.json だけ)
  if (!full || !(lapTextAllowed(rel, full) || /^runs[ _-]+\(?\d+\)?\.json$/i.test(path.basename(full)))) return { success: false, error: 'not allowed' };
  try {
    const st = await fs.promises.stat(full);
    if (st.size > MAX_LAP_TEXT_BYTES) return { success: false, error: 'too large' };
    return { success: true, text: await fs.promises.readFile(full, 'utf8') };
  } catch (err) {
    // 無いときだけ null。読めないとき (ほかのアプリが開いているなど) は失敗を返す (無いとみなして書くと、ほかの走行の行を消すため)。
    // iCloud Drive にだけあって、この Mac にまだ落ちてきていないファイル (.runs.json.icloud) も、読めないとみなす
    // (無いとみなして新しく作ると、iCloud がぶつかったときの写しを作り、前の中身が使われなくなるため)
    if (err && err.code === 'ENOENT') {
      const placeholder = path.join(path.dirname(full), `.${path.basename(full)}.icloud`);
      if (await fs.promises.stat(placeholder).then(() => true, () => false)) return { success: false, error: 'only in iCloud' };
      return { success: true, text: null };
    }
    return { success: false, error: err?.message ?? 'read failed' };
  }
});
ipcMain.handle('laps-write-text', async (_event, rel, text) => {
  const full = await lapPath(rel);
  if (!full || !lapTextAllowed(rel, full) || typeof text !== 'string' || text.length > MAX_LAP_TEXT_BYTES) return { success: false, error: 'not allowed' };
  try {
    // course/Corner/ などのフォルダがまだ無ければ作る
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    // 一時ファイルに書いてから入れ替える (途中で止まっても、前の控えが残る)
    const tmp = `${full}.tmp`;
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, full);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 取り込み (2026-10-21): 走行のファイルを新しく書く。上書きはしない (もうあれば exists)。
// 書けるのは走行の形式 (.nmea・.bon4・.csv) と、取り込み元/ の下の元のログだけ
const IMPORT_EXTS = new Set(['.nmea', '.bon4', '.csv']);
const IMPORT_SOURCE_EXTS = new Set(['.nmea', '.bon4', '.bnx4', '.bon', '.binx', '.dtb', '.csv', '.txt', '.vbo', '.gpx', '.tcx', '.fit', '.log', '.xrk', '.xrz', '.ibt']);
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
/**
 * 書く先の道 (まだないフォルダの中でもよい)。いちばん近い、もうあるフォルダの本当の場所で、保管場所の中かを確かめる
 * (つないだ先 (シンボリックリンク) で保管場所の外へ出ないように)
 */
async function lapPathForWrite(rel) {
  const root = loadLapFolder();
  if (!root || typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  let realRoot;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return null;
  }
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const full = path.resolve(realRoot, rel);
  if (!full.startsWith(prefix)) return null;
  const rest = [];
  let dir = path.dirname(full);
  for (;;) {
    try {
      const realDir = await fs.promises.realpath(dir);
      const real = path.join(realDir, ...rest, path.basename(full));
      return (realDir === realRoot || realDir.startsWith(prefix)) && real.startsWith(prefix) ? real : null;
    } catch {
      if (dir.length <= realRoot.length) return null;
      rest.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
}
ipcMain.handle('laps-write-file', async (_event, rel, data) => {
  const full = await lapPathForWrite(rel);
  const ext = full ? path.extname(full).toLowerCase() : '';
  // 取り込み元/ は、その直下のファイルだけ (「取り込み元/../」で外へ出ないように)
  const isSource = typeof rel === 'string' && /^取り込み元\/[^/\\]+$/.test(rel) && !rel.includes('..');
  if (!full || !(isSource ? IMPORT_SOURCE_EXTS.has(ext) : IMPORT_EXTS.has(ext))) return { success: false, error: 'not allowed' };
  if (!(data instanceof Uint8Array) || data.byteLength > MAX_IMPORT_BYTES) return { success: false, error: 'not allowed' };
  try {
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    // wx: もうあれば失敗する (上書きしない)
    await fs.promises.writeFile(full, data, { flag: 'wx' });
    return { success: true };
  } catch (err) {
    if (err && err.code === 'EEXIST') return { success: false, error: 'exists' };
    return { success: false, error: err.message };
  }
});

// ---- 保管場所の動画を lapfile://run/<道> で読む (2026-10-20、docs/session_storage_design.md) ----
// 大きな動画を丸ごと読まずに、頼まれた範囲 (Range) だけ返す。読めるのは保管場所の中の動画だけ
protocol.registerSchemesAsPrivileged([
  { scheme: 'lapfile', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
]);
const LAP_VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', lrv: 'video/mp4', insv: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' };
async function serveLapFile(request) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges', 'Cache-Control': 'no-store' };
  let rel;
  try {
    const url = new URL(request.url);
    if (url.host !== 'run') return new Response(null, { status: 404, headers });
    rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return new Response(null, { status: 400, headers });
  }
  const type = LAP_VIDEO_TYPES[path.extname(rel).slice(1).toLowerCase()];
  const full = type ? await lapPath(rel) : null;
  if (!full) return new Response(null, { status: 404, headers });
  let size;
  try {
    size = (await fs.promises.stat(full)).size;
  } catch {
    return new Response(null, { status: 404, headers });
  }
  let start = 0;
  let end = size - 1;
  let partial = false;
  const m = /^bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (m) {
    partial = true;
    if (m[1] === '' && m[2] !== '') start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1] || 0);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
  }
  if (size === 0 && !partial) return new Response(null, { status: 200, headers: { ...headers, 'Content-Type': type, 'Content-Length': '0' } });
  if (size === 0 || start > end || start >= size) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  const body = Readable.toWeb(fs.createReadStream(full, { start, end }));
  return new Response(body, {
    status: partial ? 206 : 200,
    headers: {
      ...headers,
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    }
  });
}

app.whenReady().then(() => {
  protocol.handle('lapfile', serveLapFile);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
