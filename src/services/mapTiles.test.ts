import { expect, it } from 'vitest';
import { photoTileCredits, tilesForView, type TilePlacement } from './mapTiles';

const tile = (zoom: number, bounds = { north: 35.5, south: 35.4, west: 140, east: 140.1 }): TilePlacement => ({ key: `photo/${zoom}/1/1`, url: '', ...bounds });
it('航空写真・Landsat縮小画像・世界衛星画像それぞれの出典を区別する', () => {
  expect(photoTileCredits(tile(18))).toEqual([]);
  expect(photoTileCredits(tile(13)).join()).toContain('Landsat8');
  expect(photoTileCredits(tile(9)).join()).toContain('GEBCO');
  expect(photoTileCredits(tile(8)).join()).toContain('NASA');
  expect(photoTileCredits(tile(5)).join()).toContain('USGS');
});
it('小さい拡大地図で実際に選ばれる縮小タイルにも追加出典を付ける', () => {
  const tiles = tilesForView('photo', { north: 35.405, south: 35.395, west: 140.085, east: 140.095 }, 2000 / 128);
  expect(tiles.length).toBeGreaterThan(0);
  expect(tiles.every(t => photoTileCredits(t).some(credit => credit.includes('Landsat8')))).toBe(true);
});
it('GRUS画像の範囲と交わる写真タイルだけAxelspaceを追加する', () => {
  expect(photoTileCredits(tile(18, { north: 20.45, south: 20.4, west: 136.05, east: 136.15 })).join()).toContain('Axelspace');
  expect(photoTileCredits(tile(18, { north: 20.3, south: 20.2, west: 136.05, east: 136.15 }))).toEqual([]);
});
