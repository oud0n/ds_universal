// 画面の通しの試験の場面 (2026-10-21)。
// electron: デスクトップ版を、保管場所の写し (e2e の実データ) で動かす。phone: Chrome をスマートフォンの幅にし、アプリのふり (?native=mock) で動かす。
// どの場面も、操作のあとで「つじつま」(開いた走行が Car 1・動画の位置がログの時刻と合う など) を確かめる。

import { check, sleep } from './cdp.mjs';
import { sweepLayout } from './layout.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  await sleep(1200);
  const s = await p.state();
  const v = await p.ev(`(()=>{const v=document.querySelector('video'); return v ? { t: v.currentTime, src: decodeURIComponent(v.currentSrc || v.src), dur: v.duration } : null})()`);
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
      const src = await p.ev(`decodeURIComponent(document.querySelector('video')?.currentSrc ?? '')`);
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
        sel: [...document.querySelectorAll('select')].filter(x => /^自動/.test(x.options[0]?.text ?? '')).map(x => x.options[x.selectedIndex]?.text),
        src: [...document.querySelectorAll('video')].map(v => decodeURIComponent(v.currentSrc || v.src).split('/').pop()),
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
    name: 'コーナーの名前: 走行を開くと corners.json ができ、コースマップで名前を付け・まとめて保存すると、コーナー別の表にも出る',
    target: 'electron',
    async run(p) {
      const root = await p.ev(`window.electronAPI.laps.getFolder()`);
      check(root && root.includes('scratchpad'), `保管場所が試験用の写しでない: ${root}`);
      const file = path.join(root, 'nikko', 'corners.json');
      // 前の試験で作ったものを消してから (自動で作られることから確かめる。試験用の写しの中だけ)
      for (const f of [file, `${file}.bak`]) fs.rmSync(f, { force: true });
      await p.goto(`${APP}`);
      await openRun(p, '8/30', 'run-open-analysis');
      await p.waitFor(`document.querySelector('[data-testid="corner-edit"]')`, 15000, 'コーナーの編集のボタン');
      await sleep(1500);
      check(fs.existsSync(file), 'corners.json が自動でできていない');
      const auto = JSON.parse(fs.readFileSync(file, 'utf8'));
      check(auto.auto === true && auto.corners.length >= 3, `自動の中身が違う: ${JSON.stringify(auto).slice(0, 200)}`);
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
      check(fs.existsSync(`${file}.bak`), '前の中身の控え (.bak) がない');
      // コーナー別の表 (あれば) にも同じ名前
      const table = await p.ev(`document.querySelector('[data-testid="corner-analysis"]')?.innerText ?? null`);
      if (table !== null) check(table.includes('2-3'), 'コーナー別の表に名前が出ていない');
      else p.notes.push('コーナー別の表が画面になかったので、表の名前は確かめていない');
      // 地図を押してコーナーを足す: 走行の線 (Car 1 の赤) の上で、札から離れた所を押す
      await p.click('corner-edit');
      await p.waitFor(`document.querySelectorAll('[data-testid="corner-edit-row"]').length === ${saved.corners.length}`, 5000, '編集の一覧 (2 回目)');
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
        const far = hits.filter(h => amber.every(a => Math.hypot(a.x - h.x, a.y - h.y) > 25));
        return far.length ? far[Math.floor(far.length / 2)] : null;
      })()`);
      check(spot, '地図の上に走行の線が見つからない');
      for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
      await sleep(400);
      const rows = await p.ev(`document.querySelectorAll('[data-testid="corner-edit-row"]').length`);
      // 札の上を押したときは選ぶだけ (数は増えない)。そうでなければ 1 つ増える
      check(rows === saved.corners.length + 1, `地図を押してもコーナーが足されない (${rows} 個、元 ${saved.corners.length} 個)`);
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
