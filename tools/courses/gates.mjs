// center_<id>.json の中心線に、指定した距離 (m。0〜1 なら 1 周に対する割合) のセクター線を置く。
// SVG (OSM の道=灰、選んだ周=赤、200 m ごとの距離、セクター線=青) と gates_<id>.json を書く
// 使い方: node gates.mjs <id> d1,d2,... [半幅m=20]
import fs from 'node:fs';
const [id, ds, hw = '20'] = process.argv.slice(2);
const { preset, ring } = JSON.parse(fs.readFileSync(`center_${id}.json`, 'utf8'));
const { osm } = JSON.parse(fs.readFileSync(`osm_${id}.json`, 'utf8'));
const cosLat = Math.cos(preset.lat * Math.PI / 180);
const xy = ([lat, lon]) => [(lon - preset.lon) * 111320 * cosLat, (lat - preset.lat) * 111320];
const ll = ([x, y]) => [preset.lat + y / 111320, preset.lon + x / (111320 * cosLat)];
const P = ring.map(xy);
const cum = [0];
for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
const L = cum[cum.length - 1];
function at(d) {
  let i = 1; while (i < P.length - 1 && cum[i] < d) i++;
  const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  const x = P[i - 1][0] + (P[i][0] - P[i - 1][0]) * t, y = P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t;
  // 向きは前後 15 m の点から
  const f = (dd) => { dd = Math.max(0, Math.min(L, dd)); let j = 1; while (j < P.length - 1 && cum[j] < dd) j++; const tt = (dd - cum[j - 1]) / (cum[j] - cum[j - 1] || 1); return [P[j - 1][0] + (P[j][0] - P[j - 1][0]) * tt, P[j - 1][1] + (P[j][1] - P[j - 1][1]) * tt]; };
  const a = f(d - 15), b = f(d + 15);
  const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy);
  return { x, y, nx: -dy / n, ny: dx / n };
}
const dists = ds ? ds.split(',').map(Number).map(v => (v > 0 && v < 1 ? v * L : v)) : [];
// 半幅は、同じ周の離れた部分 (前後 80 m を除く) までの距離の 4 割まで (並行する直線をまたがないように)
function clearance(d, g) { let m = Infinity; for (let i = 0; i < P.length; i++) { const dd = Math.abs(cum[i] - d); if (Math.min(dd, L - dd) < 80) continue; m = Math.min(m, Math.hypot(P[i][0] - g.x, P[i][1] - g.y)); } return m; }
// ADJUST=1: 等分の位置から ±8% の範囲で、ほかの部分から 40 m 以上離れた一番近い位置にずらす (並行する直線のそばを避ける)
const adj = process.env.ADJUST === '1';
const dists2 = dists.map(d0 => {
  if (!adj) return d0;
  let best = d0, bestScore = -Infinity;
  for (let dd = -0.08 * L; dd <= 0.08 * L; dd += 5) {
    const c = Math.min(40, clearance(d0 + dd, at(d0 + dd)));
    const score = c * 1000 - Math.abs(dd);
    if (score > bestScore) { bestScore = score; best = d0 + dd; }
  }
  return best;
});
dists.splice(0, dists.length, ...dists2);
const gates = dists.map(d => { const g = at(d); const h = Math.min(+hw, Math.max(6, 0.4 * clearance(d, g))); const A = ll([g.x + g.nx * h, g.y + g.ny * h]), B = ll([g.x - g.nx * h, g.y - g.ny * h]); return { d: Math.round(d), hw: +h.toFixed(1), latA: +A[0].toFixed(6), lonA: +A[1].toFixed(6), latB: +B[0].toFixed(6), lonB: +B[1].toFixed(6) }; });
fs.writeFileSync(`gates_${id}.json`, JSON.stringify({ id, length: Math.round(L), gates }, null, 1));
console.log(id, 'lap', L.toFixed(0), 'm', JSON.stringify(gates));

// SVG
const nodes = new Map();
for (const e of osm.elements) if (e.type === 'node') nodes.set(e.id, xy([e.lat, e.lon]));
const all = P.slice();
const minX = Math.min(...all.map(p => p[0])) - 80, maxX = Math.max(...all.map(p => p[0])) + 80;
const minY = Math.min(...all.map(p => p[1])) - 80, maxY = Math.max(...all.map(p => p[1])) + 80;
const span = Math.max(maxX - minX, maxY - minY); const W = 1600, H = 1600, s = W / span;
const X = p => ((p[0] - minX) * s).toFixed(1), Y = p => ((maxY - p[1]) * s).toFixed(1);
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="white"/>`;
for (const e of osm.elements) if (e.type === 'way') svg += `<polyline fill="none" stroke="#bbb" stroke-width="6" points="${e.nodes.map(n => nodes.get(n)).filter(Boolean).map(p => X(p) + ',' + Y(p)).join(' ')}"/>`;
svg += `<polyline fill="none" stroke="#d22" stroke-width="2" points="${P.map(p => X(p) + ',' + Y(p)).join(' ')}"/>`;
for (let d = 0; d < L; d += 200) { const g = at(d); svg += `<circle cx="${X([g.x, g.y])}" cy="${Y([g.x, g.y])}" r="4" fill="#d22"/><text x="${+X([g.x, g.y]) + 6}" y="${+Y([g.x, g.y]) - 6}" font-size="16" fill="#000">${d}</text>`; }
for (const g of gates) { const a = xy([g.latA, g.lonA]), b = xy([g.latB, g.lonB]); svg += `<line x1="${X(a)}" y1="${Y(a)}" x2="${X(b)}" y2="${Y(b)}" stroke="#06f" stroke-width="5"/><text x="${X(a)}" y="${Y(a)}" font-size="20" fill="#06f">${g.d}</text>`; }
const c = preset.cl; const ca = xy([c.latA, c.lonA]), cb = xy([c.latB, c.lonB]);
svg += `<line x1="${X(ca)}" y1="${Y(ca)}" x2="${X(cb)}" y2="${Y(cb)}" stroke="#0a0" stroke-width="6"/>`;
if (fs.existsSync(`log_${id}.json`)) { const lg = JSON.parse(fs.readFileSync(`log_${id}.json`, 'utf8')); for (const q of lg) { const v = xy(q); svg += `<circle cx="${X(v)}" cy="${Y(v)}" r="1.2" fill="#f90"/>`; } }
svg += '</svg>';
fs.writeFileSync(`view_${id}.svg`, svg);
