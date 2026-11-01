// デスクトップ版の更新 (PLAN-44)。GitHub Releases の latest.yml / latest-mac.yml を見て、新しい版を知らせる。
// 通信するのは GitHub の目録を読むときと、[入れる] で落とすときだけ (ログ・設定は送らない)。
// 勝手には落とさない: 画面の [入れる] で落とし、落とし終わったら [再起動して入れる] か、閉じたときに入れ替える。
// 確かめるのは、タグで作った版 (package.json の autoUpdate が true) だけ。
// 入れ替えられない置き方 (Windows の zip 版、Mac の「アプリケーション」の外) では、知らせてダウンロードのページを開くだけ
const { app, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const RELEASES_URL = 'https://github.com/oud0n/ds_universal/releases/latest';
// 起動してから確かめるまで (立ち上がりの邪魔をしない)
const FIRST_CHECK_MS = 8000;
// 開いたままのときに確かめ直す間隔
const RECHECK_MS = 6 * 60 * 60 * 1000;

function readAutoUpdateFlag() {
  try {
    return require('../package.json').autoUpdate === true;
  } catch {
    return false;
  }
}

/** 入れ替えられる置き方か */
function canReplace() {
  if (process.platform === 'darwin') return app.isInApplicationsFolder();
  if (process.platform === 'win32') return fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall LapLoupe.exe'));
  return false;
}

// 起動したとき・開いたまま確かめるか (設定の「バージョン情報」。既定は確かめる)。画面より先に読むので、ここに置く
const settingsPath = () => path.join(app.getPath('userData'), 'update-settings.json');
function readAutoCheck() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).autoCheck !== false;
  } catch {
    return true;
  }
}
function writeAutoCheck(on) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify({ autoCheck: !!on }));
  } catch { /* 書けなくても、この起動のあいだは切り替える */ }
}

function setupUpdater(getWindow) {
  // 試験用: 開発中だけ、LAPLOUPE_FAKE_UPDATE=1.9.0 のように新しい版があるふりをする (落とす・入れるもふり)
  const fake = !app.isPackaged ? process.env.LAPLOUPE_FAKE_UPDATE : undefined;
  const enabled = app.isPackaged ? readAutoUpdateFlag() : !!fake;
  const state = {
    enabled,
    mode: fake ? (process.env.LAPLOUPE_FAKE_UPDATE_MODE === 'manual' ? 'manual' : 'auto') : (enabled && canReplace() ? 'auto' : 'manual'),
    autoCheck: readAutoCheck(),
    status: 'idle',
    current: app.getVersion(),
    version: null,
    percent: 0,
    error: null,
    checkedAt: null
  };
  const send = () => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('update-state', { ...state });
  };
  const set = (patch) => { Object.assign(state, patch); send(); };

  let updater = null;
  if (enabled && !fake) {
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.on('checking-for-update', () => set({ status: 'checking', error: null }));
    updater.on('update-available', (info) => set({ status: 'available', version: info.version, checkedAt: Date.now() }));
    updater.on('update-not-available', () => set({ status: 'none', version: null, checkedAt: Date.now() }));
    updater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    updater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }));
    updater.on('error', (e) => {
      const msg = String((e && e.message) || e);
      // 最新のリリースに目録が無い (更新の仕組みより前の版) ときは、新しい版が無いのと同じ
      if (state.status === 'checking' && /Cannot find latest/i.test(msg)) { set({ status: 'none', version: null, checkedAt: Date.now() }); return; }
      set({ status: 'error', error: msg.slice(0, 300), checkedAt: Date.now() });
    });
  }

  let checking = null;
  async function check() {
    if (!enabled) return;
    if (state.status === 'downloading' || state.status === 'ready') return;
    if (fake) {
      set({ status: 'checking', error: null });
      await new Promise(r => setTimeout(r, 600));
      set({ status: 'available', version: fake, checkedAt: Date.now() });
      return;
    }
    checking ??= updater.checkForUpdates().catch(() => { /* error のイベントで知らせる */ }).finally(() => { checking = null; });
    await checking;
  }

  async function download() {
    if (!enabled || state.status !== 'available') return;
    if (state.mode === 'manual') {
      await shell.openExternal(RELEASES_URL);
      return;
    }
    if (fake) {
      for (let p = 0; p <= 100; p += 20) { set({ status: 'downloading', percent: p }); await new Promise(r => setTimeout(r, 300)); }
      set({ status: 'ready', percent: 100 });
      return;
    }
    set({ status: 'downloading', percent: 0 });
    await updater.downloadUpdate().catch(() => { /* error のイベントで知らせる */ });
  }

  function install() {
    if (state.status !== 'ready') return;
    if (fake) { set({ status: 'idle', version: null }); return; }
    // 閉じてから入れ替え、入れ替えたら開き直す
    setImmediate(() => updater.quitAndInstall(false, true));
  }

  ipcMain.handle('update-get-state', () => ({ ...state }));
  ipcMain.handle('update-check', async () => { await check(); return { ...state }; });
  ipcMain.handle('update-download', async () => { await download(); return { ...state }; });
  ipcMain.handle('update-install', () => { install(); return { ...state }; });
  ipcMain.handle('update-set-auto-check', (_event, on) => { writeAutoCheck(on); set({ autoCheck: !!on }); return { ...state }; });
  ipcMain.handle('update-open-releases', () => shell.openExternal(RELEASES_URL));

  // 止めているときは、設定の「新しい版を確かめる」を押したときだけ通信する
  if (enabled) {
    setTimeout(() => { if (state.autoCheck) check(); }, FIRST_CHECK_MS);
    setInterval(() => { if (state.autoCheck) check(); }, RECHECK_MS).unref?.();
  }
}

module.exports = { setupUpdater };
