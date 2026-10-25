// 画面の通しの試験の場面 (2026-10-21)。
// electron: デスクトップ版を、保管場所の写し (e2e の実データ) で動かす。phone: Chrome をスマートフォンの幅にし、アプリのふり (?native=mock) で動かす。
// どの場面も、操作のあとで「つじつま」(開いた走行が Car 1・動画の位置がログの時刻と合う など) を確かめる。

import { check, sleep } from './cdp.mjs';
import { sweepLayout } from './layout.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 開発サーバーの場所 (別の口で動かしているときは E2E_APP で替える)
export const APP = process.env.E2E_APP ?? 'http://localhost:5183/';
/** スマートフォンの試験で読み込むログ (読むだけ。E2E_SAMPLE_NMEA で替えられる) */
const SAMPLE_NMEA = process.env.E2E_SAMPLE_NMEA ?? `${os.homedir()}/Library/Mobile Documents/com~apple~CloudDocs/LapLoupe/nikko/20260830/20260830095701.nmea`;

/** 走行の画面から、日付 (例 '8/30') の走行を開く。how: 'run-open-analysis' | 'run-open-video' | 'run-add-car2' */
async function openRun(p, date, how) {
  await p.click('nav-library');
  await p.waitFor(`document.querySelectorAll('[data-testid="run-row"]').length > 0`, 20000, '走行の一覧');
  const ok = await p.ev(`(()=>{const r=[...document.querySelectorAll('[data-testid="run-row"]')].find(r=>r.innerText.includes(${JSON.stringify(date)})); r?.click(); return !!r})()`);
  check(ok, `走行 ${date} が一覧にない`);
  await p.waitFor(`document.querySelector('[data-testid="${how}"]')`, 5000, `走行の詳細の ${how}`);
  await p.click(how);
  // 開き終わる (動画を見るなら動画が出る) まで待つ
  await p.waitFor(`!document.querySelector('[data-testid="run-open-analysis"]')`, 30000, '走行を開き終わる');
  await sleep(how === 'run-open-video' ? 6000 : 3000);
}

/** 今の Car 1 の走行の名前 */
async function car1Name(p) {
  const s = await p.state();
  const c = s.cars.find(c => c.slot === 0);
  return s.sessions.find(x => x.id === c?.sessionId)?.fileName ?? null;
}

/** 動画の位置が、ログの時刻 − 同期のずれ と合っているか (止めた状態で) */
async function checkVideoSync(p, where) {
  await p.ev(`document.querySelectorAll('video').forEach(v => v.pause())`);
  // 見えている動画で確かめる (解析の画面の左下にも車載動画の窓がある。PLAN-28 でアニメの窓を外したので、いつも出ている)
  await sleep(1200);
  const s = await p.state();
  const v = await p.ev(`(()=>{const v=[...document.querySelectorAll('video')].find(x=>x.offsetParent!==null) ?? document.querySelector('video'); return v ? { t: v.currentTime, src: decodeURIComponent(v.currentSrc || v.src), dur: v.duration } : null})()`);
  check(v, `${where}: 動画が出ていない`);
  const main = s.videos.find(x => v.src.endsWith(x.fileName));
  check(main, `${where}: 出ている動画 ${v.src} が同期の一覧にない`);
  check(main.isPlaced, `${where}: 動画 ${main.fileName} がログの時刻に置けていない`);
  const sessionTime = s.clockBase === 'lap' && s.baseLap ? s.baseLap.startTime + s.currentTimeSec : s.currentTimeSec;
  const expected = sessionTime - main.syncOffsetSec;
  // 動画の外 (始まる前・終わったあと) は、端に寄っていればよい
  const clamped = Math.max(0, Math.min(v.dur || expected, expected));
  check(Math.abs(v.t - clamped) < 0.6, `${where}: 動画の位置 ${v.t.toFixed(2)} 秒が、ログの時刻からの位置 ${clamped.toFixed(2)} 秒と合わない (ログ ${sessionTime.toFixed(2)} 秒・ずれ ${main.syncOffsetSec.toFixed(2)} 秒・基準 ${s.clockBase})`);
}

/** 周の表示 (L◯) にしているときは、今の位置がその周の中にあるか (表示は周の時刻なのに、位置が周の外のままにならないか) */
async function checkInsideLap(p, where) {
  const s = await p.state();
  check(s.baseLap, `${where}: 周が選ばれていない`);
  const sessionTime = s.clockBase === 'lap' ? s.baseLap.startTime + s.currentTimeSec : s.currentTimeSec;
  const { startTime, lapTime, lapNumber } = s.baseLap;
  check(sessionTime >= startTime - 0.2 && sessionTime <= startTime + lapTime + 0.2,
    `${where}: L${lapNumber} を出しているのに、今の位置 ${sessionTime.toFixed(1)} 秒が周 (${startTime.toFixed(1)}〜${(startTime + lapTime).toFixed(1)} 秒) の外`);
}

/** シークバー (いちばん下の range) を割合で動かす */
async function seekRatio(p, ratio) {
  await p.ev(`(()=>{const r=[...document.querySelectorAll('input[type=range]')].pop(); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(r, String(+r.max*${ratio})); r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(1500);
}

export const journeys = [
  {
    name: '走行を開くと Car 1 になる (別のコースの Car とログは外れ、同じコースのログは残る)',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      await openRun(p, '10/12', 'run-open-analysis');
      check((await car1Name(p))?.includes('20261012'), `TC2000 を開いたのに Car 1 が ${await car1Name(p)}`);
      await openRun(p, '8/30', 'run-open-video');
      const s = await p.state();
      check((await car1Name(p))?.includes('20260830'), `日光を開いたのに Car 1 が ${await car1Name(p)}`);
      const others = s.cars.filter(c => c.slot !== 0).map(c => s.sessions.find(x => x.id === c.sessionId)?.circuitName);
      const c1 = s.sessions.find(x => x.id === s.cars.find(c => c.slot === 0).sessionId).circuitName;
      check(others.every(n => n === c1), `別のコースの Car が残っている: ${others.join(', ')}`);
      check(s.screen === 'video', `動画を見るで開いたのに画面が ${s.screen}`);
      // 違うコースのログ (TC2000) は走行とコースから外れる
      check(s.sessions.every(x => x.circuitName === c1), `別のコースのログが残っている: ${s.sessions.map(x => x.circuitName).join(', ')}`);
      await checkVideoSync(p, '日光を開いた直後');
      // 同じコースの走行を続けて開くと、両方残り、あとから開いた方が Car 1
      await openRun(p, '9/18', 'run-open-analysis');
      await openRun(p, '8/15', 'run-open-analysis');
      const s2 = await p.state();
      check(s2.sessions.length === 2 && s2.sessions.every(x => /Sodegaura/.test(x.circuitName)), `袖ヶ浦の 2 つのログだけになっていない: ${s2.sessions.map(x => x.sessionName).join(', ')}`);
      check((await car1Name(p))?.includes('20260815'), `あとから開いた 8/15 が Car 1 でない: ${await car1Name(p)}`);
    }
  },
  {
    name: '走行の名前とメモ: 走行の画面で書くと一覧に出て、runs.json に入り、開いた走行の名前になる (ファイル名は変えない)',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      const root = await p.ev(`window.electronAPI.laps.getFolder()`);
      check(root && root.includes('scratchpad'), `保管場所が試験用の写しでない: ${root}`);
      const select = async () => {
        await p.click('nav-library');
        await p.waitFor(`document.querySelectorAll('[data-testid="run-row"]').length > 0`, 20000, '走行の一覧');
        await p.ev(`[...document.querySelectorAll('[data-testid="run-row"]')].find(r=>r.innerText.includes('9/13'))?.click()`);
        await p.waitFor(`document.querySelector('[data-testid="run-detail-name"]')`, 5000, '名前の欄');
      };
      // React の欄に書く (値を入れて input を起こし、離れて書かせる)
      const fill = (id, v) => p.ev(`(() => {
        const el = document.querySelector('[data-testid="${id}"]');
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        el.focus();
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.blur();
        // 窓が前面にないと blur の知らせが起きないので、離れた知らせをはっきり送る
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      })()`);
      await select();
      await fill('run-detail-name', 'e2e 新品タイヤ');
      await sleep(800);
      await fill('run-detail-note', 'e2e 晴れ 22℃');
      await p.waitFor(`[...document.querySelectorAll('[data-testid="run-row-note"]')].some(e => e.innerText.includes('e2e 晴れ'))`, 8000, '一覧のメモ');
      // 車種・タイヤ: 書くと一覧に出て、runs.json の行に入る。ほかの走行で書いたものが候補に出る
      await fill('run-detail-car', 'e2e ロードスター');
      await sleep(600);
      await fill('run-detail-tyre', 'e2e RE-71RS');
      await p.waitFor(`[...document.querySelectorAll('[data-testid="run-row-car-tyre"]')].some(e => e.innerText.includes('e2e ロードスター') && e.innerText.includes('e2e RE-71RS'))`, 8000, '一覧の車種・タイヤ');
      {
        const runsPath = path.join(root, 'sodegaura/runs.json');
        for (let i = 0; i < 40 && !fs.readFileSync(runsPath, 'utf8').includes('e2e RE-71RS'); i++) await sleep(200);
        const row = Object.entries(JSON.parse(fs.readFileSync(runsPath, 'utf8')).runs).find(([k]) => k.includes('20260913'))?.[1];
        check(row?.car === 'e2e ロードスター' && row?.tyre === 'e2e RE-71RS', `runs.json に車種・タイヤが入らない: ${JSON.stringify({ car: row?.car, tyre: row?.tyre })}`);
        check(await p.ev(`[...document.querySelectorAll('#run-tyre-choices option')].some(o => o.value === 'e2e RE-71RS')`), 'タイヤの候補に出ない');
      }
      await fill('run-detail-car', '');
      await sleep(600);
      await fill('run-detail-tyre', '');
      await p.waitFor(`![...document.querySelectorAll('[data-testid="run-row-car-tyre"]')].some(e => e.innerText.includes('e2e'))`, 8000, '車種・タイヤを消す');
      check(await p.ev(`[...document.querySelectorAll('[data-testid="run-row-name"]')].some(e => e.innerText === 'e2e 新品タイヤ')`), '一覧に名前が出ない');
      const runs = JSON.parse(fs.readFileSync(path.join(root, 'sodegaura/runs.json'), 'utf8')).runs;
      const row = Object.entries(runs).find(([k]) => k.includes('20260913'))?.[1];
      check(row?.name === 'e2e 新品タイヤ' && row?.note === 'e2e 晴れ 22℃', `runs.json に入っていない: ${JSON.stringify({ name: row?.name, note: row?.note })}`);
      check(fs.readdirSync(path.join(root, 'sodegaura/20260913')).some(f => f.startsWith('20260913') && f.endsWith('.nmea')), 'ログのファイル名が変わった');
      // 開くと、その名前の走行になり、メモも出る
      await p.click('run-open-analysis');
      await p.waitFor(`!document.querySelector('[data-testid="run-open-analysis"]')`, 30000, '走行を開き終わる');
      await sleep(2000);
      const s = await p.state();
      check(s.sessions.some(x => x.sessionName === 'e2e 新品タイヤ'), `開いた走行の名前が違う: ${s.sessions.map(x => x.sessionName).join(', ')}`);
      // 解析の「走行とコース」のメモからも書ける
      await p.click('nav-analysis');
      await sleep(800);
      if (!(await p.exists('session-note'))) await p.click('toggle-data-drawer');
      await p.waitFor(`document.querySelector('[data-testid="session-note"]')`, 8000, '走行とコースのメモ');
      check(await p.ev(`[...document.querySelectorAll('[data-testid="session-note"]')].some(e => e.value === 'e2e 晴れ 22℃')`), '走行とコースにメモが出ない');
      await p.ev(`(() => { const el = [...document.querySelectorAll('[data-testid="session-note"]')].find(e => e.value === 'e2e 晴れ 22℃'); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'e2e 雨'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); })()`);
      await sleep(1500);
      const row2 = Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'sodegaura/runs.json'), 'utf8')).runs).find(([k]) => k.includes('20260913'))?.[1];
      check(row2?.note === 'e2e 雨', `走行とコースのメモが runs.json に入らない: ${row2?.note}`);
      if (await p.exists('session-note')) await p.click('toggle-data-drawer');
      // ラップタイムの一覧にも、走行の名前が出る
      await p.click('nav-library');
      await p.waitFor(`document.querySelector('[data-testid="library-lap-history"]')`, 10000, 'ラップタイムのボタン');
      await p.click('library-lap-history');
      // コースの選択 (袖ヶ浦の選びがある select。unsorted/ が無い保管場所でも探せるように)
      await p.waitFor(`[...document.querySelectorAll('select')].some(x => x.offsetParent !== null && [...x.options].some(o => o.textContent.includes('袖ヶ浦')))`, 20000, 'ラップタイムのコースの選択');
      await p.ev(`(() => { const sel = [...document.querySelectorAll('select')].find(x => x.offsetParent !== null && [...x.options].some(o => o.textContent.includes('袖ヶ浦'))); const o = [...sel.options].find(o => o.textContent.includes('袖ヶ浦')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, o.value); sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await p.waitFor(`[...document.querySelectorAll('[data-testid="lap-history-run-name"]')].some(e => e.innerText === 'e2e 新品タイヤ')`, 20000, 'ラップタイムの一覧の名前');
      await p.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(500);
      // 参考ラップの印 (PLAN-31): 付けると自分の走行と分けて出し、runs.json に入る。ラップタイムの順位には数えない
      await select();
      await p.click('run-detail-reference');
      await p.waitFor(`document.querySelector('[data-testid="run-detail-ref-driver"]')`, 5000, '参考ラップの誰の欄');
      await fill('run-detail-ref-driver', 'e2e 速い人');
      // runs.json に誰が入るまで待つ (区切りのタブは走行があればいつも出るので、タブでは待てない)
      const runsPath3 = path.join(root, 'sodegaura/runs.json');
      for (let i = 0; i < 40 && !fs.readFileSync(runsPath3, 'utf8').includes('e2e 速い人'); i++) await sleep(200);
      const row3 = Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'sodegaura/runs.json'), 'utf8')).runs).find(([k]) => k.includes('20260913'))?.[1];
      check(row3?.reference?.driver === 'e2e 速い人', `参考ラップが runs.json に入らない: ${JSON.stringify(row3?.reference)}`);
      // 印を付けると参考ラップの側に切り替わる。自分の走行の側には出ない
      await p.click('library-owner-mine');
      await sleep(300);
      check(!(await p.ev(`[...document.querySelectorAll('[data-testid="run-row"]')].some(r => r.innerText.includes('9/13'))`)), '参考ラップが自分の走行の一覧に残っている');
      await p.click('library-owner-ref');
      await p.waitFor(`[...document.querySelectorAll('[data-testid="run-row-reference"]')].some(e => e.innerText.includes('e2e 速い人'))`, 5000, '参考ラップの一覧の印');
      await p.ev(`[...document.querySelectorAll('[data-testid="run-row"]')].find(r => r.innerText.includes('9/13'))?.click()`);
      await p.waitFor(`document.querySelector('[data-testid="run-detail-reference"]')`, 5000, '参考ラップの詳細');
      await p.click('run-detail-reference');
      // 印を外すと、自分の走行の一覧に戻り、9/13 がそこに出る (切り替えは走行があればいつも出る)
      await p.waitFor(`document.querySelector('[data-testid="library-owner-mine"]')?.className.includes('bg-sky-600') && [...document.querySelectorAll('[data-testid="run-row"]')].some(r => r.innerText.includes('9/13'))`, 8000, '参考ラップの印を外すと自分の走行に戻る');
      // 片付け (名前・メモを消す)
      await select();
      await fill('run-detail-name', '');
      await sleep(800);
      await fill('run-detail-note', '');
      await p.waitFor(`![...document.querySelectorAll('[data-testid="run-row-note"]')].some(e => e.innerText.includes('e2e'))`, 8000, 'メモが消える');
      const after = Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'sodegaura/runs.json'), 'utf8')).runs).find(([k]) => k.includes('20260913'))?.[1];
      check(after && after.name === undefined && after.note === undefined, `名前・メモが消えない: ${JSON.stringify(after)}`);
    }
  },
  {
    name: '保存した比べ方 (PLAN-18): Car の割り当てを保存し、別の走行を開いたあとで開き直すと、同じ走行と周に戻る',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      const root = await p.ev(`window.electronAPI.laps.getFolder()`);
      check(root && root.includes('scratchpad'), `保管場所が試験用の写しでない: ${root}`);
      await openRun(p, '9/18', 'run-open-analysis');
      await openRun(p, '8/15', 'run-add-car2');
      const before = await p.state();
      check(before.cars.length === 2, `Car が 2 台にならない: ${JSON.stringify(before.cars)}`);
      const want = before.cars.map(c => ({ slot: c.slot, name: before.sessions.find(x => x.id === c.sessionId)?.fileName, lap: c.lapNumber }));
      if (!(await p.exists('session-save'))) await p.click('toggle-data-drawer');
      await p.waitFor(`document.querySelector('[data-testid="session-save-name"]')`, 5000, '比べ方を保存の欄');
      await p.ev(`(() => { const el = document.querySelector('[data-testid="session-save-name"]'); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'e2e 比べ方'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await p.click('session-save-button');
      await p.waitFor(`document.querySelector('[data-testid="session-save"]')?.innerText.includes('保存しました')`, 8000, '保存しました');
      const files = fs.readdirSync(path.join(root, 'sessions')).filter(f => f.endsWith('.lapsession.json'));
      const saved = files.map(f => JSON.parse(fs.readFileSync(path.join(root, 'sessions', f), 'utf8'))).find(j => j.name === 'e2e 比べ方' && !j.deleted);
      check(saved?.cars?.length === 2, `保存したファイルがおかしい: ${JSON.stringify(saved)}`);
      if (await p.exists('session-save')) await p.click('toggle-data-drawer');
      // 別の走行を開いてから、保存した比べ方を開く
      await openRun(p, '8/30', 'run-open-analysis');
      await p.click('nav-library');
      await p.waitFor(`[...document.querySelectorAll('[data-testid="library-session-row"]')].some(r => r.innerText.includes('e2e 比べ方'))`, 10000, '保存した比べ方の行');
      await p.ev(`[...document.querySelectorAll('[data-testid="library-session-row"]')].find(r => r.innerText.includes('e2e 比べ方')).querySelector('button').click()`);
      await p.waitFor(`!document.querySelector('[data-testid="library-session-row"]')`, 30000, '開き終わる (解析の画面へ)');
      await sleep(3000);
      const after = await p.state();
      const got = after.cars.map(c => ({ slot: c.slot, name: after.sessions.find(x => x.id === c.sessionId)?.fileName, lap: c.lapNumber }));
      check(JSON.stringify(got) === JSON.stringify(want), `開き直した Car が違う: ${JSON.stringify(got)} / 保存: ${JSON.stringify(want)}`);
      // 片付け (消す)
      await p.click('nav-library');
      await p.waitFor(`[...document.querySelectorAll('[data-testid="library-session-row"]')].some(r => r.innerText.includes('e2e 比べ方'))`, 10000, '保存した比べ方の行');
      await p.ev(`window.confirm = () => true; [...document.querySelectorAll('[data-testid="library-session-row"]')].find(r => r.innerText.includes('e2e 比べ方')).querySelector('[data-testid="library-session-delete"]').click()`);
      await p.waitFor(`![...document.querySelectorAll('[data-testid="library-session-row"]')].some(r => r.innerText.includes('e2e 比べ方'))`, 8000, '消した比べ方が消える');
    }
  },
  {
    name: '動画だけの参考ラップ (LATER-17): 動画に計測線の印を打って保存し、自分の周の動画と周の始まりをそろえて並べる',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      const root = await p.ev(`window.electronAPI.laps.getFolder()`);
      check(root && root.includes('scratchpad'), `保管場所が試験用の写しでない: ${root}`);
      // 試験用の写しに、どの走行にも付いていない動画を置く (APFS の写し。場所は取らない)
      const dir = path.join(root, 'sodegaura/20200102');
      fs.mkdirSync(dir, { recursive: true });
      const video = path.join(dir, 'E2EREF.MP4');
      execFileSync('cp', ['-c', path.join(root, 'sodegaura/20260913/GX010016.MP4'), video]);
      const runsPath = path.join(root, 'sodegaura/runs.json');
      try {
        await p.goto(`${APP}?r=${Date.now()}`);
        await p.click('nav-library');
        await p.waitFor(`document.querySelector('[data-testid="library-owner-ref"]')`, 20000, '参考ラップの区切り');
        await p.click('library-owner-ref');
        await p.waitFor(`document.querySelector('[data-testid="library-video-ref-new"]')`, 5000, '動画から作る');
        await p.click('library-video-ref-new');
        await p.waitFor(`[...document.querySelectorAll('[data-testid="video-ref-candidate"]')].some(b => b.innerText.includes('E2EREF.MP4'))`, 20000, '候補の動画');
        const others = await p.ev(`[...document.querySelectorAll('[data-testid="video-ref-candidate"]')].map(b => b.innerText)`);
        check(!others.some(x => x.includes('GX010016') || x.includes('GX010017')), `走行に付けた動画が候補に出ている: ${others.join(' / ')}`);
        await p.ev(`[...document.querySelectorAll('[data-testid="video-ref-candidate"]')].find(b => b.innerText.includes('E2EREF.MP4')).click()`);
        await p.waitFor(`document.querySelector('[data-testid="video-lap-marker-video"]')?.readyState >= 1`, 20000, '印を打つ画面の動画');
        // 10 秒・50 秒 (セクター)・110 秒・205 秒 に印
        const mark = async (sec, kind) => {
          await p.ev(`(() => { const v = document.querySelector('[data-testid="video-lap-marker-video"]'); v.pause(); v.currentTime = ${sec}; })()`);
          await p.waitFor(`Math.abs(document.querySelector('[data-testid="video-lap-marker-video"]').currentTime - ${sec}) < 0.05 && !document.querySelector('[data-testid="video-lap-marker-video"]').seeking`, 10000, `${sec} 秒へ`);
          await p.click(kind === 'line' ? 'video-lap-mark-line' : 'video-lap-mark-sector');
        };
        await mark(10, 'line'); await mark(50, 'sector'); await mark(110, 'line'); await mark(205, 'line');
        await p.ev(`(() => { const el = document.querySelector('[data-testid="video-lap-name"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'e2e 参考'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await p.waitFor(`document.querySelector('[data-testid="video-lap-laps"]').innerText.includes('1:40.000') && document.querySelector('[data-testid="video-lap-laps"]').innerText.includes('1:35.000')`, 5000, '周が 2 つ (1:40.000・1:35.000)');
        await p.click('video-lap-save');
        await p.waitFor(`!document.querySelector('[data-testid="video-lap-marker"]')`, 10000, '保存して閉じる');
        const row = JSON.parse(fs.readFileSync(runsPath, 'utf8')).runs['20200102/E2EREF.MP4'];
        check(row?.name === 'e2e 参考' && row?.videoLaps?.marks?.length === 4 && row.reference, `runs.json の行がおかしい: ${JSON.stringify(row)}`);
        await p.waitFor(`[...document.querySelectorAll('[data-testid="library-video-ref-row"]')].some(r => r.innerText.includes('e2e 参考'))`, 10000, '参考ラップの行');
        await p.ev(`[...document.querySelectorAll('[data-testid="library-video-ref-row"]')].find(r => r.innerText.includes('e2e 参考')).querySelector('[data-testid="library-video-ref-compare"]').click()`);
        await p.waitFor(`document.querySelector('[data-testid="video-lap-compare"]')`, 5000, '比べる画面');
        check(await p.exists('video-lap-compare-own'), '自分の周 (同期した動画のある袖ヶ浦の走行) が出ない');
        await p.waitFor(`document.querySelector('[data-testid="video-lap-compare-ref-video"]').readyState >= 2 && document.querySelector('[data-testid="video-lap-compare-own-video"]').readyState >= 2`, 30000, '両方の動画');
        await sleep(500);
        const st0 = await p.ev(`({ ref: document.querySelector('[data-testid="video-lap-compare-ref-video"]').currentTime })`);
        check(Math.abs(st0.ref - 110) < 0.2, `参考ラップの動画が周の始まりにない: ${st0.ref}`);
        await p.click('video-lap-compare-play');
        await sleep(2500);
        await p.click('video-lap-compare-play');
        await sleep(300);
        const st = await p.ev(`({ ref: document.querySelector('[data-testid="video-lap-compare-ref-video"]').currentTime, own: document.querySelector('[data-testid="video-lap-compare-own-video"]').currentTime })`);
        const refStart = 110; // いちばん速い L2 (1:35.000) が始めに選ばれる
        check(st.ref - refStart > 1, `再生されていない: ${JSON.stringify(st)}`);
        check(await p.ev(`document.querySelector('[data-testid="video-lap-compare-table"]').innerText.includes('差')`), '差の行がない');
        p.notes.push(`参考 ${(st.ref - refStart).toFixed(2)} 秒・自分の動画 ${st.own.toFixed(2)} 秒`);
        // 終わりまで動かしてからもう一度再生すると、2 つとも始まりから動く (GUI のレビューで、自分の動画が止まったままだった)
        await p.ev(`(() => { const r = document.querySelector('[data-testid="video-lap-compare"] input[type=range]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, r.max); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await sleep(500);
        await p.click('video-lap-compare-play');
        await sleep(1500);
        const again = await p.ev(`({ ref: !document.querySelector('[data-testid="video-lap-compare-ref-video"]').paused, own: !document.querySelector('[data-testid="video-lap-compare-own-video"]').paused, t: document.querySelector('[data-testid="video-lap-compare-ref-video"]').currentTime })`);
        check(again.ref && again.own && again.t - refStart < 3, `終わりから再生し直すと 2 つとも始まりから動かない: ${JSON.stringify(again)}`);
        await p.click('video-lap-compare-play');
        await p.click('video-lap-compare-close');
        // やめる (行を消す。動画は残す)
        await p.ev(`window.confirm = () => true; [...document.querySelectorAll('[data-testid="library-video-ref-row"]')].find(r => r.innerText.includes('e2e 参考')).querySelector('[data-testid="library-video-ref-delete"]').click()`);
        await p.waitFor(`![...document.querySelectorAll('[data-testid="library-video-ref-row"]')].some(r => r.innerText.includes('e2e 参考'))`, 10000, '参考ラップの行が消える');
        check(fs.existsSync(video), '動画のファイルまで消えた');
        check(!JSON.parse(fs.readFileSync(runsPath, 'utf8')).runs['20200102/E2EREF.MP4'], 'runs.json の行が残っている');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        const r2 = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
        delete r2.runs['20200102/E2EREF.MP4'];
        fs.writeFileSync(runsPath, JSON.stringify(r2, null, 1));
      }
    }
  },
  {
    name: '走行を消す: 同じ日の別の走行・付けていない動画は残し、その走行のファイルと runs.json の行だけを消す',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      const root = await p.ev(`window.electronAPI.laps.getFolder()`);
      check(root && root.includes('scratchpad'), `保管場所が試験用の写しでない: ${root}`);
      // 試験用の写しに、同じ日の走行を 2 本と、付けていない動画を作る
      const dir = path.join(root, 'sodegaura/20200101');
      fs.mkdirSync(dir, { recursive: true });
      const src = fs.readFileSync(path.join(root, 'sodegaura/20260913/20260913092357.nmea'));
      const A = '20200101090000', B = '20200101100000';
      fs.writeFileSync(path.join(dir, `${A}.nmea`), src);
      fs.writeFileSync(path.join(dir, `${A}.iphone_imu.csv`), 'time_utc_ms,g_long,g_lat,g_vert\n');
      fs.writeFileSync(path.join(dir, `${A}.mov`), 'x');
      fs.writeFileSync(path.join(dir, `${B}.nmea`), src);
      fs.writeFileSync(path.join(dir, `${B}.mov`), 'y');
      fs.writeFileSync(path.join(dir, 'GX099999.MP4'), 'z');
      const runsPath = path.join(root, 'sodegaura/runs.json');
      const runs = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
      runs.runs[`20200101/${A}`] = { updatedAt: new Date().toISOString(), id: 'r_e2edelA', name: 'e2e 消す走行', videos: [{ name: `${A}.mov` }] };
      runs.runs[`20200101/${B}`] = { updatedAt: new Date().toISOString(), id: 'r_e2edelB', name: 'e2e 残す走行', videos: [{ name: `${B}.mov` }] };
      fs.writeFileSync(runsPath, JSON.stringify(runs, null, 1));
      try {
        // 作ったファイルを読み直す (一覧は開いたときに読む)
        await p.goto(`${APP}?r=${Date.now()}`);
        await p.click('nav-library');
        await p.waitFor(`[...document.querySelectorAll('[data-testid="run-row-name"]')].some(e => e.innerText === 'e2e 消す走行')`, 20000, '試験の走行の行');
        await p.ev(`[...document.querySelectorAll('[data-testid="run-row"]')].find(r => r.innerText.includes('e2e 消す走行')).click()`);
        await p.waitFor(`document.querySelector('[data-testid="run-delete"]')`, 5000, 'この走行を消す');
        await p.click('run-delete');
        await p.waitFor(`document.querySelector('[data-testid="run-delete-remove"]')`, 10000, '消すファイルの一覧');
        const listed = await p.ev(`({ remove: document.querySelector('[data-testid="run-delete-remove"]').innerText, keep: document.querySelector('[data-testid="run-delete-keep"]')?.innerText ?? '' })`);
        check(listed.remove.includes(`${A}.nmea`) && listed.remove.includes(`${A}.mov`) && listed.remove.includes(`${A}.iphone_imu.csv`), `消すファイルが足りない: ${listed.remove}`);
        check(!listed.remove.includes(B) && !listed.remove.includes('GX099999'), `ほかの走行・付けていない動画まで消そうとしている: ${listed.remove}`);
        check(listed.keep.includes('GX099999'), `付けていない動画が残すほうに出ない: ${listed.keep}`);
        await p.click('run-delete-confirm');
        await p.waitFor(`!document.querySelector('[data-testid="run-delete-dialog"]')`, 10000, '消し終わる');
        const left = fs.readdirSync(dir).sort();
        check(JSON.stringify(left) === JSON.stringify([`${B}.mov`, `${B}.nmea`, 'GX099999.MP4']), `残ったファイルが違う: ${left.join(', ')}`);
        const after = JSON.parse(fs.readFileSync(runsPath, 'utf8')).runs;
        check(!after[`20200101/${A}`] && !!after[`20200101/${B}`], 'runs.json の行の消え方が違う');
        await p.waitFor(`![...document.querySelectorAll('[data-testid="run-row-name"]')].some(e => e.innerText === 'e2e 消す走行')`, 10000, '一覧から消える');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        const r2 = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
        delete r2.runs[`20200101/${A}`];
        delete r2.runs[`20200101/${B}`];
        fs.writeFileSync(runsPath, JSON.stringify(r2, null, 1));
      }
    }
  },
  {
    name: '動画: 全体で動かす・周に切り替える・画面を行き来しても、動画とログが合っている',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      await openRun(p, '8/30', 'run-open-video');
      await checkVideoSync(p, '開いた直後');
      await p.clickText('全体');
      await seekRatio(p, 0.6);
      await checkVideoSync(p, '全体で 6 割へ動かしたあと');
      const lapBtn = await p.ev(`[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).find(t=>/^L\\d+$/.test(t))`);
      await p.clickText(lapBtn);
      await sleep(1200);
      await checkVideoSync(p, `${lapBtn} に切り替えたあと`);
      await checkInsideLap(p, `${lapBtn} に切り替えたあと`);
      await seekRatio(p, 0.3);
      await checkVideoSync(p, `${lapBtn} の中で 3 割へ動かしたあと`);
      await p.click('nav-analysis');
      await sleep(1500);
      await p.click('nav-video');
      await sleep(2000);
      await checkVideoSync(p, '解析へ行って戻ったあと');
      await p.click('video-mode-sync');
      await sleep(1000);
      await checkVideoSync(p, '合わせるに切り替えたあと');
      await p.click('video-mode-watch');
    }
  },
  {
    name: '走行とコースで Car 1 を別の走行に替えると、動画もその走行のものになる (agy の調査で見つかったもの)',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      // 違うコースの走行は開くと外れるので、同じコース (袖ヶ浦) の 2 つの走行で試す
      await openRun(p, '9/18', 'run-open-analysis');
      await openRun(p, '8/15', 'run-open-video');
      check((await car1Name(p))?.includes('20260815'), '8/15 が Car 1 でない');
      await p.click('nav-analysis');
      await sleep(800);
      await p.click('toggle-data-drawer');
      await p.waitFor(`document.querySelector('[data-testid="data-drawer"]')`, 3000);
      // 9/18 の走行の周の表で、Car 1 (1 の印) を押す
      const ok = await p.ev(`(()=>{
        const drawer=document.querySelector('[data-testid="data-drawer"]');
        const isCar1=x=>(x.title||'').startsWith('Car 1');
        const blocks=[...drawer.querySelectorAll('*')].filter(e=>e.innerText && e.innerText.includes('20260918') && !e.innerText.includes('20260815') && e.innerText.includes('ラップタイム') && [...e.querySelectorAll('button')].some(isCar1));
        const block=blocks.sort((a,b)=>a.innerText.length-b.innerText.length)[0];
        const btn=block && [...block.querySelectorAll('button')].find(isCar1);
        if(!btn) return false; btn.click(); return true })()`);
      check(ok, '9/18 の周の Car 1 の印が見つからない');
      await sleep(1500);
      check((await car1Name(p))?.includes('20260918'), `Car 1 が 9/18 にならない: ${await car1Name(p)}`);
      await p.click('data-drawer-close');
      await p.click('nav-video');
      await sleep(6000);
      const src = await p.ev(`decodeURIComponent(([...document.querySelectorAll('video')].find(x=>x.offsetParent!==null) ?? document.querySelector('video'))?.currentSrc ?? '')`);
      check(src.includes('GX010017'), `動画が 9/18 のものにならない: ${src}`);
      await checkVideoSync(p, 'Car 1 を 9/18 に替えて動画へ');
    }
  },
  {
    name: 'Car 2 として足すと、同じコースのその走行のベストの周が Car 2 に入る',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      await openRun(p, '8/15', 'run-open-analysis');
      await openRun(p, '9/18', 'run-add-car2');
      const s = await p.state();
      const c2 = s.cars.find(c => c.slot === 1);
      check(c2, 'Car 2 が入っていない');
      const sess = s.sessions.find(x => x.id === c2.sessionId);
      check(sess?.fileName.includes('20260918'), `Car 2 が 9/18 の走行でない: ${sess?.fileName}`);
      check((await car1Name(p))?.includes('20260815'), `Car 2 を足したら Car 1 が変わった: ${await car1Name(p)}`);
    }
  },
  {
    name: '別の日の走行を Car 2 に足すと、比べるの Car 2 の枠にその走行の動画が出る (Car 1 を替えても残る)',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      await openRun(p, '8/15', 'run-open-video');
      await openRun(p, '9/18', 'run-add-car2');
      await p.click('nav-video');
      await sleep(1500);
      await p.click('video-mode-compare');
      await sleep(5000);
      const tiles = async () => p.ev(`(()=>({
        // 見えているものだけ (解析の画面の左下にも車載動画の窓がある)
        sel: [...document.querySelectorAll('select')].filter(x => x.offsetParent !== null && /^自動/.test(x.options[0]?.text ?? '')).map(x => x.options[x.selectedIndex]?.text),
        src: [...document.querySelectorAll('video')].filter(v => v.offsetParent !== null).map(v => decodeURIComponent(v.currentSrc || v.src).split('/').pop()),
        none: /この時刻の映像はありません|この周を映している動画がありません/.test(document.body.innerText)
      }))()`);
      let t = await tiles();
      check(t.sel[1] === '自動: GX010017.MP4', `Car 2 (9/18) の枠の動画が 9/18 の GX010017 でない: ${t.sel.join(', ')}`);
      check(t.src.includes('GX010017.MP4') && !t.none, `Car 2 の枠に動画が出ていない: ${t.src.join(', ')}`);
      // Car 1 を別の走行に替えても、Car 2 の動画は残る
      await openRun(p, '9/13', 'run-open-video');
      await p.click('video-mode-compare');
      await sleep(5000);
      t = await tiles();
      check(t.sel[1] === '自動: GX010017.MP4', `Car 1 を替えたら Car 2 の動画が外れた: ${t.sel.join(', ')}`);
    }
  },
  {
    name: '走行の詳細: 周を隠して出すと元に戻る (laptimes.json も元どおり)',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      await p.click('nav-library');
      await p.waitFor(`document.querySelectorAll('[data-testid="run-row"]').length > 0`, 20000);
      await p.ev(`(()=>{const r=[...document.querySelectorAll('[data-testid="run-row"]')].find(r=>r.innerText.includes('9/13')); r?.click()})()`);
      await p.waitFor(`document.querySelector('[data-testid="run-detail"]')`, 5000);
      const head = () => p.ev(`document.querySelector('[data-testid="run-detail"]').innerText.split('\\n').slice(0,3).join(' ')`);
      const before = await head();
      await p.ev(`[...document.querySelectorAll('[data-testid="run-detail"] button[aria-label="隠す"]')][0].click()`);
      await sleep(4000);
      const hidden = await head();
      check(hidden !== before, '周を隠しても見出し (ベスト・周の数) が変わらない');
      await p.ev(`[...document.querySelectorAll('[data-testid="run-detail"] button[aria-label="出す"]')][0].click()`);
      await sleep(4000);
      check((await head()) === before, `出したのに元に戻らない: ${await head()} / 前 ${before}`);
    }
  },
  {
    name: '解析の「走行とコース」は、解析から離れると閉じる',
    target: 'electron',
    async run(p) {
      await p.goto(APP);
      await openRun(p, '8/15', 'run-open-analysis');
      await p.click('toggle-data-drawer');
      await p.waitFor(`document.querySelector('[data-testid="data-drawer"]')`, 3000, '引き出しが開く');
      await p.click('nav-video');
      await sleep(800);
      await p.click('nav-analysis');
      await sleep(800);
      check(!(await p.exists('data-drawer')), '解析に戻ったら引き出しが開いたまま');
    }
  },
  {
    name: 'スマートフォンのアプリ: タブ・設定の開け閉め・⚙ の中の画面から戻る',
    target: 'phone',
    async run(p) {
      await p.viewport(390, 844, true);
      await p.goto(`${APP}?native=mock`);
      let s = await p.state();
      check(s.screen === 'library', `はじめの画面が ${s.screen}`);
      for (const tab of ['timer', 'analysis', 'video', 'library']) {
        await p.click(`nav-${tab}`);
        await sleep(400);
        s = await p.state();
        check(s.screen === tab, `${tab} を押したのに ${s.screen}`);
      }
      await p.click('nav-video');
      await p.click('nav-settings');
      await sleep(300);
      check((await p.state()).screen === 'settings', '⚙ で設定が開かない');
      await p.click('settings-go-convert');
      await sleep(300);
      await p.click('nav-back');
      await sleep(300);
      check((await p.state()).screen === 'settings', '変換から戻ったら設定に戻らない');
      await p.click('nav-settings');
      await sleep(300);
      check((await p.state()).screen === 'video', `⚙ をもう一度押したら元の画面 (動画) に戻らない: ${(await p.state()).screen}`);
    }
  },
  {
    name: 'スマートフォンのアプリ: タイマーの測定開始・終了の確認・10 秒で閉じる・測っている間はタブを出さない',
    target: 'phone',
    async run(p) {
      await p.viewport(390, 844, true);
      await p.goto(`${APP}?native=mock`);
      await p.click('nav-timer');
      await sleep(600);
      // デジスパイスを登録していないときは、測定開始で測らずに機器の画面へ (Fable の調査で見つかったもの)
      await p.click('lap-timer-menu');
      await p.click('lap-timer-src-digspice');
      await sleep(300);
      await p.click('lap-timer-start-stop');
      await sleep(600);
      check((await p.state()).screen === 'logger', `未登録で測定開始を押して ${(await p.state()).screen}`);
      // 端末の GPS で測る
      await p.click('nav-timer');
      await sleep(600);
      await p.click('lap-timer-menu');
      await p.click('lap-timer-src-phone');
      await sleep(300);
      await p.click('lap-timer-start-stop');
      await sleep(600);
      check(!(await p.exists('bottom-tabs')), '測っている間にタブが出ている');
      await p.click('lap-timer-start-stop');
      await p.waitFor(`document.querySelector('[data-testid="lap-timer-stop-confirm"]')`, 2000, '終了の確認');
      await p.click('lap-timer-stop-no');
      await sleep(300);
      check(await p.ev(`document.querySelector('[data-testid="lap-timer-start-stop"]').innerText.includes('測定終了')`), 'いいえ で測るのが止まった');
      await p.click('lap-timer-start-stop');
      await sleep(11000);
      check(!(await p.exists('lap-timer-stop-confirm')), '10 秒たっても確認が閉じない');
      await p.click('lap-timer-start-stop');
      await p.click('lap-timer-stop-yes');
      await sleep(800);
      check(await p.exists('bottom-tabs'), '測り終えてもタブが戻らない');
    }
  },
  {
    name: 'スマートフォンのアプリ: 内蔵カメラで前も一緒に撮る (映像の窓が 2 つ・メニューと重ならない・_front.mov もできる)',
    target: 'phone',
    async run(p) {
      await p.viewport(390, 844, true);
      await p.goto(`${APP}?native=mock`);
      await p.ev(`localStorage.setItem('ds_timer_camera', JSON.stringify({ enabled: true, front: { enabled: false, preset: '1080p30', iso: null } }))`);
      await p.goto(`${APP}?native=mock&camera=1`);
      await p.click('nav-timer');
      await sleep(600);
      await p.click('lap-timer-menu');
      await p.click('lap-timer-src-phone');
      await sleep(300);
      await p.click('lap-timer-menu');
      await p.waitFor(`document.querySelector('[data-testid="lap-timer-camera-front-on"]')`, 3000, '前のカメラのチェック');
      check(!(await p.exists('lap-timer-camera-live-front')), '前を選ぶ前に前の枠がある');
      await p.click('lap-timer-camera-front-on');
      await p.waitFor(`document.querySelector('[data-testid="lap-timer-camera-exposure-front"]')`, 3000, '前の ISO・シャッター');
      const g = await p.ev(`(() => {
        const r = s => document.querySelector(s).getBoundingClientRect();
        const wrap = r('[data-testid="lap-timer-camera-live-wrap"]'), menu = document.querySelector('[data-testid="lap-timer-camera"]').closest('.overflow-y-auto').getBoundingClientRect();
        const a = r('[data-testid="lap-timer-camera-live"]'), b = r('[data-testid="lap-timer-camera-live-front"]');
        return { gap: wrap.top - menu.bottom, side: b.left >= a.right - 1, tall: a.height > a.width, inView: wrap.bottom <= innerHeight };
      })()`);
      check(g.gap >= 0, `映像の窓がメニューと重なる: ${g.gap}`);
      check(g.side && g.tall && g.inView, `前後の枠の並びがおかしい: ${JSON.stringify(g)}`);
      check(await p.exists('lap-timer-camera-front'), '前のカメラの設定がない');
      // 測って止めると、後ろと前の動画ができる
      await p.click('lap-timer-menu-backdrop');
      await sleep(300);
      await p.click('lap-timer-start-stop');
      await sleep(800);
      await p.click('lap-timer-start-stop');
      await p.click('lap-timer-stop-yes');
      await sleep(1000);
      const files = await p.ev(`import('/src/native/bridge.ts').then(m => m.callNative('system.listRunFiles', {})).then(r => r.files.map(f => f.path).filter(x => x.endsWith('.mov')))`);
      check(files.some(f => f.endsWith('_front.mov')) && files.some(f => !f.endsWith('_front.mov')), `動画が揃わない: ${JSON.stringify(files)}`);
      await p.ev(`localStorage.removeItem('ds_timer_camera')`);
    }
  },
  {
    name: 'ブラウザ版の比べ方 (PLAN-18): ファイルに書き出し、周を替えてから読み込むと、同じログと周に戻る',
    target: 'phone',
    async run(p) {
      await p.viewport(1440, 900, false);
      await p.goto(APP);
      await p.send('DOM.enable');
      if (!fs.existsSync(SAMPLE_NMEA)) { p.notes.push(`読み込むログ ${SAMPLE_NMEA} がないので飛ばした`); return; }
      const tmp = path.join(os.tmpdir(), path.basename(SAMPLE_NMEA));
      fs.copyFileSync(SAMPLE_NMEA, tmp);
      await p.setFiles('input[type=file]', [tmp]);
      await sleep(4000);
      const s0 = await p.state();
      check(s0.sessions.length > 0 && s0.sessions[0].laps >= 3, `ログを読み込めていない: ${JSON.stringify(s0.sessions)}`);
      const id = s0.sessions[0].id;
      await p.ev(`window.__laploupe.selectCar(0, ${JSON.stringify(id)}, 3)`);
      await sleep(800);
      // 書き出し (ダウンロードの中身を横取りする)
      await p.ev(`(() => { const orig = URL.createObjectURL; URL.createObjectURL = b => { b.text().then(t => { window.__dl = t; }); return orig(b); }; })()`);
      // ブラウザ版の欄は Car が無くても出る (読み込むため) ので、引き出しが開いているかで見る
      if (!(await p.exists('data-drawer-close'))) await p.click('toggle-data-drawer');
      await p.waitFor(`document.querySelector('[data-testid="session-save-button"]')`, 5000, '比べ方を書き出すのボタン');
      const dbg = await p.ev(`({ n: document.querySelectorAll('[data-testid="session-save-button"]').length, d: document.querySelector('[data-testid="session-save-button"]').disabled, cars: window.__laploupe.cars })`);
      check(!dbg.d, `書き出すのボタンが押せない: ${JSON.stringify(dbg)}`);
      await p.click('session-save-button');
      await p.waitFor(`typeof window.__dl === 'string'`, 5000, '書き出したファイル');
      const text = await p.ev(`window.__dl`);
      const data = JSON.parse(text);
      check(data.source === 'files' && data.cars?.[0]?.run === path.basename(SAMPLE_NMEA) && data.cars[0].lap === 3, `書き出しがおかしい: ${text}`);
      // 周を替えてから読み込む
      await p.ev(`window.__laploupe.selectCar(0, ${JSON.stringify(id)}, 2)`);
      await sleep(800);
      const json = path.join(os.tmpdir(), 'e2e.lapsession.json');
      fs.writeFileSync(json, text);
      await p.setFiles('[data-testid="session-import-input"]', [json]);
      await p.waitFor(`document.querySelector('[data-testid="session-save"]')?.innerText.includes('読み込みました')`, 5000, '読み込みました');
      const s1 = await p.state();
      check(s1.cars.length === 1 && s1.cars[0].sessionId === id && s1.cars[0].lapNumber === 3, `読み込んだ Car が違う: ${JSON.stringify(s1.cars)}`);
    }
  },
  {
    name: 'ブラウザ版: URL の末尾 #convert で変換が開き、上のタブがある',
    target: 'phone',
    async run(p) {
      await p.viewport(1440, 900, false);
      await p.goto(`${APP}#convert`);
      const s = await p.state();
      check(s.screen === 'convert', `#convert で ${s.screen}`);
      check(await p.exists('nav-analysis'), '上のタブがない');
    }
  },
  {
    name: '取り込み: 2 つのサーキットのログを開くと、走行ごとに分けて保管場所に書き、元のファイルを 取り込み元/ に残す',
    target: 'electron',
    async run(p) {
      const root = await p.ev(`window.electronAPI.laps.getFolder()`);
      check(root && root.includes('scratchpad'), `保管場所が試験用の写しでない: ${root}`);
      // 日光と筑波のログの日付を、ほかの走行と重ならない日 (2020 年) に替えてつなぐ (チェックサムも付け直す)
      const day = 1 + (Date.now() % 27);
      const ddmmyy = `${String(day).padStart(2, '0')}0120`;
      const redate = text => text.split(/\r?\n/).map(line => {
        if (!/^\$G[NP]RMC,/.test(line)) return line;
        const body = line.slice(1, line.indexOf('*') >= 0 ? line.indexOf('*') : undefined).split(',');
        body[9] = ddmmyy;
        const b = body.join(',');
        let x = 0;
        for (const c of b) x ^= c.charCodeAt(0);
        return `$${b}*${x.toString(16).toUpperCase().padStart(2, '0')}`;
      }).join('\r\n');
      const nikko = fs.readFileSync(path.join(root, 'nikko/20260830/20260830095701.nmea'), 'utf8');
      const tc = fs.readFileSync(path.join(root, 'tsukuba2000/20261012/20261012133132.nmea'), 'utf8');
      const name = `e2e_import_${Date.now()}.nmea`;
      const src = path.join(os.tmpdir(), name);
      fs.writeFileSync(src, redate(nikko) + '\r\n' + redate(tc));
      const created = [];
      try {
        await p.setFiles('input[type=file]', [src]);
        await p.waitFor(`document.querySelector('[data-testid="import-sheet"]')`, 30000, '取り込みの確認');
        const rows = await p.ev(`[...document.querySelectorAll('[data-testid="import-row"]')].map(r => r.innerText.replace(/\\s+/g, ' '))`);
        const kept = rows.filter(r => /日光|筑波|Nikko|Tsukuba/i.test(r));
        check(kept.length === 2, `日光と筑波の 2 つに分かれていない: ${rows.join(' | ')}`);
        await p.click('import-apply');
        await p.waitFor(`document.querySelector('[data-testid="import-summary"]')`, 30000, '取り込みの終わり');
        const dirs = ['nikko', 'tsukuba2000'].map(c => path.join(root, c, `202001${String(day).padStart(2, '0')}`));
        for (const d of dirs) {
          check(fs.existsSync(d), `${d} ができていない`);
          created.push(d);
          check(fs.readdirSync(d).some(f => f.endsWith('.nmea')), `${d} に .nmea がない`);
        }
        const kept0 = path.join(root, '取り込み元', name);
        check(fs.existsSync(kept0), '取り込み元/ に元のファイルがない');
        created.push(kept0);
        check(fs.readFileSync(kept0).equals(fs.readFileSync(src)), '取り込み元/ のファイルが元と違う');
        // 解析で開く
        await p.click('import-open-after');
        await p.waitFor(`window.__laploupe?.screen === 'analysis' && window.__laploupe.sessions.some(s => s.fileName === ${JSON.stringify(name)})`, 30000, '解析で開く');
        check(!(await p.exists('import-sheet')), '開いたあとも確認が出ている');
        // 同じファイルをもう一度開くと、全部取り込み済みなので聞かずに開く
        await p.setFiles('input[type=file]', [src]);
        await sleep(4000);
        check(!(await p.exists('import-sheet')), '取り込み済みのログで、また確認が出た');
      } finally {
        // 試験で書いたものを消す (試験用の写しの中だけ)
        for (const f of created) if (f.includes('scratchpad')) fs.rmSync(f, { recursive: true, force: true });
        fs.rmSync(src, { force: true });
      }
    }
  },
  {
    name: 'コーナーの名前: アプリに入っているコーナー (日光) で始まり、コースマップで名前を付け・まとめて保存すると course/Corner/<コース>.json に書き、コーナー別の表にも出る',
    target: 'electron',
    async run(p) {
      const root = await p.ev(`window.electronAPI.laps.getFolder()`);
      check(root && root.includes('scratchpad'), `保管場所が試験用の写しでない: ${root}`);
      const file = path.join(root, 'course', 'Corner', 'nikko.json');
      // 前の試験で作ったもの (前の置き場所 nikko/corners.json も) を消してから (自動で作られることから確かめる。試験用の写しの中だけ)
      const old = path.join(root, 'nikko', 'corners.json');
      for (const f of [file, `${file}.bak`, old, `${old}.bak`]) fs.rmSync(f, { force: true });
      await p.goto(`${APP}`);
      await openRun(p, '8/30', 'run-open-analysis');
      await p.waitFor(`document.querySelector('[data-testid="corner-edit"]')`, 15000, 'コーナーの編集のボタン');
      await sleep(1500);
      // 日光はアプリにコーナーが入っているので、開いただけでは保管場所に作らない (入っているものを使う)
      check(!fs.existsSync(file), 'アプリにコーナーが入っているのに、course/Corner/nikko.json を自動で作った');
      const auto = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'courses', 'Corner', 'nikko.json'), 'utf8'));
      const n0 = auto.corners.length;
      await p.click('corner-edit');
      await p.waitFor(`document.querySelectorAll('[data-testid="corner-edit-row"]').length === ${n0}`, 5000, '編集の一覧');
      // 1 つ目の名前を「1」に、2 つ目と 3 つ目をまとめて「2-3」にする
      const setName = async (k, v) => p.ev(`(()=>{const el=document.querySelectorAll('[data-testid="corner-name-input"]')[${k}]; const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value})()`);
      await setName(0, '1');
      await p.ev(`document.querySelectorAll('[data-testid="corner-edit-row"]')[1].click()`);
      await p.click('corner-merge');
      await sleep(200);
      await setName(1, '2-3');
      await p.click('corner-save');
      await p.waitFor(`!document.querySelector('[data-testid="corner-edit-panel"]')`, 5000, '保存して閉じる');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      check(saved.auto === false, '保存しても auto のまま');
      check(saved.corners.length === n0 - 1, `まとめたのに数が ${saved.corners.length} (元 ${n0})`);
      check(saved.corners[0].name === '1' && saved.corners[1].name === '2-3', `名前が違う: ${saved.corners.map(c => c.name).join(',')}`);
      check(saved.corners[1].exit.lat === auto.corners[2].exit.lat, 'まとめたコーナーの出口が、後ろのコーナーの出口でない');
      // 保管場所に前の中身は無かった (アプリに入っているものだった) ので、控え (.bak) は作らない
      // コーナー別の表 (あれば) にも同じ名前
      const table = await p.ev(`document.querySelector('[data-testid="corner-analysis"]')?.innerText ?? null`);
      if (table !== null) check(table.includes('2-3'), 'コーナー別の表に名前が出ていない');
      else p.notes.push('コーナー別の表が画面になかったので、表の名前は確かめていない');
      // 地図を押してコーナーを足す: 走行の線 (Car 1 の赤) の上で、札から離れた所を押す
      await p.click('corner-edit');
      await p.waitFor(`document.querySelectorAll('[data-testid="corner-edit-row"]').length === ${saved.corners.length}`, 5000, '編集の一覧 (2 回目)');
      // 編集中は地図の上のボタンが減って地図が大きくなるので、描き直してから線を探す (地図の大きさが落ち着くまで待つ)
      await p.waitFor(`(() => { const cv = [...document.querySelectorAll('canvas')].find(c => c.parentElement?.contains(document.querySelector('[data-testid="corner-edit-panel"]'))); if (!cv) return false; const w = cv.getBoundingClientRect().height; const ok = window.__mapH === w; window.__mapH = w; return ok; })()`, 5000, '地図の大きさ');
      await sleep(1500);
      const spot = await p.ev(`(()=>{
        const panel = document.querySelector('[data-testid="corner-edit-panel"]').getBoundingClientRect();
        const cv = [...document.querySelectorAll('canvas')].find(c => c.parentElement?.contains(document.querySelector('[data-testid="corner-edit-panel"]')));
        const r = cv.getBoundingClientRect(); const dpr = cv.width / r.width;
        const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const hits = [], amber = [];
        for (let y = 30; y < r.height - 10; y += 3) for (let x = 10; x < panel.left - r.left - 10; x += 3) {
          const i = (Math.round(y * dpr) * cv.width + Math.round(x * dpr)) * 4;
          if (img[i] > 200 && img[i + 1] < 90 && img[i + 2] < 90) hits.push({ x: r.left + x, y: r.top + y });
          // コーナーの名札 (黄色の文字・縁)
          if (img[i] > 200 && img[i + 1] > 150 && img[i + 2] < 80) amber.push({ x: r.left + x, y: r.top + y });
          // 車の印 (白)
          if (img[i] > 220 && img[i + 1] > 220 && img[i + 2] > 220) amber.push({ x: r.left + x, y: r.top + y });
        }
        // 名札から離れた線の上 (名札の上を押すと、足さずに選ぶため)
        // コーナーの多いコース (アプリに入っているコーナー) でも空いた所を押すよう、名札からいちばん遠い線の上を選ぶ
        let best = null, bestD = 25;
        for (const h of hits) {
          const d = amber.reduce((m, a) => Math.min(m, Math.hypot(a.x - h.x, a.y - h.y)), Infinity);
          if (d > bestD) { bestD = d; best = h; }
        }
        // なぞる試しの始まり: その点から 50〜90 px 離れた線の上
        // (まっすぐ動かすので、途中も線の上にある所。ヘアピンの内側を横切ると、線の別の所に跳ぶため)
        const onLine = (x, y) => hits.some(h => Math.hypot(h.x - x, h.y - y) < 6);
        const from = best && hits.find(h => {
          const d = Math.hypot(h.x - best.x, h.y - best.y);
          if (d < 50 || d > 90) return false;
          for (let k = 1; k < 12; k++) if (!onLine(h.x + (best.x - h.x) * k / 12, h.y + (best.y - h.y) * k / 12)) return false;
          return true;
        });
        return best && { x: best.x, y: best.y, from };
      })()`);
      check(spot, '地図の上に走行の線が見つからない');
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, button: 'none', buttons: 0 });
      await sleep(100);
      for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      await sleep(400);
      const rows = await p.ev(`document.querySelectorAll('[data-testid="corner-edit-row"]').length`);
      // 札の上を押したときは選ぶだけ (数は増えない)。そうでなければ 1 つ増える
      // コーナーの外を押したら 1 つ足し、中を押したらそのコーナーを選ぶ (日光はコースの多くがコーナーなので、どちらもある)
      const tapPicked = await p.ev(`[...document.querySelectorAll('[data-testid="corner-edit-row"]')].some(r => r.className.includes('bg-amber-500'))`);
      check(rows === saved.corners.length + 1 || (rows === saved.corners.length && tapPicked), `地図を押しても、コーナーが足されず選ばれもしない (${rows} 個、元 ${saved.corners.length} 個)`);
      // 走行の線をなぞる: なぞった範囲が 1 つのコーナーになり、選ばれる
      if (spot.from) {
        const steps = 12;
        await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.from.x, y: spot.from.y, button: 'left', clickCount: 1 });
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.from.x + (spot.x - spot.from.x) * t * 1.15, y: spot.from.y + (spot.y - spot.from.y) * t * 1.15, button: 'left', buttons: 1 });
          await sleep(20);
        }
        await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.from.x + (spot.x - spot.from.x) * 1.15, y: spot.from.y + (spot.y - spot.from.y) * 1.15, button: 'left', clickCount: 1 });
        await sleep(400);
        const after = await p.ev(`({ rows: document.querySelectorAll('[data-testid="corner-edit-row"]').length, picked: [...document.querySelectorAll('[data-testid="corner-edit-row"]')].some(r => r.className.includes('bg-amber-500')) })`);
        // 押して足したコーナーの頂点は、範囲の中のいちばん曲がりのきつい所 (押した所とは限らない) なので、置き換わるかは決まらない。
        // 増えるのは多くても 1 つ (置き換えは単体の試験で見る)
        check(after.rows <= rows + 1, `なぞったら、コーナーが 2 つ以上増えた (${after.rows} 個、なぞる前 ${rows} 個)`);
        check(after.picked, 'なぞって作ったコーナーが選ばれていない');
      } else p.notes.push('なぞる試しの線の点が見つからなかったので、なぞる操作は確かめていない');
      await p.ev(`[...document.querySelectorAll('[data-testid="corner-edit-panel"] button')].find(b => /やめる|Cancel/.test(b.innerText)).click()`);
    }
  },
  // 寸法: 全部の画面を開き、バーの高さ・文字の折り返し・はみ出しを確かめる (「ファイルを開く」でバーが伸びていたもの)
  ...[
    ['スマートフォンのアプリ・縦', 390, 844, true, '?native=mock'],
    ['スマートフォンのアプリ・横', 844, 390, true, '?native=mock'],
    ['スマートフォンのブラウザ', 390, 844, true, ''],
    ['小さいスマートフォンのブラウザ', 360, 740, true, ''],
    ['タブレットのブラウザ', 820, 1180, true, ''],
    ['パソコンのブラウザ', 1440, 900, false, '']
  ].map(([label, w, h, mobile, q]) => ({
    name: `寸法: ${label} (${w}×${h})`,
    target: 'phone',
    async run(p) {
      await p.viewport(w, h, mobile);
      await p.goto(`${APP}${q}`);
      await sweepLayout(p, `${w}x${h}${q ? '_app' : ''}`);
    }
  })),
  {
    name: '寸法: スマートフォンのアプリ (ログを読み込み、端末の GPS を選んだ状態)',
    target: 'phone',
    async run(p) {
      await p.viewport(390, 844, true);
      await p.goto(`${APP}?native=mock`);
      await p.send('DOM.enable');
      if (!fs.existsSync(SAMPLE_NMEA)) { p.notes.push(`読み込むログ ${SAMPLE_NMEA} がないので飛ばした`); return; }
      // Chrome は iCloud のフォルダを読めない (macOS の保護) ので、一時フォルダに写して渡す
      const tmp = path.join(os.tmpdir(), path.basename(SAMPLE_NMEA));
      fs.copyFileSync(SAMPLE_NMEA, tmp);
      await p.setFiles('input[type=file]', [tmp]);
      await sleep(4000);
      if (await p.exists('import-open-only')) { await p.click('import-open-only'); await sleep(3000); }
      check((await p.state()).sessions.length > 0, 'ログを読み込めていない');
      // タイマーで端末の GPS を選ぶ (上の印がいちばん長くなる)
      await p.click('nav-timer');
      await sleep(600);
      await p.click('lap-timer-menu');
      await p.click('lap-timer-src-phone');
      await sleep(300);
      await sweepLayout(p, '390x844_app_loaded');
      // 横にしたとき
      await p.viewport(844, 390, true);
      await sleep(800);
      await sweepLayout(p, '844x390_app_loaded');
    }
  },
  {
    name: '寸法: デスクトップ版 (走行を開いた状態)',
    target: 'electron',
    async run(p) {
      await openRun(p, '8/30', 'run-open-analysis');
      await sweepLayout(p, 'electron');
    }
  }
];
