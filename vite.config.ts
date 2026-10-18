import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

// GitHub Pages のブラウザ版だけに、アクセス数の計測 (GoatCounter) を入れる。
// デスクトップ版 (Electron) と開発中のビルドには入れない (pages.yml が PAGES_BUILD=1 でビルドする)
const goatCounter = (): Plugin => ({
  name: 'goatcounter',
  transformIndexHtml: html =>
    process.env.PAGES_BUILD === '1'
      ? html.replace(
          '</head>',
          '    <script data-goatcounter="https://oudon.goatcounter.com/count"\n            async src="//gc.zgo.at/count.js"></script>\n  </head>'
        )
      : html
});

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    goatCounter()
  ],
  base: './',
  server: {
    port: 5173,
    host: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true
  }
});
