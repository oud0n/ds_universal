// osm_<id>.json から、計測線を横切る道を含む閉路を列挙し、長さを表示する。
// 使い方: node loops.mjs <id> [選ぶ閉路の番号] [reverse]
//  選んだら center_<id>.json (計測線の交点から走行方向に並べた中心線 [lat, lon][]) を書く
import fs from 'node:fs';
const [id, pick, rev] = process.argv.slice(2);
const { preset, osm } = JSON.parse(fs.readFileSync(`osm_${id}.json`, 'utf8'));
const nodes = new Map();
const ways = [];
for (const e of osm.elements) {
  if (e.type === 'node') nodes.set(e.id, [e.lat, e.lon]);
  else if (e.type === 'way' && !(process.env.EXCL && new RegExp(process.env.EXCL, 'i').test(e.tags?.name || '')) && !/pit|ピット/i.test(e.tags?.name || '') && !e.tags?.pit && e.tags?.raceway !== 'pitlane' && e.tags?.service !== 'pit') ways.push(e);
}
const cosLat = Math.cos(preset.lat * Math.PI / 180);
const xy = ([lat, lon]) => [(lon - preset.lon) * 111320 * cosLat, (lat - preset.lat) * 111320];
const dist = (a, b) => { const [ax, ay] = xy(a), [bx, by] = xy(b); return Math.hypot(ax - bx, ay - by); };

// 節点の次数 → 交差点で道を切って辺にする
const deg = new Map();
for (const w of ways) w.nodes.forEach((n, i) => {
  deg.set(n, (deg.get(n) || 0) + ((i === 0 || i === w.nodes.length - 1) ? 1 : 2));
});
const edges = []; // {a, b, chain: nodeIds}
for (const w of ways) {
  let cur = [w.nodes[0]];
  for (let i = 1; i < w.nodes.length; i++) {
    cur.push(w.nodes[i]);
    if ((deg.get(w.nodes[i]) !== 2 || i === w.nodes.length - 1)) {
      edges.push({ a: cur[0], b: cur[cur.length - 1], chain: cur, way: w.id, name: w.tags?.name || '' });
      cur = [w.nodes[i]];
    }
  }
}
// 2 次の端点どうしをつなぐ (別の way の端がつながっているだけの点)
const adj = new Map();
edges.forEach((e, i) => { e.len = e.chain.slice(1).reduce((s, n, k) => s + dist(nodes.get(e.chain[k]), nodes.get(n)), 0); for (const v of [e.a, e.b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i); } });

// 計測線を横切る辺
const cl = preset.cl;
const A = xy([cl.latA, cl.lonA]), B = xy([cl.latB, cl.lonB]);
function segX(p, q) {
  const [px, py] = xy(p), [qx, qy] = xy(q);
  const d = (B[0] - A[0]) * (qy - py) - (B[1] - A[1]) * (qx - px);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((px - A[0]) * (qy - py) - (py - A[1]) * (qx - px)) / d;
  const u = ((px - A[0]) * (B[1] - A[1]) - (py - A[1]) * (B[0] - A[0])) / d;
  return t >= -0.2 && t <= 1.2 && u >= 0 && u <= 1 ? u : null;
}
const crossEdges = [];
edges.forEach((e, i) => { for (let k = 0; k + 1 < e.chain.length; k++) { const u = segX(nodes.get(e.chain[k]), nodes.get(e.chain[k + 1])); if (u != null) crossEdges.push({ i, k, u }); } });
console.log(id, 'ways', ways.length, 'edges', edges.length, 'crossing edges', crossEdges.map(c => `${c.i}(${edges[c.i].name},${edges[c.i].len.toFixed(0)}m)`).join(' '));

// 横切る辺から始まる単純閉路を DFS で列挙 (辺の重複なし、頂点の重複なし)
const loops = [];
for (const c of crossEdges.slice(0, 2)) {
  const start = edges[c.i];
  const target = start.a;
  if (start.a === start.b) { loops.push({ path: [{ i: c.i, fwd: true }], len: start.len, start: c }); continue; }
  const seen = new Set([start.b]);
  const stack = [{ v: start.b, path: [{ i: c.i, fwd: true }], len: start.len }];
  let count = 0;
  while (stack.length && count < (+process.env.MAXN || 200000)) {
    count++;
    const { v, path, len } = stack.pop();
    if (len > (+process.env.MAXLEN || 9000)) continue;
    for (const ei of adj.get(v) || []) {
      if (path.some(p => p.i === ei)) continue;
      const e = edges[ei];
      const fwd = e.a === v;
      const w = fwd ? e.b : e.a;
      if (w === target) { loops.push({ path: [...path, { i: ei, fwd }], len: len + e.len, start: c }); continue; }
      if (seen.has(w) && path.length > 0 && pathHas(path, w)) continue;
      stack.push({ v: w, path: [...path, { i: ei, fwd }], len: len + e.len });
    }
  }
}
function pathHas(path, w) { for (const p of path) { const e = edges[p.i]; if (e.a === w || e.b === w) return true; } return false; }
const uniq = [];
const T = +(process.env.TARGET || 0);
for (const l of loops.sort((a, b) => T ? Math.abs(a.len - T) - Math.abs(b.len - T) : a.len - b.len)) if (!uniq.some(u => Math.abs(u.len - l.len) < 1 && u.path.length === l.path.length)) uniq.push(l);
uniq.slice(0, 8).forEach((l, i) => console.log(i, l.len.toFixed(0) + 'm', l.path.map(p => edges[p.i].name || p.i).filter((x, k, a) => a.indexOf(x) === k).join(' > ').slice(0, 150)));

if (pick !== undefined) {
  const l = uniq[+pick];
  let pts = [];
  for (const p of l.path) {
    const ch = edges[p.i].chain.map(n => nodes.get(n));
    const seq = p.fwd ? ch : [...ch].reverse();
    pts.push(...(pts.length ? seq.slice(1) : seq));
  }
  // 計測線の交点から始める
  const c = l.start;
  const e0 = edges[c.i];
  // 始めの辺は fwd、k 番目の区間で交差
  const a = nodes.get(e0.chain[c.k]), b = nodes.get(e0.chain[c.k + 1]);
  const [ax, ay] = xy(a), [bx, by] = xy(b);
  // 交点
  const d = (B[0] - A[0]) * (by - ay) - (B[1] - A[1]) * (bx - ax);
  const t = ((ax - A[0]) * (by - ay) - (ay - A[1]) * (bx - ax)) / d;
  const X = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
  const toLL = ([x, y]) => [preset.lat + y / 111320, preset.lon + x / (111320 * cosLat)];
  const P = toLL(X);
  // pts: chain[0..] → 交点は pts[c.k] と pts[c.k+1] の間
  let ring = [P, ...pts.slice(c.k + 1, pts.length - 1), ...pts.slice(0, c.k + 1), P];
  if (rev === 'CW' || rev === 'CCW') {
    // 走る向きに合わせる (符号付き面積が正なら反時計回り)
    let area = 0;
    for (let i = 1; i < ring.length; i++) { const [x1, y1] = xy(ring[i - 1]), [x2, y2] = xy(ring[i]); area += x1 * y2 - x2 * y1; }
    if ((area > 0 ? 'CCW' : 'CW') !== rev) ring = ring.reverse();
  } else if (rev) ring = ring.reverse();
  fs.writeFileSync(`center_${id}.json`, JSON.stringify({ preset, ring }));
  const L = ring.slice(1).reduce((s, p, k) => s + dist(ring[k], p), 0);
  console.log('wrote', ring.length, 'pts', L.toFixed(0), 'm');
}
