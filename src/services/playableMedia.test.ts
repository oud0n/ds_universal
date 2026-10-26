import { describe, expect, it } from 'vitest';
import { buildMedia, positionAtMediaTime } from './playableMedia';
import type { PlacedTrack } from './videoSyncManager';

const track = (id: string, fileName: string, durationSec: number, syncOffsetSec: number, isPlaced: boolean) =>
  ({ id, fileName, durationSec, syncOffsetSec, isPlaced, clock: { source: 'gps', logId: null, offsetSec: 0, utcMs: 1 } }) as unknown as PlacedTrack;

describe('比べるの枠: 動画の中の位置 (PLAN-29 の 6)', () => {
  it('Car 1 の時刻に置けない動画 (Car 1 のログに時刻が無い) でも、動画の中の位置を出す', () => {
    const [m] = buildMedia([track('a', 'GX010001.MP4', 600, 0, false)]);
    const p = positionAtMediaTime(m, 123.4);
    expect(p.outOfRange).toBe(false);
    expect(p.localTime).toBeCloseTo(123.4);
    expect(positionAtMediaTime(m, 700).outOfRange).toBe(true);
  });

  it('置けている動画は、今までどおり', () => {
    const [m] = buildMedia([track('a', 'GX010001.MP4', 600, 50, true)]);
    const p = positionAtMediaTime(m, 10);
    expect(p.localTime).toBeCloseTo(10);
    expect(p.outOfRange).toBe(false);
  });
});
