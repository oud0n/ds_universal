// 使い方のページ (public/help/) を作る (PLAN-39)。中身は pages.mjs。使い方: node scripts/help/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './pages.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/help');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 本文の中の [ボタン] を、ボタンの名前の札にする。**強調** も使える
const inline = s => esc(s).replace(/\[([^\]]+)\]/g, '<span class="ui">$1</span>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
const DEV = { phone: 'd-iphone d-android', iphone: 'd-iphone', android: 'd-android', desktop: 'd-desktop', browser: 'd-browser', pc: 'd-desktop d-browser' };
const devClass = list => (list ? `dev ${list.split(' ').map(d => DEV[d]).join(' ')}` : '');
const both = (v, cls = '') => `<span class="l-ja${cls}">${inline(v[0])}</span><span class="l-en${cls}">${inline(v[1])}</span>`;

const HEADER = `  <header class="top">
    <a class="home" href="index.html" data-keep><span class="l-ja">LapLoupe の使い方</span><span class="l-en">LapLoupe guide</span></a>
    <div class="switch" role="group" aria-label="device">
      <button data-set-device="iphone">iPhone</button><button data-set-device="android">Android</button><button data-set-device="desktop"><span class="l-ja">デスクトップ</span><span class="l-en">Desktop</span></button><button data-set-device="browser"><span class="l-ja">ブラウザ</span><span class="l-en">Browser</span></button>
    </div>
    <div class="switch" role="group" aria-label="language"><button data-set-lang="ja">日本語</button><button data-set-lang="en">English</button></div>
  </header>`;

// 検索に出す説明と正しい URL (2026-10-28。使い方のページを検索で見つけてもらうため)
const SITE = 'https://oud0n.github.io/ds_universal/help/';
const plain = s => s.replace(/\[([^\]]+)\]/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
const descOf = lead => { const t = plain(lead[0]).replace(/\s+/g, ' ').trim(); return [...t].length > 120 ? `${[...t].slice(0, 119).join('')}…` : t; };

const head = (titleJa, titleEn, desc, file) => `<!doctype html>
<html lang="ja" data-lang="ja" data-device="iphone">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-ja="${esc(titleJa)}" data-en="${esc(titleEn)}">${esc(titleJa)}</title>
<meta name="description" content="${esc(desc).replace(/"/g, '&quot;')}">
<link rel="canonical" href="${SITE}${file === 'index.html' ? '' : file}">
<link rel="stylesheet" href="help.css">
<script src="help.js" defer></script>
</head>
<body>
<main>
${HEADER}
`;

/** 写真 (img: { phone: 'b1/phone-1', desktop: 'c1/desktop-1', pc: ... }) */
function figures(img) {
  if (!img) return '';
  return Object.entries(img).map(([dev, name]) => {
    const [dir, file] = name.replace('!wide', '').split('/');
    const [kind, n] = file.split('-');
    // !wide: 横長のスマートフォンの写真 (折りたたみの iPhone を開いた画面) は幅いっぱいに出す
    const isPhone = kind === 'phone' && !name.endsWith('!wide');
    const wide = dev === 'desktop' || dev === 'pc' ? (name.endsWith('!narrow') ? ' style="max-width:560px"' : '') : '';
    const nn = n.replace('!narrow', '');
    return `<figure class="${isPhone ? 'phone ' : ''}${devClass(dev)}"${wide}><img class="l-ja" src="img/${dir}/${kind}-ja-${nn}.webp" alt="" loading="lazy"><img class="l-en" src="img/${dir}/${kind}-en-${nn}.webp" alt="" loading="lazy"></figure>`;
  }).join('\n      ');
}

/** 文 (text: [ja, en] か、端末ごと { phone: [ja, en], desktop: [...] }) */
function texts(t) {
  if (Array.isArray(t)) return both(t);
  return Object.entries(t).map(([dev, v]) => `<span class="${devClass(dev)}">${both(v)}</span>`).join(' ');
}

function page(p, i) {
  let html = head(`${p.title[0]} — LapLoupe の使い方`, `${p.title[1]} — LapLoupe guide`, descOf(p.lead), p.file);
  html += `\n  <h1>${both(p.title)}</h1>\n  <p class="lead">${both(p.lead)}</p>\n`;
  // 操作の動画 (字幕は日本語・英語の両方が入っている。音なし)
  if (p.video) html += `\n  <figure class="video"><video data-src="video/${p.video}.mp4" controls playsinline muted preload="metadata"></video></figure>\n`;
  for (const b of p.blocks) {
    const cls = devClass(b.dev);
    if (b.note) html += `\n  <div class="note ${cls}">${texts(b.note)}</div>\n`;
    if (b.h2) html += `\n  <h2 class="${cls}">${both(b.h2)}</h2>\n`;
    if (b.steps) {
      html += `\n  <ol class="steps ${cls}">\n`;
      for (const s of b.steps) {
        html += `    <li class="${devClass(s.dev)}">\n      ${texts(s.text)}\n      ${figures(s.img)}\n${s.note ? `      <div class="note">${texts(s.note)}</div>\n` : ''}    </li>\n`;
      }
      html += '  </ol>\n';
    }
    if (b.qa) {
      for (const [q, a] of b.qa) html += `\n  <h2>${both(q)}</h2>\n  <p>${texts(a)}</p>\n`;
    }
  }
  const prev = PAGES[i - 1], next = PAGES[i + 1];
  html += `\n  <div class="pager">\n    ${prev ? `<a href="${prev.file}" data-keep>← ${both(prev.title)}</a>` : '<a href="index.html" data-keep><span class="l-ja">← 目次</span><span class="l-en">← Contents</span></a>'}\n    ${next ? `<a href="${next.file}" data-keep>${both(next.title)} →</a>` : ''}\n  </div>\n</main>\n</body>\n</html>\n`;
  return html;
}

function index() {
  let html = head('LapLoupe の使い方 (デジスパイス対応の走行ログ解析アプリ)', 'LapLoupe guide', 'LapLoupe (非公式、デジスパイスなどの GPS ロガーの走行ログ解析アプリ) の使い方。iPhone・Android・デスクトップ (Mac・Windows)・ブラウザごとの手順と画面。走行の測り方、解析、車載動画の同期と書き出し。', 'index.html');
  html += `\n  <h1><span class="l-ja">LapLoupe の使い方</span><span class="l-en">LapLoupe guide</span></h1>
  <p class="lead">
    <span class="l-ja">やりたいことから選んでください。上で使っている端末を選ぶと、その端末の手順と画面に変わります。</span>
    <span class="l-en">Pick what you want to do. Choose your device above to see its steps and screens.</span>
  </p>
  <nav class="toc">
    <ul>
${PAGES.map(p => `      <li><a href="${p.file}" data-keep>${p.id} ${both(p.title)}</a></li>`).join('\n')}
    </ul>
  </nav>
</main>
</body>
</html>
`;
  return html;
}

for (const [i, p] of PAGES.entries()) fs.writeFileSync(path.join(OUT, p.file), page(p, i));
fs.writeFileSync(path.join(OUT, 'index.html'), index());
// サイトマップ (public/sitemap.xml)。トップと使い方のページ。Search Console に送る
const today = new Date().toISOString().slice(0, 10);
const urls = ['https://oud0n.github.io/ds_universal/', SITE, ...PAGES.map(p => SITE + p.file)];
fs.writeFileSync(path.join(OUT, '../sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>\n    <loc>${u}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`).join('\n')}
</urlset>
`);
// 写真が足りないページを知らせる
for (const p of PAGES) for (const b of p.blocks) for (const s of b.steps ?? []) for (const name of Object.values(s.img ?? {})) {
  const [dir, file] = name.replace('!narrow', '').replace('!wide', '').split('/');
  const [kind, n] = file.split('-');
  for (const lang of ['ja', 'en']) if (!fs.existsSync(path.join(OUT, 'img', dir, `${kind}-${lang}-${n}.webp`))) console.warn(`写真がない: ${p.id} img/${dir}/${kind}-${lang}-${n}.webp`);
}
for (const p of PAGES) if (p.video && !fs.existsSync(path.join(OUT, 'video', `${p.video}.mp4`))) console.warn(`動画がない: ${p.id} video/${p.video}.mp4`);
console.log(`${PAGES.length} ページと目次を作りました`);
