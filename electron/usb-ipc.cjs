const { randomUUID } = require('node:crypto');
const { UsbHostBroker } = require('./usb-host.cjs');
const bad = () => ({ code: 'permission-denied', detail: 'USB IPC sender is not the current application document' });
const cancelled = () => ({ code: 'cancelled', detail: 'Application document changed' });
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function page(url) { const u = new URL(url); u.hash = ''; u.search = ''; return u.href; }

/** 窓/文書ごとの権限。レンダラーから実行ファイル名・port名は受け取らない。 */
function installUsbHost({ app, ipcMain, executable, args = [], enabled = process.env.LAPLOUPE_USB_HOST === '1', Broker = UsbHostBroker }) {
  enabled = enabled && !app.isPackaged;
  let window = null, allowed = new Set(), epoch = 0, owner = null, ready = gate(), teardown = Promise.resolve();
  function current(event) {
    try { return window && !window.isDestroyed() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame && allowed.has(page(event.senderFrame.url)); }
    catch (_) { return false; }
  }
  function retire() {
    epoch++; ready.reject(cancelled()); ready = gate();
    const old = owner; owner = null;
    if (old?.broker) teardown = Promise.allSettled([teardown, old.broker.dispose()]).then(() => {});
  }
  function authorize(event, binding) {
    if (!current(event) || !owner || owner.binding !== binding || owner.epoch !== epoch) throw bad();
    return owner;
  }
  ipcMain.handle('usb-host-bind', async event => {
    try {
      if (!current(event)) throw bad();
      if (!enabled) return { ok: true, enabled: false };
      const generation = epoch;
      await ready.promise;
      if (generation !== epoch || !current(event)) throw cancelled();
      if (!owner) owner = { binding: randomUUID(), epoch, broker: null };
      return { ok: true, enabled: true, binding: owner.binding };
    } catch (error) { return { ok: false, error: error?.code ? error : bad() }; }
  });
  ipcMain.handle('usb-host-request', async (event, binding, method, params) => {
    try {
      if (!enabled) throw { code: 'not-supported', detail: 'USB host is disabled' };
      const document = authorize(event, binding);
      await teardown;
      if (authorize(event, binding) !== document) throw cancelled();
      if (!document.broker) document.broker = new Broker({ executable, args, onEvent: payload => {
        if (owner !== document || !current(event)) return;
        try { event.senderFrame.send('usb-host-event', { binding, event: payload }); } catch (_) { retire(); }
      } });
      const result = await document.broker.request(method, params);
      if (authorize(event, binding) !== document) throw cancelled();
      return { ok: true, result };
    } catch (error) { return { ok: false, error: error?.code ? error : { code: 'io', detail: 'USB host request failed' } }; }
  });
  const quit = () => retire();
  app.on('will-quit', quit);
  return {
    attachWindow(next, urls) {
      retire(); window = next; allowed = new Set(urls.map(page));
      const wc = next.webContents;
      // 開始要求はwill-navigate/beforeunloadで取り消されることがある。
      // 文書の切替確定まで、元のbindingと接続を失効させない。
      wc.on('did-frame-navigate', (_event, _url, _status, _text, isMainFrame) => {
        if (window === next && isMainFrame) retire();
      });
      wc.on('dom-ready', () => { if (window === next) ready.resolve(); });
      wc.on('render-process-gone', () => { if (window === next) retire(); });
      wc.on('destroyed', () => { if (window === next) { retire(); window = null; } });
    },
    async dispose() {
      retire(); await teardown;
      ipcMain.removeHandler('usb-host-bind'); ipcMain.removeHandler('usb-host-request'); app.removeListener('will-quit', quit);
    }
  };
}
module.exports = { installUsbHost };
