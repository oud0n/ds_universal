/**
 * OpenStreetMap (OSM) Overpass API を利用したサーキットコース形状の動的取得サービス
 */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const CACHE_PREFIX = 'ds_osm_circuit_';

/**
 * 指定した緯度経度の周辺にあるレーシングコース・トラックのポリラインを OSM から取得
 */
export async function fetchOsmCircuitPolylines(
  lat: number,
  lon: number,
  radiusMeters: number = 2000
): Promise<Array<Array<[number, number]>> | null> {
  const cacheKey = `${CACHE_PREFIX}${lat.toFixed(3)}_${lon.toFixed(3)}`;
  
  // 1. ローカルキャッシュ確認
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log('[OSM] ローカルキャッシュからコース形状をロード:', cacheKey);
        return parsed;
      }
    }
  } catch (e) {
    console.warn('[OSM] キャッシュ読み込みスキップ:', e);
  }

  // 2. Overpass API クエリ作成
  // highway=raceway (サーキット), leisure=track (サーキット/トラック)
  const query = `[out:json][timeout:15];(way["highway"="raceway"](around:${radiusMeters},${lat},${lon});way["leisure"="track"](around:${radiusMeters},${lat},${lon}););out body;>;out skel qt;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`[OSM] Overpass API に問い合わせ中 (${endpoint})...`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `data=${encodeURIComponent(query)}`
      });

      if (!response.ok) {
        console.warn(`[OSM] エンドポイント ${endpoint} レスポンスエラー: ${response.status}`);
        continue;
      }

      const json = await response.json();
      if (!json || !json.elements) continue;

      const nodes = new Map<number, [number, number]>();
      const ways: any[] = [];

      for (const el of json.elements) {
        if (el.type === 'node') {
          nodes.set(el.id, [el.lon, el.lat]);
        } else if (el.type === 'way') {
          ways.push(el);
        }
      }

      const polylines: Array<Array<[number, number]>> = [];
      for (const way of ways) {
        if (Array.isArray(way.nodes)) {
          const line: Array<[number, number]> = [];
          for (const nid of way.nodes) {
            const pt = nodes.get(nid);
            if (pt) line.push(pt);
          }
          if (line.length > 1) {
            polylines.push(line);
          }
        }
      }

      if (polylines.length > 0) {
        console.log(`[OSM] コース図取得成功: ${polylines.length} 本のポリライン`);
        try {
          localStorage.setItem(cacheKey, JSON.stringify(polylines));
        } catch {}
        return polylines;
      }
    } catch (err) {
      console.warn(`[OSM] エンドポイント ${endpoint} 接続エラー:`, err);
    }
  }

  return null;
}
