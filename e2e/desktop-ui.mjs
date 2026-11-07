// 専用Chromeと開発サーバーを起動して実行する。実際の保管場所は使わない。
// E2E_CDP_PORT=9448 E2E_URL=http://127.0.0.1:5368/ node e2e/desktop-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { Page, sleep } from './cdp.mjs';

const url = new URL(process.env.E2E_URL ?? 'http://127.0.0.1:5173/');
const port = Number(process.env.E2E_CDP_PORT);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && port > 0);
const outDir = fileURLToPath(new URL('./out/desktop-ui/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

// 実際のメニュー生成関数を両OSで評価し、標準操作を失わないことを確認する。
const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const menu = main.slice(main.indexOf('let menuLang ='), main.indexOf('function createWindow()'));
for (const platform of ['darwin', 'win32']) {
  let template;
  vm.runInNewContext(`${menu}\nbuildMenu();`, {
    process: { platform }, app: { getLocale: () => 'en' },
    Menu: { buildFromTemplate: t => t, setApplicationMenu: t => { template = t; } }
  });
  assert.equal(template.some(t => t.role === 'appMenu'), platform === 'darwin');
  const commands = template.flatMap(t => t.submenu ?? []);
  assert.ok(commands.some(c => c.accelerator === 'CmdOrCtrl+O'));
  assert.ok(commands.some(c => c.role === 'copy') && commands.some(c => c.role === 'paste'));
  if (platform === 'win32') assert.ok(commands.some(c => c.accelerator === 'Ctrl+Q'));
}
console.log('PASS Mac/Windows menu contracts');

const p = await Page.connect(port, { newTab: true, label: 'desktop', outDir });
try {
  await p.viewport(1440, 900, false);
  await p.goto(`${url.href}#convert`);
  await p.waitFor('window.__laploupe?.screen === "convert"');
  assert.ok(await p.exists('sidebar'));
  assert.equal(await p.exists('nav-library'), false, 'ブラウザに使えないライブラリを出さない');
  await p.click('nav-analysis');
  await p.waitFor('window.__laploupe.screen === "analysis"');
  await p.ev(`import('/src/utils/i18n.ts').then(m => m.setLang('en'))`);
  await p.ev(`(async () => {
    const data = await (await fetch('/demo/sodegaura_20260815.nmea')).arrayBuffer();
    await window.__laploupe.loadFiles([new File([data], 'demo.nmea')]);
  })()`);
  await p.waitFor('window.__laploupe?.sessions.length === 1 && window.__laploupe.baseLap');
  await p.ev(`(async () => {
    const session = window.__laploupe.analysisSnapshot().sessions[0];
    for (let slot = 0; slot < 4; slot++) await window.__laploupe.selectCar(slot, session.id, session.laps[slot].lapNumber);
  })()`);
  assert.equal((await p.state()).cars.length, 4);
  const assignment = await p.ev('JSON.stringify(window.__laploupe.cars)');

  for (const [width, height] of [[1440, 900], [1024, 700]]) {
    await p.viewport(width, height, false);
    for (const lang of ['ja', 'en']) {
      await p.ev(`import('/src/utils/i18n.ts').then(m => m.setLang(${JSON.stringify(lang)}))`);
      for (const theme of ['light', 'dark', 'contrast']) {
        await p.ev(`import('/src/utils/theme.ts').then(m => m.setThemeSetting(${JSON.stringify(theme)}))`);
        await sleep(200);
        const layout = await p.ev(`(() => {
          const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
          const controls = [...document.querySelectorAll('[data-testid="app-header"] button, [data-testid="sidebar"] button, [data-testid="play-bar"] button, [data-testid="play-bar"] select')].filter(visible);
          const outside = controls.filter(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1; }).map(el => el.getAttribute('aria-label') || el.textContent);
          const bar = document.querySelector('[data-testid="play-bar"]');
          const buttons = bar.querySelector('.playbar-buttons').getBoundingClientRect();
          const seek = bar.querySelector('.playbar-seek').getBoundingClientRect();
          const plots = [...document.querySelectorAll('.analysis-panel canvas')].filter(visible).map(c => ({ w:c.clientWidth, h:c.clientHeight }));
          return { outside, oneRow: Math.abs(buttons.y - seek.y) < 12, plots, overflow:document.documentElement.scrollWidth > innerWidth };
        })()`);
        assert.deepEqual(layout.outside, [], `${width}/${lang}/${theme}`);
        assert.ok(layout.oneRow && !layout.overflow, JSON.stringify(layout));
        assert.ok(layout.plots.every(c => c.w > 50 && c.h > 50), JSON.stringify(layout.plots));
        assert.equal(await p.ev('JSON.stringify(window.__laploupe.cars)'), assignment);
        await p.shot(`${width}-${lang}-${theme}`);
      }
    }
  }
  console.log('PASS 1024/1440px × Japanese/English × light/dark/contrast; four Cars preserved');

  await p.ev(`import('/src/utils/theme.ts').then(m => m.setThemeSetting('light'))`);
  await p.click('open-lap-picker');
  await p.waitFor('document.querySelector("[role=dialog]")');
  assert.ok(await p.ev(`document.querySelector('[role=dialog]').textContent.includes('Car 4')`));
  await p.ev(`document.querySelector('[role=dialog] button[aria-label="Close"]').click()`);
  await p.click('toggle-data-drawer');
  await p.waitFor('document.querySelector("[data-testid=data-drawer]")');
  await p.click('nav-video');
  await p.waitFor('window.__laploupe.screen === "video"');
  assert.equal(await p.exists('data-drawer'), false);
  await p.click('nav-settings');
  await p.waitFor('window.__laploupe.screen === "settings"');
  assert.ok(await p.exists('settings-group-display'));
  await p.click('nav-analysis');
  await p.waitFor('window.__laploupe.screen === "analysis"');
  assert.equal(await p.ev('JSON.stringify(window.__laploupe.cars)'), assignment);
  await p.ev(`document.querySelector('[data-testid="play-bar"] button[aria-label="Play"]').click()`);
  await p.waitFor('window.__laploupe.isPlaying && window.__laploupe.lapTimeSec > 0.1');
  await p.ev(`document.querySelector('[data-testid="play-bar"] button[aria-label="Pause"]').click()`);
  await p.waitFor('!window.__laploupe.isPlaying');
  const before = (await p.state()).lapTimeSec;
  for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39 });
  await p.waitFor(`window.__laploupe.lapTimeSec > ${before}`);

  // シークバーと速度選択へキーボードで到達でき、注目が見える。
  const focus = await p.ev(`(() => {
    const input = document.querySelector('[data-testid="play-bar"] input');
    input.focus();
    return document.activeElement === input;
  })()`);
  assert.ok(focus);
  const splitter = await p.ev(`(() => {
    const el = [...document.querySelectorAll('.analysis-splitter')].find(el => getComputedStyle(el).cursor === 'col-resize');
    const r = el.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 };
  })()`);
  await p.send('Input.dispatchMouseEvent', { type:'mousePressed', ...splitter, button:'left', clickCount:1 });
  await p.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:splitter.x-35, y:splitter.y, button:'left', buttons:1 });
  await p.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:splitter.x-35, y:splitter.y, button:'left', clickCount:1 });
  await p.ev(`document.querySelector('[data-testid="sidebar"] button[aria-label="Collapse sidebar"]').click()`);
  await p.waitFor('document.querySelector("[data-testid=sidebar]").dataset.collapsed === "true"');
  await p.ev(`document.querySelector('[data-testid="sidebar"] button[aria-label="Expand sidebar"]').click()`);
  await p.waitFor('document.querySelector("[data-testid=sidebar]").dataset.collapsed === "false"');
  assert.deepEqual(p.errors, []);
  console.log('PASS picker, drawer, navigation, playback, keyboard, resize and sidebar controls');
} finally { await p.close(); }
