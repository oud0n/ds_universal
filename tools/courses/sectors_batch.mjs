// セクター線の無い内蔵のコースに、OpenStreetMap のコースの線で 1 周を 3 等分したセクター線を置く (2026-10-24)。
// 使い方: node sectors_batch.mjs [id...]   (省略すると index.json で sci の無いコース全部)
//   DRY=1 で courses/ に書かない。結果は sectors_batch.json と view_<id>.svg (確かめ用)
//
// 1 周の選び方: 計測線を横切る道を含む閉路のうち、いちばん長いもの (カートコースは、ショートカットを通らない全体の周がいちばん長い)。
// セクター線: 3 等分の位置 (±8% の範囲で、同じ周の離れた部分から 40 m 以上離れた位置にずらす) に、コースの線に直交する線。
// 半幅は 20 m まで、同じ周の離れた部分までの 4 割まで、ほかの道 (選んだ周に入らない道) までの 45% まで、最小 4 m。
// それでもほかの道と交わる位置は、±8% の範囲でずらして探し、見つからなければそのコースは作らない。
import fs from 'node:fs';
import path from 'node:path';

const COURSES = path.resolve('../../courses');
const index = JSON.parse(fs.readFileSync(`${COURSES}/index.json`, 'utf8'));
const want = process.argv.slice(2);
const targets = index.filter(c => (want.length ? want.includes(c.id) : !c.sci) && c.cln);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function overpass(q) {
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ds-universal-course-tool' }, body: 'data=' + encodeURIComponent(q) });
        if (r.ok) return await r.json();
        console.log('  overpass', r.status);
      } catch (e) { console.log('  overpass err', e.message); }
      await sleep(5000 * (i + 1));
    }
  }
  throw new Error('overpass failed');
}

function readCln(file) {
  const v = fs.readFileSync(`${COURSES}/${file}`, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number);
  return { latA: v[1], lonA: v[2], latB: v[3], lonB: v[4] };
}

const isPitWay = e => /pit|ピット/i.test(e.tags?.name || '') || !!e.tags?.pit || e.tags?.raceway === 'pitlane' || e.tags?.service === 'pit';

function build(c, osm) {
  const cl = readCln(c.cln);
  const lat0 = (cl.latA + cl.latB) / 2, lon0 = (cl.lonA + cl.lonB) / 2;
  const cosLat = Math.cos(lat0 * Math.PI / 180);
  const xy = ([lat, lon]) => [(lon - lon0) * 111320 * cosLat, (lat - lat0) * 111320];
  const ll = ([x, y]) => [lat0 + y / 111320, lon0 + x / (111320 * cosLat)];
  const nodes = new Map();
  for (const e of osm.elements) if (e.type === 'node') nodes.set(e.id, xy([e.lat, e.lon]));
  const allWays = osm.elements.filter(e => e.type === 'way' && e.nodes.every(n => nodes.has(n)));
  const ways = allWays.filter(e => !isPitWay(e));
  // 交差点で切って辺にする
  const deg = new Map();
  for (const w of ways) w.nodes.forEach((n, i) => deg.set(n, (deg.get(n) || 0) + (i === 0 || i === w.nodes.length - 1 ? 1 : 2)));
  const edges = [];
  for (const w of ways) {
    let cur = [w.nodes[0]];
    for (let i = 1; i < w.nodes.length; i++) {
      cur.push(w.nodes[i]);
      if (deg.get(w.nodes[i]) !== 2 || i === w.nodes.length - 1) { edges.push({ a: cur[0], b: cur[cur.length - 1], chain: cur }); cur = [w.nodes[i]]; }
    }
  }
  const d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const adj = new Map();
  edges.forEach((e, i) => { e.len = e.chain.slice(1).reduce((s, n, k) => s + d2(nodes.get(e.chain[k]), nodes.get(n)), 0); for (const v of [e.a, e.b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i); } });
  const A = xy([cl.latA, cl.lonA]), B = xy([cl.latB, cl.lonB]);
  const segX = (p, q, a = A, b = B) => {
    const d = (b[0] - a[0]) * (q[1] - p[1]) - (b[1] - a[1]) * (q[0] - p[0]);
    if (Math.abs(d) < 1e-9) return null;
    const t = ((p[0] - a[0]) * (q[1] - p[1]) - (p[1] - a[1]) * (q[0] - p[0])) / d;
    const u = ((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
  };
  const cross = [];
  edges.forEach((e, i) => { for (let k = 0; k + 1 < e.chain.length; k++) { const x = segX(nodes.get(e.chain[k]), nodes.get(e.chain[k + 1])); if (x) cross.push({ i, k, t: x.t }); } });
  if (!cross.length) return { ok: false, reason: '計測線を横切る OpenStreetMap の道が無い' };
  // 閉路を列挙 (計測線を横切る辺から)
  const loops = [];
  for (const c0 of cross.slice(0, 2)) {
    const start = edges[c0.i];
    if (start.a === start.b) { loops.push({ path: [{ i: c0.i, fwd: true }], len: start.len, start: c0 }); continue; }
    const stack = [{ v: start.b, path: [{ i: c0.i, fwd: true }], len: start.len, seen: new Set([start.a, start.b]) }];
    let count = 0;
    while (stack.length && count++ < 200000) {
      const { v, path: pth, len, seen } = stack.pop();
      if (len > 8000) continue;
      for (const ei of adj.get(v) || []) {
        if (pth.some(p => p.i === ei)) continue;
        const e = edges[ei];
        const fwd = e.a === v;
        const w = fwd ? e.b : e.a;
        if (w === start.a) { loops.push({ path: [...pth, { i: ei, fwd }], len: len + e.len, start: c0 }); continue; }
        if (seen.has(w)) continue;
        stack.push({ v: w, path: [...pth, { i: ei, fwd }], len: len + e.len, seen: new Set([...seen, w]) });
      }
    }
  }
  const usable = loops.filter(l => l.len >= 150);
  if (!usable.length) return { ok: false, reason: '計測線を通る 1 周が OpenStreetMap の道で作れない' };
  // 分かれ道での曲がり方 (度)。連絡路・ショートカットを通る周は、分かれ道で急に曲がる
  const ptsOf = l => { const out = []; for (const p of l.path) { const ch = edges[p.i].chain.map(n => nodes.get(n)); const seq = p.fwd ? ch : [...ch].reverse(); out.push(...(out.length ? seq.slice(1) : seq)); } return out; };
  const dirAt = (pts, i, step) => { let j = i; let acc = 0; while (j + step >= 0 && j + step < pts.length && acc < 12) { acc += d2(pts[j], pts[j + step]); j += step; } return [pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]]; };
  for (const l of usable) {
    const pts = ptsOf(l);
    let maxTurn = 0;
    let k = 0;
    for (let pi = 0; pi + 1 < l.path.length; pi++) {
      k += edges[l.path[pi].i].chain.length - 1;
      const a1 = dirAt(pts, k, -1), b1 = dirAt(pts, k, 1);
      const ang = Math.acos(Math.max(-1, Math.min(1, -(a1[0] * b1[0] + a1[1] * b1[1]) / ((Math.hypot(...a1) * Math.hypot(...b1)) || 1)))) * 180 / Math.PI;
      maxTurn = Math.max(maxTurn, ang);
    }
    l.maxTurn = Math.round(maxTurn);
  }
  // 分かれ道で 60 度より急に曲がらない周を先に、その中で長いもの
  usable.sort((a, b) => (a.maxTurn > 60) - (b.maxTurn > 60) || b.len - a.len);
  // PICK=<番号> で選ぶ (CANDS=1 で候補の図を作る)
  const loop = process.env.COMMON === '1' && process.env.PICK === undefined && !process.env.COMMONTOP
    ? usable.reduce((x, y) => (y.len > x.len ? y : x))
    : usable[+(process.env.PICK ?? 0)] ?? usable[0];
  if (process.env.CANDS === '1') globalThis.__cands = usable.slice(0, 9).map(l => ({ len: Math.round(l.len), maxTurn: l.maxTurn, pts: ptsOf(l).map(ll) }));
  // 周の点列 (計測線の交点から)
  let pts = [];
  for (const p of loop.path) {
    const ch = edges[p.i].chain.map(n => nodes.get(n));
    const seq = p.fwd ? ch : [...ch].reverse();
    pts.push(...(pts.length ? seq.slice(1) : seq));
  }
  const s = loop.start;
  const a = nodes.get(edges[s.i].chain[s.k]), b = nodes.get(edges[s.i].chain[s.k + 1]);
  const X = [A[0] + (B[0] - A[0]) * s.t, A[1] + (B[1] - A[1]) * s.t];
  void a; void b;
  const P = [X, ...pts.slice(s.k + 1, pts.length - 1), ...pts.slice(0, s.k + 1), X];
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + d2(P[i], P[i - 1]));
  const L = cum[cum.length - 1];
  const at = d => {
    const f = dd => { dd = ((dd % L) + L) % L; let j = 1; while (j < P.length - 1 && cum[j] < dd) j++; const tt = (dd - cum[j - 1]) / (cum[j] - cum[j - 1] || 1); return [P[j - 1][0] + (P[j][0] - P[j - 1][0]) * tt, P[j - 1][1] + (P[j][1] - P[j - 1][1]) * tt]; };
    const c = f(d), p = f(d - 10), q = f(d + 10);
    const dx = q[0] - p[0], dy = q[1] - p[1], n = Math.hypot(dx, dy) || 1;
    return { x: c[0], y: c[1], nx: -dy / n, ny: dx / n };
  };
  // 周に入っていない道の線分 (ほかの路面)
  const ringEdges = new Set(loop.path.map(p => p.i));
  const others = [];
  edges.forEach((e, i) => { if (!ringEdges.has(i)) for (let k = 0; k + 1 < e.chain.length; k++) others.push([nodes.get(e.chain[k]), nodes.get(e.chain[k + 1])]); });
  for (const w of allWays.filter(isPitWay)) for (let k = 0; k + 1 < w.nodes.length; k++) others.push([nodes.get(w.nodes[k]), nodes.get(w.nodes[k + 1])]);
  const segDist = (p, [u, v]) => { const dx = v[0] - u[0], dy = v[1] - u[1]; const t = Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p[0] - u[0] - t * dx, p[1] - u[1] - t * dy); };
  const NEAR = 15; // 同じ周で、線の前後この距離 (m) の中はまたいでよい (それより離れた部分は、ヘアピンの戻りなども含めて避ける)
  const ownClear = (d, g) => { let m = Infinity; for (let i = 0; i < P.length; i++) { const dd = Math.abs(cum[i] - d); if (Math.min(dd, L - dd) < NEAR) continue; m = Math.min(m, Math.hypot(P[i][0] - g.x, P[i][1] - g.y)); } return m; };
  const otherClear = g => others.reduce((m, sg) => Math.min(m, segDist([g.x, g.y], sg)), Infinity);
  const gateAt = d => {
    const g = at(d);
    // 短いコース (カートなど) は路面が狭いので、半幅は 12 m まで
    const h = Math.max(4, Math.min(L < 1500 ? 12 : 20, 0.4 * ownClear(d, g), 0.45 * otherClear(g)));
    const a1 = [g.x + g.nx * h, g.y + g.ny * h], b1 = [g.x - g.nx * h, g.y - g.ny * h];
    const hits = others.some(([u, v]) => segX(u, v, a1, b1)) || (() => {
      // 同じ周の離れた部分 (前後 60 m の外) と交わらない
      for (let i = 1; i < P.length; i++) { const dd = Math.min(Math.abs(cum[i] - d), Math.abs(cum[i - 1] - d)); if (Math.min(dd, L - dd) < NEAR) continue; if (segX(P[i - 1], P[i], a1, b1)) return true; }
      return false;
    })();
    return { d, h, a1, b1, hits, clear: Math.min(40, ownClear(d, g)) };
  };
  // COMMON=1: レイアウトを替えて走るコース (カートコースなど) は、上位の候補の周のどれもが通る道の上にだけセクター線を置く
  // (どのレイアウトで走っても、セクター線を通るように)。探す範囲は ±15%
  const common = process.env.COMMON === '1';
  let onCommon = () => true;
  if (common) {
    // 1 周として考えられる周 (いちばん長い周の 7 割以上の長さ) のどれもが通る道
    const maxLen = Math.max(...usable.map(l => l.len));
    // COMMONTOP=<数>: 長さでなく、分かれ道で急に曲がらない順の上位の周で見る (前のやり方。モーターランドSP など)
    const top = process.env.COMMONTOP ? usable.slice(0, +process.env.COMMONTOP) : usable.filter(l => l.len >= +(process.env.COMMONMIN ?? 0.7) * maxLen);
    const sets = top.map(l => new Set(l.path.map(p => p.i)));
    const shared = [...sets[0]].filter(i => sets.every(st => st.has(i)));
    const segs = shared.flatMap(i => edges[i].chain.slice(1).map((nid, k) => [nodes.get(edges[i].chain[k]), nodes.get(nid)]));
    onCommon = d => { const g = at(d); return segs.some(sg => segDist([g.x, g.y], sg) < 1.5); };
  }
  const span = common ? 0.15 : 0.08;
  const gates = [];
  for (const frac of [1 / 3, 2 / 3]) {
    const d0 = frac * L;
    let best = null;
    for (let dd = 0; dd <= span * L; dd += 3) {
      for (const sgn of dd === 0 ? [1] : [1, -1]) {
        if (!onCommon(d0 + sgn * dd)) continue;
        const g = gateAt(d0 + sgn * dd);
        if (g.hits) continue;
        const score = g.clear * 1000 - dd;
        if (!best || score > best.score) best = { ...g, score };
      }
    }
    if (!best) return { ok: false, reason: `${Math.round(frac * 3)}/3 の位置の近くに、ほかの路面にかからない${common ? ' (どの周も通る道の上の)' : ''}場所が無い` };
    gates.push(best);
  }
  // 計測線とセクター線が近すぎない (1 周の 15% 以上離れている)
  const minGap = common ? 0.1 : 0.15;
  if (gates.some(g => g.d < minGap * L || g.d > (1 - minGap) * L) || Math.abs(gates[1].d - gates[0].d) < minGap * L) return { ok: false, reason: 'セクター線が近すぎる' };
  const out = gates.map(g => { const A1 = ll(g.a1), B1 = ll(g.b1); return { d: Math.round(g.d), hw: +g.h.toFixed(1), latA: +A1[0].toFixed(6), lonA: +A1[1].toFixed(6), latB: +B1[0].toFixed(6), lonB: +B1[1].toFixed(6) }; });
  // 確かめ用の絵
  const allPts = [...P, ...others.flat()];
  const minX = Math.min(...allPts.map(p => p[0])) - 40, maxX = Math.max(...allPts.map(p => p[0])) + 40;
  const minY = Math.min(...allPts.map(p => p[1])) - 40, maxY = Math.max(...allPts.map(p => p[1])) + 40;
  const W = 900, sc = W / Math.max(maxX - minX, maxY - minY);
  const SX = p => ((p[0] - minX) * sc).toFixed(1), SY = p => ((maxY - p[1]) * sc).toFixed(1);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="100%" height="100%" fill="white"/><text x="10" y="24" font-size="20">${c.id} ${Math.round(L)} m</text>`;
  for (const [u, v] of others) svg += `<line x1="${SX(u)}" y1="${SY(u)}" x2="${SX(v)}" y2="${SY(v)}" stroke="#bbb" stroke-width="5"/>`;
  svg += `<polyline fill="none" stroke="#d22" stroke-width="2" points="${P.map(p => SX(p) + ',' + SY(p)).join(' ')}"/>`;
  svg += `<line x1="${SX(A)}" y1="${SY(A)}" x2="${SX(B)}" y2="${SY(B)}" stroke="#0a0" stroke-width="5"/>`;
  for (const g of gates) svg += `<line x1="${SX(g.a1)}" y1="${SY(g.a1)}" x2="${SX(g.b1)}" y2="${SY(g.b1)}" stroke="#06f" stroke-width="5"/>`;
  fs.writeFileSync(`view_${c.id}.svg`, svg + '</svg>');
  return { ok: true, length: Math.round(L), loops: usable.length, maxTurn: loop.maxTurn, common, gates: out };
}

const results = {};
for (const c of targets) {
  const file = `osm_${c.id}.json`;
  if (!fs.existsSync(file)) {
    const r = Math.min(3000, Math.max(500, c.mapRadius ?? 1500));
    const q = `[out:json][timeout:25];(way["highway"="raceway"](around:${r},${c.center[0]},${c.center[1]});way["raceway"](around:${r},${c.center[0]},${c.center[1]}););out body;>;out skel qt;`;
    try {
      const osm = await overpass(q);
      fs.writeFileSync(file, JSON.stringify({ preset: { id: c.id, lat: c.center[0], lon: c.center[1], country: c.country, cl: null }, osm }));
    } catch (e) {
      results[c.id] = { ok: false, reason: 'OpenStreetMap を取れない' };
      console.log(c.id, 'NG fetch');
      continue;
    }
    await sleep(2500);
  }
  const { osm } = JSON.parse(fs.readFileSync(file, 'utf8'));
  let r;
  try { r = build(c, osm); } catch (e) { r = { ok: false, reason: String(e.message) }; }
  results[c.id] = r;
  if (globalThis.__cands) { fs.writeFileSync(`cands_${c.id}.json`, JSON.stringify(globalThis.__cands)); globalThis.__cands = undefined; }
  console.log(c.id, r.ok ? `OK ${r.length} m (閉路 ${r.loops}, 曲がり ${r.maxTurn}°) hw ${r.gates.map(g => g.hw).join('/')}` : `NG ${r.reason}`);
}
fs.writeFileSync('sectors_batch.json', JSON.stringify(results, null, 1));
