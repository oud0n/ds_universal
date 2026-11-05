// 開発サーバーと、試験用プロファイルの Chrome を起動してから実行する。
// E2E_CDP_PORT=9222 E2E_URL=http://127.0.0.1:5173/ node e2e/lap-playback.mjs
// 一時 GPX とメモリ内の保管場所だけを使う。電子版の実際の保管場所には接続しない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Page } from './cdp.mjs';

const url = new URL(process.env.E2E_URL ?? 'http://127.0.0.1:5173/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'ローカルの開発サーバーを指定してください');
const port = Number(process.env.E2E_CDP_PORT);
assert.ok(port > 0, '試験用 Chrome の E2E_CDP_PORT を指定してください');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laploupe-playback-'));
const outDir = fileURLToPath(new URL('./out/lap-playback/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

/** 同梱コースの計測線を各周 1 回横切る。走行の始めと最初の周の始めは異なる。 */
function writeRun(index) {
  const gate = fs.readFileSync(new URL('../courses/ControlLine/sodegaura.cln', import.meta.url), 'utf8').trim().split(/\s+/).map(Number);
  const [, latA, lonA, latB, lonB] = gate;
  const lat = (latA + latB) / 2, lon = (lonA + lonB) / 2;
  const lonMeters = 111320 * Math.cos(lat * Math.PI / 180);
  const dx = (lonB - lonA) * lonMeters, dy = (latB - latA) * 111320;
  const len = Math.hypot(dx, dy);
  const period = 40 + index;
  const points = Array.from({ length: period * 5 }, (_, sec) => {
    const theta = 0.4 + sec * 2 * Math.PI / period;
    const along = 75 * (1 - Math.cos(theta)), across = 55 * Math.sin(theta);
    const x = (along * dx - across * dy) / len, y = (along * dy + across * dx) / len;
    const time = new Date(Date.UTC(2025, 0, 1) + sec * 1000).toISOString();
    return `<trkpt lat="${lat + y / 111320}" lon="${lon + x / lonMeters}"><time>${time}</time></trkpt>`;
  });
  const file = path.join(fixtureDir, `run-${index}.gpx`);
  fs.writeFileSync(file, `<gpx version="1.1" creator="test"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`);
  return file;
}

async function pressStep(p, lapSec) {
  for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', {
    type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39
  });
  await p.waitFor(`Math.abs(window.__laploupe.lapTimeSec - ${lapSec}) < 0.001`, 5000, 'コマ送り');
}

/** 偽の保管場所の 1 周。走行を実際に読むところで止め、選択画面を閉じてから応答する。 */
async function installDelayedStore(p) {
  await p.ev(`(async () => {
    const { courseForFolder } = await import('/src/services/lapHistory.ts');
    const { courseHash } = await import('/src/services/lapIndex.ts');
    const course = await courseForFolder('sodegaura');
    const index = { version:1, courseHash:courseHash(course), courseName:course.name, hidden:[],
      files:{ 'delayed.bon4':{ size:8,mtimeMs:30,startMs:100,laps:[
        {n:1,time:40,startMs:100,sectors:[],topSpeed:100}
      ] } } };
    window.electronAPI = { laps:{
      getFolder:async () => 'synthetic',
      list:async () => ({success:true,files:[{path:'sodegaura/delayed.bon4',size:8,mtimeMs:30,local:true}]}),
      readText:async path => ({success:true,text:path.endsWith('laptimes.json') ? JSON.stringify(index) : null}),
      read:() => new Promise(resolve => { window.finishDelayedRead = () => resolve({success:true,data:new Uint8Array(8)}); }),
      writeText:async () => ({success:true})
    }};
  })()`);
}

async function exercise(width, height, files) {
  const p = await Page.connect(port, { newTab: true, label: String(width), outDir });
  try {
    const version = await p.send('Browser.getVersion');
    assert.ok(!/Electron/i.test(version.result.userAgent + version.result.product), '試験用 Chrome だけを使います');
    await p.viewport(width, height, width < 1000);
    await p.goto(url.href);
    await p.waitFor("window.__laploupe && document.querySelector('[data-testid=log-file-input]')", 15000, 'アプリの起動');
    await p.ev("import('/src/utils/i18n.ts').then(m => m.setLang('en'))");
    await p.setFiles('[data-testid="log-file-input"]', files);
    await p.waitFor('window.__laploupe?.sessions.length === 4 && window.__laploupe.screen === "analysis"');
    const first = await p.state();
    assert.ok(first.baseLap.startTime > 5 && !first.baseLap.isWholeSession);
    await pressStep(p, first.lapTimeSec + 0.1);
    await pressStep(p, first.lapTimeSec + 0.2);
    await p.ev(`(() => {
      const input = document.querySelector('input[aria-label="Playback position"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, '7');
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await p.waitFor('Math.abs(window.__laploupe.lapTimeSec - 7) < 0.001');
    await pressStep(p, 7.1);
    await pressStep(p, 7.2);
    const beforeVideo = await p.state();
    await p.ev("window.__laploupe.go('video')");
    await p.waitFor("window.__laploupe.screen === 'video'");
    assert.ok(Math.abs((await p.state()).sessionTimeSec - beforeVideo.sessionTimeSec) < 0.001);
    await p.ev("window.__laploupe.go('analysis')");
    await p.waitFor("window.__laploupe.screen === 'analysis'");
    assert.ok(Math.abs((await p.state()).lapTimeSec - 7.2) < 0.001);

    // 同じ Session の後の周を外して前の周が基準になっても、周の終わりへ飛ばない。
    const pair=await p.ev(`(()=>{const s=window.__laploupe.analysisSnapshot().sessions[0],laps=s.laps.filter(l=>!l.isWholeSession&&!l.isPartialLap);return {id:s.id,early:laps[0].lapNumber,late:laps.at(-1).lapNumber};})()`);
    await p.ev(`window.__laploupe.selectCar(0,${JSON.stringify(pair.id)},${pair.late});window.__laploupe.selectCar(1,${JSON.stringify(pair.id)},${pair.early})`);
    await p.click('toggle-data-drawer');
    await p.ev("document.querySelector('button[title^=\"Unassign Car 1 \"]').click()");
    await p.waitFor(`window.__laploupe.cars[0].slot===1 && window.__laploupe.baseLap.lapNumber===${pair.early}`);
    assert.ok(Math.abs((await p.state()).lapTimeSec)<0.001,'cleared base starts new lap at zero');
    await p.ev(`window.__laploupe.selectCar(0,${JSON.stringify(pair.id)},${pair.late})`);
    const beforeClear=(await p.state()).sessionTimeSec;
    await p.ev("document.querySelector('button[title^=\"Unassign Car 2 \"]').click()");
    assert.equal((await p.state()).sessionTimeSec,beforeClear,'clearing non-base retains playhead');
    await p.ev("[...document.querySelectorAll('button[title^=\"Unassign Car \"]')].forEach(b=>b.click())");
    for(const car of first.cars)await p.ev(`window.__laploupe.selectCar(${car.slot},${JSON.stringify(car.sessionId)},${car.lapNumber})`);
    await p.click('data-drawer-close');

    await installDelayedStore(p);
    await p.click('open-lap-picker');
    await p.waitFor("document.querySelector('[data-testid=lap-picker-row]')");
    await p.shot('picker');
    const pick = `(name, slot, lap) => {
      const rows = [...document.querySelectorAll('[data-testid=lap-picker-row]')];
      let run = '';
      for (const row of rows) {
        const header = row.parentElement.querySelector('p');
        if (header) run = header.title;
        if (run.includes(name) && row.firstElementChild.textContent === 'L' + lap)
          return row.querySelector('[data-slot="' + slot + '"]');
      }
      throw Error('Missing lap: '+name+'/'+lap);
    }`;
    // どちらも未割り当て。最初の割り当てで閉じた走行を続けて押しても、一覧を壊さない。
    await p.ev(`(() => { const pick = ${pick}; const a = pick('run-2',2,1), b = pick('run-3',3,1); a.click(); b.click(); })()`);
    await p.waitFor("window.__laploupe.sessions.length === 3 && document.querySelector('[role=dialog] [role=alert]')");
    assert.deepEqual((await p.state()).cars.map(c => c.slot), [0, 1, 2]);
    await p.ev(`(${pick})('run-2',0,1).click()`);
    const targetId = first.sessions.find(s => s.fileName.includes('run-2')).id;
    await p.waitFor(`window.__laploupe.cars.find(c=>c.slot===0)?.sessionId === ${JSON.stringify(targetId)}`);
    const replaced = await p.state();
    assert.equal(replaced.cars.find(c => c.slot === 2).sessionId, targetId);
    assert.ok(Math.abs(replaced.sessionTimeSec - replaced.baseLap.startTime) < 0.001);
    await p.clickText('Stored runs');
    await p.waitFor("document.querySelector('[data-testid=lap-picker-row]')");
    await p.ev("document.querySelector('[data-testid=lap-picker-row] [data-slot=\"3\"]').click()");
    await p.waitFor("typeof window.finishDelayedRead === 'function'");
    await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click(); window.finishDelayedRead()");
    await p.waitFor("!document.querySelector('[data-testid=lap-picker-rows]')");
    assert.deepEqual((await p.state()).cars, replaced.cars);
    // 保存した比べ方で Car 2 だけを基準にしても、動画の自動比較は基準車を奪わない。
    await p.ev('window.electronAPI = undefined');
    const comparison = path.join(fixtureDir, `comparison-${width}.lapsession.json`);
    fs.writeFileSync(comparison, JSON.stringify({version:1,name:'non-first base',createdAt:'2025-01-01T00:00:00Z',source:'files',cars:[{slot:1,run:'run-2.gpx',lap:1}]}));
    await p.click('toggle-data-drawer');
    await p.setFiles('[data-testid=session-import-input]', [comparison]);
    await p.waitFor('window.__laploupe.cars.length === 1 && window.__laploupe.cars[0].slot === 1');
    assert.ok(Math.abs((await p.state()).sessionTimeSec - (await p.state()).baseLap.startTime) < 0.001);
    await p.click('data-drawer-close');
    await p.ev("window.__laploupe.go('video')");
    await p.waitFor("document.querySelector('[data-testid=video-mode-compare]:not(:disabled)')");
    await p.click('video-mode-compare');
    await p.waitFor('window.__laploupe.cars.length === 2');
    assert.deepEqual((await p.state()).cars.map(c=>c.slot), [1,2]);
    assert.equal((await p.state()).cars[0].lapNumber,1);
    assert.deepEqual(p.errors, []);
    console.log(`PASS ${width}×${height} 選択・切り替え・シーク・閉じた後の読み取り`);
  } finally {
    await p.close();
  }
}

try {
  const files = [0, 1, 2, 3].map(writeRun);
  for (const [width, height] of [[375, 812], [951, 669], [1280, 800]]) await exercise(width, height, files);
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
