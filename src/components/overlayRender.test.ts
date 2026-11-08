import { beforeEach, expect, it, vi } from 'vitest';
import type { Session, TelemetryPoint } from '../types/telemetry';
import { getTileImage, photoTileCredits } from '../services/mapTiles';
import { renderOverlayParts } from './overlayRender';

vi.mock('../services/mapTiles', () => ({
  tilesForView: () => [{ north: 35.01, south: 34.99, west: 139.99, east: 140.01 }],
  getTileImage: vi.fn(),
  photoTileCredits: vi.fn(() => [] as string[])
}));
vi.mock('../utils/i18n', () => ({ tr: (ja: string) => ja }));

const point: TelemetryPoint = { index: 0, time: 0, latitude: 35, longitude: 140, altitude: 0, speed: 50, heading: 0, distance: 0, accelG: 0, corneringG: 0, combinedG: 0, turningRadius: 0, driftAngle: 0 };
const session = { points: [point], laps: [], bestLapIndex: -1, pathPolylines: [] } as unknown as Session;
const part = { id: 'photo', type: 'zoomMap' as const, x: 0, y: 0, w: 0.4, h: 0.4, photo: true };
function draw(photo = true, width = 0.4, scale = 1) {
  const texts: string[] = [];
  const positions: number[][] = [];
  const events: string[] = [];
  const context = new Proxy({ globalAlpha: 1 }, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 7 });
      if (key === 'getTransform') return () => ({ a: scale, b: 0, c: 0, d: scale });
      return (...args: unknown[]) => { events.push(String(key)); if (key === 'fillText') { texts.push(String(args[0])); positions.push(args.slice(1, 3) as number[]); } };
    },
    set(target, key, value) { Reflect.set(target, key, value); return true; }
  }) as unknown as CanvasRenderingContext2D;
  renderOverlayParts(context, 1280, 720, { t: 0, session, lap: null, holdLap: null, reference: null }, [{ ...part, photo, w: width }]);
  return { texts, events, context, positions };
}

beforeEach(() => { vi.mocked(getTileImage).mockReturnValue({} as HTMLImageElement); vi.mocked(photoTileCredits).mockReturnValue([]); });
it('描いた航空写真の出典と走行データ追記を最後に描き、動画/透明メーターにも残す', () => {
  const { texts, events, positions } = draw();
  expect(texts[texts.length - 1]).toBe('出典：国土地理院（走行データを追記）');
  expect(events.lastIndexOf('fillText')).toBeGreaterThan(events.lastIndexOf('drawImage'));
  expect(positions[positions.length - 1][0]).toBeGreaterThan(0);
  expect(positions[positions.length - 1][0]).toBeLessThan(1280 * part.w);
  expect(positions[positions.length - 1][1]).toBeGreaterThan(720 * part.h - 30);
  expect(positions[positions.length - 1][1]).toBeLessThan(720 * part.h);
  expect(texts).not.toContain('--');
});
it('航空写真なし、またはタイル未読込みのフレームには出典を出さない', () => {
  expect(draw(false).texts.join()).not.toContain('出典');
  vi.mocked(getTileImage).mockReturnValue(null);
  expect(draw().texts.join()).not.toContain('出典');
});
it('縮小した衛星画像の追加出典も出力へ残す', () => {
  vi.mocked(photoTileCredits).mockReturnValue(['Landsat8 / GEBCO']);
  expect(draw().texts).toContain('Landsat8 / GEBCO');
});
it('判読できる出典を収められない極小の枠では写真自体を描かない', () => {
  expect(draw(true, 0.02).events).not.toContain('drawImage');
});
it('ステージの縮小合成後のピクセル寸法でも出典の最小文字サイズを保つ', () => {
  const { texts, context } = draw(true, 0.4, 0.5);
  expect(texts.join()).toContain('出典');
  expect(parseFloat(context.font) * 0.5).toBeGreaterThanOrEqual(8);
  expect(draw(true, 0.1, 0.5).events).not.toContain('drawImage');
});
