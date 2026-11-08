import { desktopUsbTransport } from '../../src/services/deviceHost/electronHost';
import { DigSpiceDevice } from '../../src/services/digspiceDevice';

declare global { interface Window { usbHostProof: Promise<unknown>; usbHostOpened: Promise<boolean> } }
let opened!: (value: boolean) => void;
window.usbHostOpened = new Promise(resolve => { opened = resolve; });
// この実証ではWeb Serialを使ったら、その時点で失敗させる。
Object.defineProperty(navigator, 'serial', { get() { throw new Error('Web Serial was used'); } });
window.usbHostProof = (async () => {
  const transport = await desktopUsbTransport();
  if (!transport) throw new Error('Native USB host was not selected');
  const device = new DigSpiceDevice();
  await device.connect(transport); opened(true);
  if (new URLSearchParams(location.search).has('hold')) await new Promise(() => {});
  try {
    const config = await device.getDeviceConfig();
    const download = await device.downloadLogs();
    return { config, buffer: Array.from(download.buffer) };
  } finally { await device.disconnect(); }
})();
window.usbHostProof.catch(() => {});
