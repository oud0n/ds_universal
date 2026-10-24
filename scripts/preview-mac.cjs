// 確認用の Mac 版を作る (npm run dist:mac:preview)。アプリの名前を「LapLoupe Preview.app」にして、アプリケーションフォルダで
// 出している版 (LapLoupe.app) と見分けられるようにする。署名はアプリの中身にかかるので、名前を変えても崩れない。
// 設定・保存データの置き場所は同じ (同じ保管場所・コースで試せる)。2 つを同時に開かないこと
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'release', 'mac-arm64');
const from = path.join(dir, 'LapLoupe.app');
const to = path.join(dir, 'LapLoupe Preview.app');
if (!fs.existsSync(from)) { console.error('release/mac-arm64/LapLoupe.app がない'); process.exit(1); }
fs.rmSync(to, { recursive: true, force: true });
fs.renameSync(from, to);
console.log('built:', to);
