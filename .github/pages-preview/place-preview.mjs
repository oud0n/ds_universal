// 試験版の dist (preview-src/dist) を dist/preview に置く。.github/workflows/pages.yml から呼ぶ。
// 保存の名前を分けるスクリプト (preview-shim.js) を <title> の直後に差し込み、検索に載せない印を付ける。
// 試験版を作れなかったときは、そう書いたページを置く (本番は出す)
import fs from 'node:fs';

const ref = process.env.PREVIEW_REF ?? '';
const src = process.env.PREVIEW_DIST ?? 'preview-src/dist';
const out = process.env.PREVIEW_OUT ?? 'dist/preview';
const ok = process.env.BUILD_OK === 'success' && fs.existsSync(`${src}/index.html`);
const safeRef = ref.replace(/[<>&"']/g, '');
fs.mkdirSync(out, { recursive: true });
if (!ok) {
  fs.writeFileSync(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>試験版</title><p>試験版 (${safeRef}) を作れませんでした。GitHub の Actions のログを見てください。</p>`);
  console.log(`preview: build failed for ${safeRef}`);
  process.exit(0);
}
fs.cpSync(src, out, { recursive: true });
const shimPath = new URL('./preview-shim.js', import.meta.url);
const shim = fs.readFileSync(shimPath, 'utf8').replace("'__PREVIEW_REF__'", JSON.stringify(safeRef));
const html = fs.readFileSync(`${out}/index.html`, 'utf8');
if (!html.includes('</title>')) throw new Error('index.html に <title> がありません');
fs.writeFileSync(`${out}/index.html`, html.replace('</title>', `</title>\n    <meta name="robots" content="noindex" />\n    <script>${shim}</script>`));
console.log(`preview: placed ${safeRef}`);
