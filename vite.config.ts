import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// GitHub Pages のブラウザ版だけに、アクセス数の計測 (GoatCounter) を入れる。
// デスクトップ版 (Electron) と開発中のビルドには入れない (pages.yml が PAGES_BUILD=1 でビルドする)
const GC_TAG = '    <script data-goatcounter="https://oudon.goatcounter.com/count"\n            async src="//gc.zgo.at/count.js"></script>\n  </head>';
// public/ のページ (使い方の help/・Mac で使う方法など) は dist に写るだけなので、書き出したあとに足す。
// アプリにも同じ dist が入るが、PAGES_BUILD のときだけなのでアプリの中では数えない
const addToPublicPages = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'assets' && e.name !== 'preview') addToPublicPages(p); continue; }
    if (!e.name.endsWith('.html') || e.name.startsWith('google')) continue;
    const html = readFileSync(p, 'utf8');
    if (html.includes('data-goatcounter') || !html.includes('</head>')) continue;
    writeFileSync(p, html.replace('</head>', GC_TAG));
  }
};
let outDir = 'dist';
const goatCounter = (): Plugin => ({
  name: 'goatcounter',
  configResolved: c => { outDir = c.build.outDir; },
  transformIndexHtml: html =>
    process.env.PAGES_BUILD === '1' ? html.replace('</head>', GC_TAG) : html,
  closeBundle: () => { if (process.env.PAGES_BUILD === '1') addToPublicPages(outDir); }
});

const ADDONS_DIR = process.env.LAPLOUPE_ADDONS_DIR ? resolve(process.env.LAPLOUPE_ADDONS_DIR) : null;
const ADDONS_ID = 'virtual:laploupe-addons';
const SRC = fileURLToPath(new URL('./src', import.meta.url));
const addons = (): Plugin => ({
  name: 'laploupe-addons',
  enforce: 'pre',
  resolveId: id => id === ADDONS_ID
    ? (ADDONS_DIR ? join(ADDONS_DIR, 'src/index.ts') : join(SRC, 'addons/none.ts'))
    : null,
  transform: (code, id) => ADDONS_DIR && id.split('?')[0] === join(SRC, 'index.css')
    ? `${code}\n@source ${JSON.stringify(join(ADDONS_DIR, 'src'))};\n`
    : null
});

export default defineConfig({
  plugins: [
    addons(),
    react(),
    tailwindcss(),
    goatCounter()
  ],
  resolve: {
    alias: { '@app': SRC }
  },
  base: './',
  server: {
    port: 5173,
    host: true,
    ...(ADDONS_DIR ? { fs: { allow: ['.', ADDONS_DIR] } } : {})
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: !ADDONS_DIR
  }
});
