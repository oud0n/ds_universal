// 任意のPlaywright環境を使う。製品の依存関係には追加しない。
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs E2E_URL=http://127.0.0.1:5368/ node e2e/desktop-ui-browsers.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { firefox, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const url = new URL(process.env.E2E_URL ?? 'http://127.0.0.1:5173/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
const outDir = fileURLToPath(new URL('./out/desktop-ui-browsers/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

for (const [name, engine] of Object.entries({ firefox, webkit })) {
  if (process.env.E2E_BROWSERS && !process.env.E2E_BROWSERS.split(',').includes(name)) continue;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url.href);
    await page.waitForFunction(() => !!window.__laploupe);
    await page.evaluate(async () => {
      const data = await (await fetch('/demo/sodegaura_20260815.nmea')).arrayBuffer();
      await window.__laploupe.loadFiles([new File([data], 'demo.nmea')]);
      const session = window.__laploupe.analysisSnapshot().sessions[0];
      await window.__laploupe.selectCar(1, session.id, session.laps[2].lapNumber);
    });
    for (const lang of ['ja', 'en']) {
      for (const theme of ['light', 'dark', 'contrast']) {
        await page.evaluate(async ({ lang, theme }) => {
          (await import('/src/utils/i18n.ts')).setLang(lang);
          (await import('/src/utils/theme.ts')).setThemeSetting(theme);
        }, { lang, theme });
        await page.waitForTimeout(200);
        const layout = await page.evaluate(() => {
          const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
          const bar = document.querySelector('[data-testid="play-bar"]');
          const controls = [...document.querySelectorAll('[data-testid="app-header"] button, [data-testid="sidebar"] button, [data-testid="play-bar"] button')].filter(visible);
          return {
            cars: window.__laploupe.cars.length,
            sidebar: !!document.querySelector('[data-testid="sidebar"]'),
            overflow: document.documentElement.scrollWidth > innerWidth,
            outside: controls.filter(el => { const r=el.getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > innerWidth+1 || r.bottom > innerHeight+1; }).map(el => el.textContent),
            barHeight: bar.getBoundingClientRect().height
          };
        });
        assert.ok(layout.sidebar && !layout.overflow && layout.barHeight < 65, JSON.stringify(layout));
        assert.equal(layout.cars, 2);
        assert.deepEqual(layout.outside, []);
        await page.screenshot({ path: `${outDir}/${name}-1024-${lang}-${theme}.png` });
      }
    }
    await page.getByTestId('open-lap-picker').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId('toggle-data-drawer').click();
    await page.getByTestId('nav-video').click();
    await page.waitForFunction(() => window.__laploupe.screen === 'video');
    assert.equal(await page.getByTestId('data-drawer').count(), 0);
    await page.getByTestId('nav-analysis').click();
    await page.getByTestId('play-bar').getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => window.__laploupe.isPlaying && window.__laploupe.lapTimeSec > 0.1);
    await page.getByTestId('play-bar').getByRole('button', { name: 'Pause', exact: true }).click();
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement, cs = getComputedStyle(el);
      return { tag: el.tagName, visible: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 };
    });
    assert.ok(focus.visible, JSON.stringify(focus));
    await page.setViewportSize({ width:1440, height:900 });
    await page.evaluate(async () => (await import('/src/utils/theme.ts')).setThemeSetting('light'));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${outDir}/${name}-1440-en-light.png` });
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}: Japanese/English, 3 themes, 1024/1440px, picker/drawer/navigation/playback/focus`);
  } finally { await browser.close(); }
}
