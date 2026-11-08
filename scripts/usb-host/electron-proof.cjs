const { app, BrowserWindow, ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { installUsbHost } = require('../../electron/usb-ipc.cjs');
const { UsbHostBroker } = require('../../electron/usb-host.cjs');
const output = process.env.USB_PROOF_RESULT;
const html = process.env.USB_PROOF_HTML;
app.setPath('userData', process.env.USB_PROOF_USER_DATA);
const brokers = [];
class RecordingBroker extends UsbHostBroker { constructor(o) { super(o); brokers.push(this); } }
const host = installUsbHost({ app, ipcMain, executable: process.env.LAPLOUPE_USB_TEST_BINARY,
  args: ['--test-port', process.env.USB_PROOF_PORT], enabled: true, Broker: RecordingBroker });
let window, finished = false;
const timeout = setTimeout(() => finish({ error: 'Electron proof timed out' }), 25000);
async function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  try { await host.dispose(); } catch (_) {}
  fs.writeFileSync(output, JSON.stringify(result));
  if (window && !window.isDestroyed()) window.destroy();
  app.quit();
}
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ show: false, webPreferences: {
      preload: path.resolve(__dirname, '../../electron/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: false
    } });
    host.attachWindow(window, [pathToFileURL(html).href]);
    await window.loadFile(html);
    const first = await window.webContents.executeJavaScript('window.usbHostProof || Promise.reject(new Error("Proof renderer did not start"))');
    await window.loadFile(html, { query: { hold: '1' } });
    await window.webContents.executeJavaScript('window.usbHostOpened || Promise.reject(new Error("Proof renderer did not start"))');
    const quitChild = brokers[brokers.length - 1].active.child;
    const cancelNavigation = event => event.preventDefault();
    window.webContents.on('will-navigate', cancelNavigation);
    const blocked = once(window.webContents, 'will-navigate');
    await window.webContents.executeJavaScript('location.href = ' + JSON.stringify(pathToFileURL(path.join(path.dirname(html), 'blocked.html')).href) + '; true');
    await blocked; window.webContents.removeListener('will-navigate', cancelNavigation);
    const afterCancelledNavigation = await window.webContents.executeJavaScript('window.usbHostPing()');
    window.webContents.on('will-prevent-unload', () => {}); // 何も取り消さない = Stay
    await window.webContents.executeJavaScript('window.onbeforeunload = () => false; true');
    const reloadStayed = once(window.webContents, 'will-prevent-unload');
    window.webContents.reload(); await reloadStayed;
    const afterCancelledReload = await window.webContents.executeJavaScript('window.usbHostPing()');
    const stayed = once(window.webContents, 'will-prevent-unload');
    app.quit(); await stayed;
    const cancelledQuitKeptConnection = quitChild.exitCode === null && quitChild.signalCode === null;
    await window.webContents.executeJavaScript('window.onbeforeunload = null; window.usbHostResume()');
    const afterCancelledQuit = await window.webContents.executeJavaScript('window.usbHostProof');
    await window.loadFile(html, { query: { hold: '1' } });
    await window.webContents.executeJavaScript('window.usbHostOpened');
    const oldChild = brokers[brokers.length - 1].active.child;
    const loaded = once(window.webContents, 'did-finish-load');
    // holdを外すnavigationで、開いたままの旧USBプロセスも終了させる。
    await window.loadFile(html); await loaded;
    const afterReload = await window.webContents.executeJavaScript('window.usbHostProof || Promise.reject(new Error("Proof renderer did not start"))');
    await finish({ first, afterCancelledNavigation, afterCancelledReload, afterCancelledQuit, cancelledQuitKeptConnection, afterReload, oldChildEnded: oldChild.exitCode !== null || oldChild.signalCode !== null });
  } catch (error) { await finish({ error: String(error.stack || error) }); }
});
