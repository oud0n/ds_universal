/**
 * 動画の「比べる」のカクつきを、iPhone の実機で自動で測る (BUG-32、2026-10-23)。
 *
 * 用意:
 *  1. Mac で開発サーバー: npx vite --host 0.0.0.0 --port 5192 --strictPort
 *  2. iPhone のアプリを、その開発サーバーを読む形で入れる (xcodebuild ... DS_WEB_URL=http://<Mac の IP>:5192/)
 *  3. pymobiledevice3 webinspector cdp --port 9240 (アプリの WKWebView に CDP でつなぐ。1 つだけつなげる)
 *  4. アプリの保管場所に、8/15 と 9/18 の袖ヶ浦の走行 (動画つき) があること
 *
 * 使い方: node e2e/ios_compare_trace.mjs [秒数=60] [query (例 clock=app)] [ラベル]
 * 画面を読み込み直し、8/15 を動画つきで開き、9/18 を Car 2 に入れて「比べる」で再生し、
 * 動画ごとのコマの止まり (0.1 秒超)・速さの変更・位置の移動を出す。記録は e2e/out/ に置く。
 * アプリのコードは変えず、ios_trace_inject.js をページに入れて <video> の操作とコマを記録する
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Page, sleep } from './cdp.mjs';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const DIR = new URL('.', import.meta.url).pathname;
const OUT = DIR + 'out/';
mkdirSync(OUT, { recursive: true });
const dur = Number(process.argv[2] ?? 60), query = process.argv[3] ?? '', label = process.argv[4] ?? 'auto';
const ip = process.env.IOS_WEB_HOST ?? execSync('ipconfig getifaddr en0').toString().trim();
const base = `http://${ip}:5192/`;
let p = await Page.connect(9240, { urlPart: '5192', outDir: OUT, label });
await p.ev(`location.href = ${JSON.stringify(`${base}?t=${Date.now()}${query ? '&' + query : ''}`)}`);
await sleep(4000);
p = await Page.connect(9240, { urlPart: '5192', outDir: OUT, label });
await p.waitFor(`document.querySelector('[data-testid="nav-library"]')`, 30000, '起動');
async function openRun(date, how) {
  await p.click('nav-library');
  await p.waitFor(`document.querySelectorAll('[data-testid="run-row"]').length > 0`, 30000, '走行の一覧');
  const ok = await p.ev(`(()=>{const r=[...document.querySelectorAll('[data-testid="run-row"]')].find(r=>r.innerText.includes(${JSON.stringify(date)})); r?.click(); return !!r})()`);
  if (!ok) throw new Error('走行がない: ' + date);
  await p.waitFor(`document.querySelector('[data-testid="${how}"]')`, 10000, how);
  await p.click(how);
  await p.waitFor(`!document.querySelector('[data-testid="${how}"]')`, 60000, '開き終わる');
  await sleep(how === 'run-open-video' ? 6000 : 4000);
}
await openRun('8/15', 'run-open-video');
await openRun('9/18', 'run-add-car2');
await p.click('nav-video');
await sleep(1500);
await p.click('video-mode-compare');
await sleep(5000);
await p.ev(readFileSync(DIR + 'ios_trace_inject.js', 'utf8'));
const setup = await p.ev(`JSON.stringify({ cars: window.__laploupe?.cars, videos: [...document.querySelectorAll('video')].map(v => decodeURIComponent((v.getAttribute('src')||'').split('/').pop()).slice(-30) + (v.muted ? ' (muted)' : ' (sound)')) })`);
console.log('setup', setup);
const btn = names => `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.offsetParent!==null&&${JSON.stringify(names)}.includes(b.title||b.getAttribute('aria-label'))); b?.click(); return !!b})()`;
const play = btn(['再生', 'Play']);
if (!(await p.ev(play))) throw new Error('再生ボタンがない');
await sleep(dur * 1000);
await p.ev(btn(['一時停止', 'Pause']));
await sleep(500);
const raw = await p.ev(`JSON.stringify(window.__trace)`);
const file = `${OUT}${label}-${Date.now()}.json`;
writeFileSync(file, raw);
// まとめ: 再生していた間の、動画ごとのコマの止まり (0.1 秒超)・速さの変更・位置の移動
const T = JSON.parse(raw), ev = T.ev;
const t0 = ev.find(e => e.k === 'play')?.t ?? T.t0, t1 = [...ev].reverse().find(e => e.k === 'pause')?.t ?? Infinity;
const inPlay = e => e.t >= t0 + 1500 && e.t <= t1; // 再生の始めの 1.5 秒は除く
const out = { label, query, durSec: dur, file, videos: [] };
for (const id of [...new Set(ev.filter(e => e.k === 'frame').map(e => e.id))]) {
  const fr = ev.filter(e => e.k === 'frame' && e.id === id && inPlay(e));
  if (fr.length < 10) continue;
  const stalls = [];
  for (let i = 1; i < fr.length; i++) {
    const g = fr[i].t - fr[i - 1].t;
    // 周の始めへ戻した (動画の位置が大きく戻った) ところは数えない
    if (g > 100 && fr[i].v >= fr[i - 1].v - 1) stalls.push({ at: +((fr[i - 1].t - t0) / 1000).toFixed(1), ms: Math.round(g) });
  }
  out.videos.push({
    id, file: fr[0].f, muted: fr.at(-1).m, frames: fr.length,
    stalls: stalls.length, stallMs: stalls.reduce((a, s) => a + s.ms, 0), stallList: stalls,
    rateSets: ev.filter(e => e.id === id && e.k === 'rate' && inPlay(e)).length,
    seeks: ev.filter(e => e.id === id && e.k === 'seek' && inPlay(e)).length
  });
}
out.jank = ev.filter(e => e.k === 'jank' && inPlay(e)).map(e => Math.round(e.v));
console.log(JSON.stringify(out, null, 1));
process.exit(0);
