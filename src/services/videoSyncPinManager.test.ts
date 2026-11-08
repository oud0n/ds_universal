import { expect, it } from 'vitest';
import { createSyncPin, pinTimeInSession, pinUtcMs } from './videoSyncPinManager';
import { videoViewStore } from './videoViewStore';

it('ピンの秒を現在の基準へ換算し、閉じた元の UTC も使う', () => {
  const a = { id: 'a', points: [{ timestamp: '2026-01-01T00:00:00Z' }] };
  const b = { id: 'b', points: [{ timestamp: '2026-01-01T00:01:00Z' }] };
  const pin = { ...createSyncPin('p', 120, 2, 'video'), sessionId: a.id };
  expect(pinTimeInSession(pin, b, [a,b])).toBe(60);
  const anchored = { ...pin, utcMs: pinUtcMs(pin, [a,b])! };
  expect(pinTimeInSession(anchored, b, [b])).toBe(60);
  expect(pinTimeInSession(pin, {id:'undated',points:[]}, [a])).toBeNull();
});

it('別コースへ移っても同じ動画のピンを表示・削除できる', () => {
  const pin = createSyncPin('p', 1, 2, 'video-course-swap');
  videoViewStore.setPins('before', [pin]);
  expect(videoViewStore.getAllPins('after')).toContain(pin);
  videoViewStore.setTrackPins('after', new Set([pin.trackId]), []);
  expect(videoViewStore.getAllPins()).not.toContain(pin);
});
