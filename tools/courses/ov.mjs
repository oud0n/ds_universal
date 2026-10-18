// 海外のコースのデータづくり
//  node ov.mjs fetch <id> <lat> <lon> <country>      OSM の raceway を取る (osm_<id>.json)
//  node ov.mjs crop <id> [lat lon] [span=500]        航空写真 + OSM の線 + マス目 (crop_<id>.png)。省略時はピットロードの中ほど
//  node ov.mjs line <id> x1 y1 x2 y2                 直前の crop の画素で計測線を決める (osm_<id>.json の preset.cl)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [cmd, id, ...a] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const file = `osm_${id}.json`;

async function overpass(q) {
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ds-universal-course-tool' }, body: 'data=' + encodeURIComponent(q) });
        if (r.ok) return await r.json();
        console.log('overpass', r.status);
      } catch (e) { console.log('overpass err', e.message); }
      await sleep(4000);
    }
  }
  throw new Error('overpass failed');
}

const isPit = w => /pit/i.test(w.tags?.name || '') || w.tags?.raceway === 'pitlane' || w.tags?.service === 'pit' || !!w.tags?.pit || w.tags?.highway === 'service' && /pit/i.test(JSON.stringify(w.tags));

if (cmd === 'fetch') {
  const [lat, lon, country] = a;
  const q = `[out:json][timeout:25];(way["highway"="raceway"](around:3000,${lat},${lon});way["raceway"](around:3000,${lat},${lon}););out body;>;out skel qt;`;
  const osm = await overpass(q);
  fs.writeFileSync(file, JSON.stringify({ preset: { id, lat: +lat, lon: +lon, country, cl: null }, osm }));
  const ways = osm.elements.filter(e => e.type === 'way');
  console.log(id, 'ways', ways.length, 'pit', ways.filter(isPit).map(w => w.tags?.name || w.id).join(','));
}

function loadOsm() {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = new Map();
  for (const e of j.osm.elements) if (e.type === 'node') nodes.set(e.id, [e.lat, e.lon]);
  const ways = j.osm.elements.filter(e => e.type === 'way');
  return { j, nodes, ways };
}

if (cmd === 'zoom' || cmd === 'crop') {
  const { j, nodes, ways } = loadOsm();
  let [clat, clon, span = 500] = cmd === 'crop' ? a.map(Number) : [];
  if (cmd === 'zoom') {
    // 直前の crop の画素 (x, y) を中心に、span m で撮り直す
    const prev = JSON.parse(fs.readFileSync(`crop_${id}.json`, 'utf8'));
    const [x, y, sp = 150] = a.map(Number);
    clat = prev.bb.n - y / prev.H * (prev.bb.n - prev.bb.s);
    clon = prev.bb.w + x / prev.W * (prev.bb.e - prev.bb.w);
    span = sp;
  }
  if (!clat) {
    const pits = ways.filter(isPit);
    const pts = pits.flatMap(w => w.nodes.map(n => nodes.get(n)).filter(Boolean));
    if (!pts.length) { console.log('no pit lane; give lat lon'); process.exit(1); }
    // ピットロードの点の、最も長い way の中央
    const w = pits.sort((x, y) => y.nodes.length - x.nodes.length)[0];
    const m = nodes.get(w.nodes[Math.floor(w.nodes.length / 2)]);
    [clat, clon] = m;
  }
  const c = j.preset.country;
  const dLat = span / 2 / 111320, dLon = span / 2 / (111320 * Math.cos(clat * Math.PI / 180));
  const bb = { s: clat - dLat, n: clat + dLat, w: clon - dLon, e: clon + dLon };
  const W = 1000, H = 1000;
  let url;
  if (c === 'US') url = `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox=${bb.w},${bb.s},${bb.e},${bb.n}&bboxSR=4326&imageSR=4326&size=${W},${H}&format=jpg&f=image`;
  else if (c !== 'JP') {
    const base = { FR: 'https://data.geopf.fr/wms-r/wms?LAYERS=ORTHOIMAGERY.ORTHOPHOTOS', ES: 'https://www.ign.es/wms-inspire/pnoa-ma?LAYERS=OI.OrthoimageCoverage', NL: 'https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?LAYERS=Actueel_orthoHR' }[c];
    url = `${base}&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&CRS=EPSG:4326&BBOX=${bb.s},${bb.w},${bb.n},${bb.e}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/jpeg`;
  }
  const X = lon => ((lon - bb.w) / (bb.e - bb.w) * W).toFixed(1), Y = lat => ((bb.n - lat) / (bb.n - bb.s) * H).toFixed(1);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">`;
  if (c === 'JP') {
    // 国土地理院 シームレス空中写真 (XYZ タイル) を並べる。狭い範囲なので、緯度の向きのメルカトルのゆがみは無視する
    const z = span > 1500 ? 16 : span > 600 ? 17 : 18, n = 2 ** z;
    const tx = lon => (lon + 180) / 360 * n, ty = lat => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;
    const lonOf = x => x / n * 360 - 180, latOf = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    for (let x = Math.floor(tx(bb.w)); x <= Math.floor(tx(bb.e)); x++) for (let y = Math.floor(ty(bb.n)); y <= Math.floor(ty(bb.s)); y++) {
      const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`);
      if (!r.ok) continue;
      const img = Buffer.from(await r.arrayBuffer());
      const x0 = +X(lonOf(x)), x1 = +X(lonOf(x + 1)), y0 = +Y(latOf(y)), y1 = +Y(latOf(y + 1));
      svg += `<image x="${x0}" y="${y0}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" preserveAspectRatio="none" xlink:href="data:image/jpeg;base64,${img.toString('base64')}"/>`;
    }
  } else {
    const r = await fetch(url);
    if (!r.ok) { console.log('imagery', r.status); process.exit(1); }
    const img = Buffer.from(await r.arrayBuffer());
    svg += `<image width="${W}" height="${H}" xlink:href="data:image/jpeg;base64,${img.toString('base64')}"/>`;
  }
  for (const w of ways) svg += `<polyline fill="none" stroke="${isPit(w) ? '#0ff' : '#f0f'}" stroke-opacity="0.5" stroke-width="1.5" points="${w.nodes.map(n => nodes.get(n)).filter(Boolean).map(p => X(p[1]) + ',' + Y(p[0])).join(' ')}"/>`;
  for (let g = 100; g < W; g += 100) svg += `<line x1="${g}" y1="0" x2="${g}" y2="${H}" stroke="#ff0" stroke-opacity="0.35"/><line x1="0" y1="${g}" x2="${W}" y2="${g}" stroke="#ff0" stroke-opacity="0.35"/><text x="${g + 2}" y="12" font-size="12" fill="#ff0">${g}</text><text x="2" y="${g - 2}" font-size="12" fill="#ff0">${g}</text>`;
  if (j.preset.cl) { const l = j.preset.cl; svg += `<line x1="${X(l.lonA)}" y1="${Y(l.latA)}" x2="${X(l.lonB)}" y2="${Y(l.latB)}" stroke="#0f0" stroke-width="2"/>`; }
  svg += `<text x="10" y="${H - 10}" font-size="14" fill="#fff">${span} m</text></svg>`;
  fs.writeFileSync(`crop_${id}.svg`, svg);
  fs.writeFileSync(`crop_${id}.json`, JSON.stringify({ bb, W, H }));
  try { fs.unlinkSync(`crop_${id}.svg.png`); } catch {}
  execFileSync('qlmanage', ['-t', '-s', String(W), '-o', '.', `crop_${id}.svg`], { stdio: 'ignore' });
  console.log('crop', `crop_${id}.svg.png`, 'center', clat.toFixed(6), clon.toFixed(6));
}

if (cmd === 'line') {
  const { j } = loadOsm();
  const { bb, W, H } = JSON.parse(fs.readFileSync(`crop_${id}.json`, 'utf8'));
  const [x1, y1, x2, y2] = a.map(Number);
  const ll = (x, y) => [bb.n - y / H * (bb.n - bb.s), bb.w + x / W * (bb.e - bb.w)];
  const A = ll(x1, y1), B = ll(x2, y2);
  j.preset.cl = { latA: +A[0].toFixed(6), lonA: +A[1].toFixed(6), latB: +B[0].toFixed(6), lonB: +B[1].toFixed(6) };
  fs.writeFileSync(file, JSON.stringify(j));
  console.log(id, JSON.stringify(j.preset.cl));
}

if (cmd === 'pitline') {
  // ピットロードの中ほどで、ピットロードに直交する長さ 2*hw m の線 (コースまで届くように)
  const { j, nodes, ways } = loadOsm();
  const hw = +(a[0] || 30);
  const w = ways.filter(isPit).sort((x, y) => y.nodes.length - x.nodes.length)[0];
  const pts = w.nodes.map(n => nodes.get(n)).filter(Boolean);
  const cosLat = Math.cos(pts[0][0] * Math.PI / 180);
  const xy = p => [p[1] * 111320 * cosLat, p[0] * 111320];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) { const [x1, y1] = xy(pts[i - 1]), [x2, y2] = xy(pts[i]); cum.push(cum[i - 1] + Math.hypot(x2 - x1, y2 - y1)); }
  const half = cum[cum.length - 1] / 2;
  let i = 1; while (cum[i] < half) i++;
  const [x1, y1] = xy(pts[i - 1]), [x2, y2] = xy(pts[i]);
  const t = (half - cum[i - 1]) / (cum[i] - cum[i - 1]);
  const cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t;
  const n = Math.hypot(x2 - x1, y2 - y1), nx = -(y2 - y1) / n, ny = (x2 - x1) / n;
  const ll = (x, y) => [+(y / 111320).toFixed(6), +(x / (111320 * cosLat)).toFixed(6)];
  const A = ll(cx + nx * hw, cy + ny * hw), B = ll(cx - nx * hw, cy - ny * hw);
  j.preset.cl = { latA: A[0], lonA: A[1], latB: B[0], lonB: B[1] };
  j.preset.clNote = 'pit';
  fs.writeFileSync(file, JSON.stringify(j));
  console.log(id, 'pitline', JSON.stringify(j.preset.cl));
}
