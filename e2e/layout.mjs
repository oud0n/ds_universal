// 寸法の試験 (2026-10-21)。全部の画面を順に開き、見た目の崩れを数字で確かめる。
// AI や人の目では、画面を 1 枚ずつ見ても「ほかの画面よりバーが高い」などに気づきにくいため。
//
// 確かめること (崩れなら失敗):
//   - 上のバーの高さが、画面ごとにそろっている (2px まで)
//   - 上のバー・下のタブ・横の並びで、文字が折り返していない・…で切れていない
//   - 画面の右の端からはみ出しているものがない (横に流せる入れ物の中は除く)
// 気になること (失敗にはしない。p.notes に残す):
//   - 押せる所が小さい (28px 未満)

import { check, sleep } from './cdp.mjs';

/** 開いている画面を測る (ページの中で動かす) */
const MEASURE = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const name = el => (el.getAttribute('aria-label') || el.innerText || el.dataset.testid || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 24);
  const out = { header: null, wraps: [], clipped: [], small: [] };
  const h = document.querySelector('[data-testid="app-header"]');
  out.header = h && vis(h) ? Math.round(h.getBoundingClientRect().height) : null;
  // バーの中の文字の折り返し
  for (const bar of document.querySelectorAll('[data-testid="app-header"],[data-testid="bottom-tabs"],[data-testid="sidebar"]')) {
    if (!vis(bar)) continue;
    const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !vis(n.parentElement)) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      const tops = new Set([...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top / 4)));
      if (tops.size > 1) out.wraps.push(n.textContent.trim().slice(0, 24));
    }
  }
  // 短いボタンの文字の折り返し (ボタンの名前が 2 行に分かれる)
  out.btnWraps = [];
  for (const el of document.querySelectorAll('button')) {
    if (!vis(el)) continue;
    const text = el.innerText.trim();
    if (!text || text.length > 14 || text.includes(String.fromCharCode(10))) continue;
    // 文字の 1 かたまりが 2 行に分かれているか (アイコンと文字を縦に並べたボタンは数えない)
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      const tops = new Set([...r.getClientRects()].filter(x => x.width > 0 && x.height > 0).map(x => Math.round(x.top / 4)));
      if (tops.size > 1) { out.btnWraps.push(text); break; }
    }
  }
  // バーの中で、…で切れている文字 (幅が足りない)
  out.cut = [];
  for (const bar of document.querySelectorAll('[data-testid="app-header"],[data-testid="bottom-tabs"],[data-testid="sidebar"]')) {
    for (const el of bar.querySelectorAll('*')) {
      if (!vis(el) || getComputedStyle(el).textOverflow !== 'ellipsis') continue;
      if (el.scrollWidth > el.clientWidth + 1) out.cut.push(el.innerText.trim().slice(0, 24));
    }
  }
  // 右の端からのはみ出し (切り取る・流せる入れ物の中なら除く)
  const W = innerWidth;
  for (const el of document.querySelectorAll('#root *')) {
    const r = el.getBoundingClientRect();
    if (r.right <= W + 1 || r.left >= W || r.width === 0 || !vis(el)) continue;
    let a = el.parentElement, held = false;
    while (a && a !== document.body) {
      const cs = getComputedStyle(a);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && a.getBoundingClientRect().right <= W + 1) { held = true; break; }
      a = a.parentElement;
    }
    if (!held) out.clipped.push(name(el) + ' (右 ' + Math.round(r.right - W) + 'px)');
  }
  // 小さい押す所 (見えている所だけ)
  for (const el of document.querySelectorAll('button,a[href],select,input[type=checkbox],[role=button]')) {
    if (!vis(el) || el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) continue;
    if (Math.min(r.width, r.height) < 28) out.small.push(name(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  out.clipped = [...new Set(out.clipped)].slice(0, 6);
  out.small = [...new Set(out.small)];
  return out;
})()`;

/** 全部の画面を開いて測る。label はスクリーンショットの名前の頭 */
export async function sweepLayout(p, label) {
  const screens = (await p.ev(`window.__laploupe?.available ?? []`)).filter(s => s !== 'timer');
  check(screens.length > 0, `${label}: 画面の一覧が取れない`);
  const heights = new Map();
  const problems = [];
  for (const s of screens) {
    await p.ev(`window.__laploupe.go(${JSON.stringify(s)})`);
    await sleep(900);
    const m = await p.ev(MEASURE);
    await p.shot(`layout_${label}_${s}`);
    if (m.header !== null) heights.set(s, m.header);
    if (m.wraps.length) problems.push(`${s}: バーの文字が折り返している「${m.wraps.join('」「')}」`);
    if (m.btnWraps.length) problems.push(`${s}: ボタンの名前が折り返している「${[...new Set(m.btnWraps)].join('」「')}」`);
    if (m.cut.length) problems.push(`${s}: バーの文字が切れている「${m.cut.join('」「')}」`);
    if (m.clipped.length) problems.push(`${s}: 右の端からはみ出している ${m.clipped.join(', ')}`);
    if (m.small.length) p.notes.push(`${label} ${s}: 小さい押す所 ${m.small.length} 個 (${(process.env.E2E_VERBOSE ? m.small : m.small.slice(0, 4)).join(', ')}${!process.env.E2E_VERBOSE && m.small.length > 4 ? ' …' : ''})`);
  }
  const hs = [...heights.values()];
  if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 2) {
    problems.push(`上のバーの高さがそろっていない: ${[...heights].map(([s, h]) => `${s} ${h}px`).join(', ')}`);
  }
  check(problems.length === 0, `${label}:\n      ${problems.join('\n      ')}`);
}
