/**
 * コース図の背景に敷く地図タイル (国土地理院タイル)
 *
 * API キーは不要。利用時は出典 (国土地理院) の表示が必要。
 * https://maps.gsi.go.jp/development/ichiran.html
 */

export type MapBackground = 'none' | 'photo' | 'standard';

interface TileSource {
  label: string;
  url: (z: number, x: number, y: number) => string;
  maxZoom: number;
}

export const TILE_SOURCES: Record<Exclude<MapBackground, 'none'>, TileSource> = {
  photo: {
    label: '航空写真',
    url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`,
    maxZoom: 18
  },
  standard: {
    label: '地図',
    url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/std/${z}/${x}/${y}.png`,
    maxZoom: 18
  }
};

export const TILE_ATTRIBUTION = { text: '出典: 国土地理院', url: 'https://maps.gsi.go.jp/development/ichiran.html' };

// 1 画面に敷くタイル数の上限 (超える場合はズームレベルを下げる)
const MAX_TILES_PER_VIEW = 60;
const CACHE_LIMIT = 400;
const MIN_ZOOM = 5;

export interface TilePlacement {
  key: string;
  url: string;
  // タイルの北西端・南東端の緯度経度
  north: number;
  south: number;
  west: number;
  east: number;
}

function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/**
 * 表示範囲を覆うタイルの一覧を返す。
 * metersPerPixel: 画面上の 1 ピクセルが表す距離。これに近い解像度のズームレベルを選ぶ
 */
export function tilesForView(
  background: Exclude<MapBackground, 'none'>,
  bounds: { north: number; south: number; west: number; east: number },
  metersPerPixel: number
): TilePlacement[] {
  const source = TILE_SOURCES[background];
  const latMid = (bounds.north + bounds.south) / 2;
  // ズーム z のタイル 1 ピクセルは 156543.03 * cos(緯度) / 2^z メートル
  const ideal = Math.log2((156543.03 * Math.cos((latMid * Math.PI) / 180)) / Math.max(metersPerPixel, 0.01));
  let z = Math.max(MIN_ZOOM, Math.min(source.maxZoom, Math.round(ideal)));

  for (; z >= MIN_ZOOM; z--) {
    const x0 = Math.floor(lonToTileX(bounds.west, z));
    const x1 = Math.floor(lonToTileX(bounds.east, z));
    const y0 = Math.floor(latToTileY(bounds.north, z));
    const y1 = Math.floor(latToTileY(bounds.south, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES_PER_VIEW) continue;

    const tiles: TilePlacement[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        tiles.push({
          key: `${background}/${z}/${x}/${y}`,
          url: source.url(z, x, y),
          north: tileYToLat(y, z),
          south: tileYToLat(y + 1, z),
          west: tileXToLon(x, z),
          east: tileXToLon(x + 1, z)
        });
      }
    }
    return tiles;
  }
  return [];
}

type CacheEntry = { image: HTMLImageElement; state: 'loading' | 'ready' | 'error' };
const cache = new Map<string, CacheEntry>();

/**
 * タイル画像を返す。未取得の場合は読み込みを始めて null を返し、読み込み完了時に onLoad を呼ぶ
 */
export function getTileImage(tile: TilePlacement, onLoad: () => void): HTMLImageElement | null {
  const hit = cache.get(tile.key);
  if (hit) {
    // 最近使ったものを末尾へ移す (古いものから捨てるため)
    cache.delete(tile.key);
    cache.set(tile.key, hit);
    return hit.state === 'ready' ? hit.image : null;
  }

  const image = new Image();
  // 動画書き出し等で canvas を読み出せるよう、CORS 付きで取得する
  image.crossOrigin = 'anonymous';
  const entry: CacheEntry = { image, state: 'loading' };
  image.onload = () => {
    entry.state = 'ready';
    onLoad();
  };
  image.onerror = () => {
    // 圏外や未整備の範囲。再取得を繰り返さないよう失敗として覚えておく
    entry.state = 'error';
  };
  image.src = tile.url;
  cache.set(tile.key, entry);

  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return null;
}
