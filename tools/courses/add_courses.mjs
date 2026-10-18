// 海外のコースを courses/ に足す: node add_courses.mjs <courses dir> <id>...
// osm_<id>.json (preset.cl) / center_<id>.json / gates_<id>.json と下の META から .cln・.sci と index.json の項目を作る
import fs from 'node:fs';
const [dir, ...ids] = process.argv.slice(2);
const IMAGERY = {
  US: 'USGS NAIP の航空写真 (パブリックドメイン)',
  NL: 'Beeldmateriaal Nederland の航空写真 (PDOK、CC BY 4.0)',
  FR: 'IGN BD ORTHO の航空写真 (Licence Ouverte 2.0)',
  ES: 'PNOA の航空写真 (IGN España、CC BY 4.0)'
};
const META = {
  zandvoort: { name: 'Circuit Zandvoort', line: 'メインストレートに架かるスタートの信号のゲートの位置' },
  assen: { name: 'TT Circuit Assen', line: 'メインストレートに架かるゲートの位置' },
  cota: { name: 'Circuit of the Americas (COTA)', line: 'メインストレートに架かるスタートの信号のゲートの位置' },
  laguna_seca: { name: 'WeatherTech Raceway Laguna Seca', line: 'メインストレートに架かる歩道橋の位置' },
  watkins_glen: { name: 'Watkins Glen International', line: 'メインストレートの路面のスタート / フィニッシュの白い印の位置' },
  sebring: { name: 'Sebring International Raceway', line: 'メインストレートに架かる歩道橋の位置' },
  vir: { name: 'Virginia International Raceway (VIR)' },
  road_atlanta: { name: 'Michelin Raceway Road Atlanta', line: 'メインストレートに架かる歩道橋の位置' },
  mid_ohio: { name: 'Mid-Ohio Sports Car Course' },
  barber: { name: 'Barber Motorsports Park', line: 'メインストレートの管制塔の前 (推定。路面の印は確かめられなかった)' },
  lime_rock: { name: 'Lime Rock Park' }
};
const index = JSON.parse(fs.readFileSync(`${dir}/index.json`, 'utf8'));
const f6 = v => (+v).toFixed(6);
for (const id of ids) {
  const { preset } = JSON.parse(fs.readFileSync(`osm_${id}.json`, 'utf8'));
  const { ring } = JSON.parse(fs.readFileSync(`center_${id}.json`, 'utf8'));
  const { gates, length } = JSON.parse(fs.readFileSync(`gates_${id}.json`, 'utf8'));
  const m = META[id];
  const lats = ring.map(p => p[0]), lons = ring.map(p => p[1]);
  const center = [+((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(6), +((Math.min(...lons) + Math.max(...lons)) / 2).toFixed(6)];
  const cl = preset.cl;
  fs.writeFileSync(`${dir}/${id}.cln`, ['1', f6(cl.latA), f6(cl.lonA), f6(cl.latB), f6(cl.lonB)].join('\r\n') + '\r\n');
  fs.writeFileSync(`${dir}/${id}.sci`, gates.map(x => [x.latA, x.lonA, x.latB, x.lonB].map(f6).join(',') + ',1\r\n').join(''));
  const line = preset.clNote === 'pit' || !m.line
    ? 'スタートラインを航空写真で確かめられなかったため、ピットロードの中ほどに置いた仮の線 (OpenStreetMap のピットロードに直交)'
    : `${m.line} (${IMAGERY[preset.country]}で確認、ピットロードまで含む)`;
  const entry = {
    id, name: m.name, country: preset.country, center, cln: `${id}.cln`, sci: `${id}.sci`,
    notes: {
      controlLine: `${line}。2026-10-18 作成`,
      sectors: `公式の区切りが分からないため、1 周を 3 等分した仮の位置 (OpenStreetMap のコース中心線 ${length} m の上)。2026-10-18 作成`
    }
  };
  const i = index.findIndex(e => e.id === id);
  if (i >= 0) index[i] = entry; else index.push(entry);
  console.log(id, center, length);
}
fs.writeFileSync(`${dir}/index.json`, JSON.stringify(index, null, 2) + '\n');
