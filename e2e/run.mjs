// 画面の通しの試験を回す (2026-10-21)。
//
// 使い方:
//   1. 開発サーバー (npm run dev -- --port 5183)
//   2. デスクトップ版を、保管場所の写しで、DevTools の口を開けて起こす:
//      ELECTRON_START_URL=http://localhost:5183/ npx electron . --user-data-dir=<試験用> --remote-debugging-port=9333
//      (<試験用>/lap-folder.json に {"folder": "<保管場所の写し>"}。本物の保管場所は使わない: 周を隠すなどで書き換えるため)
//   3. 画面のない Chrome を --remote-debugging-port=9222 で
//   4. node e2e/run.mjs [--only 名前の一部] [--electron 9333] [--chrome 9222]
//      (開発サーバーが 5183 でないときは E2E_APP=http://localhost:5184/ を付ける)
//
// 失敗した場面は、e2e/out/ にスクリーンショットを残す。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Page } from './cdp.mjs';
import { journeys, APP } from './journeys.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const only = opt('only', null);
const electronPort = Number(opt('electron', 9333));
const chromePort = Number(opt('chrome', 9222));
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(outDir, { recursive: true });

const list = journeys.filter(j => !only || j.name.includes(only));
let failed = 0;
for (const [i, j] of list.entries()) {
  const label = `${String(i + 1).padStart(2, '0')}`;
  let p;
  const t0 = Date.now();
  try {
    p = j.target === 'electron'
      ? await Page.connect(electronPort, { urlPart: new URL(APP).host, outDir, label })
      : await Page.connect(chromePort, { newTab: true, outDir, label });
    // Mac の外観 (朝はライトになる設定など) で色が変わらないよう、ダークに固定する (地図の線を色で探す試験があるため)
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }).catch(() => {});
    await j.run(p);
    const errs = p.errors.filter(e => !/Electron Security Warning|Download the React DevTools/.test(e));
    if (errs.length) throw new Error(`画面でエラー: ${errs[0]}`);
    console.log(`✓ ${label} ${j.name} (${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
    for (const n of p.notes) console.log(`    ・${n}`);
  } catch (e) {
    failed++;
    let shot = '';
    try { shot = p ? await p.shot('fail') : ''; } catch { /* 撮れない */ }
    console.log(`✗ ${label} ${j.name}\n    ${e instanceof Error ? e.message : e}${shot ? `\n    ${shot}` : ''}`);
  } finally {
    await p?.close().catch(() => {});
  }
}
console.log(`\n${list.length - failed} / ${list.length} 通った`);
process.exit(failed ? 1 : 0);
