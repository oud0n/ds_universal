import { beforeEach, expect, it, vi } from 'vitest';
import type { Session, TelemetryPoint } from '../types/telemetry';
import { getTileImage } from '../services/mapTiles';
import { renderOverlayParts } from './overlayRender';

vi.mock('../services/mapTiles', () => ({
  tilesForView: () => [{ north: 35.01, south: 34.99, west: 139.99, east: 140.01 }],
  getTileImage: vi.fn()
}));
vi.mock('../utils/i18n', () => ({ tr: (ja: string) => ja }));

const point: TelemetryPoint = { index: 0, time: 0, latitude: 35, longitude: 140, altitude: 0, speed: 50, heading: 0, distance: 0, accelG: 0, corneringG: 0, combinedG: 0, turningRadius: 0, driftAngle: 0 };
const session = { points: [point], laps: [], bestLapIndex: -1, pathPolylines: [] } as unknown as Session;
const part = { id: 'photo', type: 'zoomMap' as const, x: 0, y: 0, w: 0.4, h: 0.4, photo: true };
function draw(photo = true) {
  const texts: string[] = [];
  const events: string[] = [];
  const context = new Proxy({ globalAlpha: 1 }, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      if (key === 'measureText') return () => ({ width: 200 });
      return (...args: unknown[]) => { events.push(String(key)); if (key === 'fillText') texts.push(String(args[0])); };
    },
    set(target, key, value) { Reflect.set(target, key, value); return true; }
  }) as unknown as CanvasRenderingContext2D;
  renderOverlayParts(context, 1280, 720, { t: 0, session, lap: null, holdLap: null, reference: null }, [{ ...part, photo }]);
  return { texts, events, context };
}

beforeEach(() => vi.mocked(getTileImage).mockReturnValue({} as HTMLImageElement));
it('描いた航空写真の出典と走行データ追記を最後に描き、動画/透明メーターにも残す', () => {
  const { texts, events } = draw();
  expect(texts[texts.length - 1]).toBe('出典：国土地理院（走行データを追記）');
  expect(events.lastIndexOf('fillText')).toBeGreaterThan(events.lastIndexOf('drawImage'));
});
it('航空写真なし、またはタイル未読込みのフレームには出典を出さない', () => {
  expect(draw(false).texts.join()).not.toContain('出典');
  vi.mocked(getTileImage).mockReturnValue(null);
  expect(draw().texts.join()).not.toContain('出典');
});
