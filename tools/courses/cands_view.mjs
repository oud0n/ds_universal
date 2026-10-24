// 1 周の候補 (sectors_batch.mjs を CANDS=1 で回すと cands_<id>.json ができる) を、国土地理院の航空写真に重ねて並べる (2026-10-24)。
// 使い方: node cands_view.mjs <id>   → candsview_<id>.svg.png (候補 0〜8。番号・長さ・分かれ道での曲がり方)
// 番号を選んだら PICK=<番号> node sectors_batch.mjs <id> で作り直す
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const id = process.argv[2];
// result: 選んだ周 (候補の PICK 番号) と、作ったセクター線 (sectors_batch.json) を 1 枚で
const result = process.argv[3] === 'result';
let cands = JSON.parse(fs.readFileSync(`cands_${id}.json`, 'utf8'));
const res = result ? JSON.parse(fs.readFileSync('sectors_batch.json', 'utf8'))[id] : null;
if (result) cands = [cands[+(process.env.PICK ?? 0)]];
const index = JSON.parse(fs.readFileSync('../../courses/index.json', 'utf8'));
const c = index.find(x => x.id === id);
const clv = fs.readFileSync(`../../courses/${c.cln}`, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number);
const cl = { latA: clv[1], lonA: clv[2], latB: clv[3], lonB: clv[4] };
const all = cands.flatMap(k => k.pts);
let s = Math.min(...all.map(p => p[0])), n = Math.max(...all.map(p => p[0])), w = Math.min(...all.map(p => p[1])), e = Math.max(...all.map(p => p[1]));
const cosLat = Math.cos((s + n) / 2 * Math.PI / 180);
// 正方形にして、まわりに 15% の余白
const hM = (n - s) * 111320, wM = (e - w) * 111320 * cosLat, side = Math.max(hM, wM) * 1.3;
const cLat = (s + n) / 2, cLon = (w + e) / 2;
s = cLat - side / 2 / 111320; n = cLat + side / 2 / 111320;
w = cLon - side / 2 / (111320 * cosLat); e = cLon + side / 2 / (111320 * cosLat);
const W = 600;
const X = lon => ((lon - w) / (e - w) * W).toFixed(1), Y = lat => ((n - lat) / (n - s) * W).toFixed(1);
const z = side > 1500 ? 16 : side > 700 ? 17 : 18, N = 2 ** z;
const tx = lon => (lon + 180) / 360 * N, ty = lat => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * N;
const lonOf = x => x / N * 360 - 180, latOf = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N))) * 180 / Math.PI;
let photo = '';
for (let x = Math.floor(tx(w)); x <= Math.floor(tx(e)); x++) for (let y = Math.floor(ty(n)); y <= Math.floor(ty(s)); y++) {
  const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`);
  if (!r.ok) continue;
  const img = Buffer.from(await r.arrayBuffer());
  const x0 = +X(lonOf(x)), x1 = +X(lonOf(x + 1)), y0 = +Y(latOf(y)), y1 = +Y(latOf(y + 1));
  photo += `<image x="${x0}" y="${y0}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" preserveAspectRatio="none" href="data:image/jpeg;base64,${img.toString('base64')}"/>`;
}
const cols = 3, rows = Math.ceil(cands.length / cols);
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * W}" height="${rows * W}"><defs><g id="photo">${photo}</g></defs>`;
cands.forEach((k, i) => {
  const ox = (i % cols) * W, oy = Math.floor(i / cols) * W;
  svg += `<svg x="${ox}" y="${oy}" width="${W}" height="${W}"><use href="#photo"/>`;
  svg += `<polyline fill="none" stroke="#f22" stroke-width="2.5" stroke-opacity="0.9" points="${k.pts.map(p => X(p[1]) + ',' + Y(p[0])).join(' ')}"/>`;
  svg += `<line x1="${X(cl.lonA)}" y1="${Y(cl.latA)}" x2="${X(cl.lonB)}" y2="${Y(cl.latB)}" stroke="#0f0" stroke-width="3"/>`;
  if (res?.gates) for (const g of res.gates) svg += `<line x1="${X(g.lonA)}" y1="${Y(g.latA)}" x2="${X(g.lonB)}" y2="${Y(g.latB)}" stroke="#2af" stroke-width="4"/>`;
  svg += `<rect x="0" y="0" width="${W}" height="26" fill="#000" fill-opacity="0.6"/><text x="8" y="19" font-size="16" fill="#fff">${id} #${i}  ${k.len} m  曲がり ${k.maxTurn}°</text></svg>`;
});
svg += '</svg>';
const outName = result ? `result_${id}.svg` : `candsview_${id}.svg`;
fs.writeFileSync(outName, svg);
try { fs.unlinkSync(`${outName}.png`); } catch {}
execFileSync('qlmanage', ['-t', '-s', String(cols * W), '-o', '.', outName], { stdio: 'ignore' });
console.log(`${outName}.png`, cands.length, 'candidates');
