import { describe, expect, it } from 'vitest';
import type { Session } from '../types/telemetry';
import { rowParts, rowVideoFromTrack, syncPinsFromRow, syncVideoFromRow } from './runSync';
import type { VideoTrack } from './videoSyncManager';
import type { SyncPin } from './videoSyncPinManager';

const session = (id: string, startIso: string, clockOffsetSec = 0): Session => ({
  id, fileName: `${id}.nmea`, sessionName: id, date: '', circuitName: 'c', samplingRate: 20, totalDistance: 0,
  points: [{ time: 0, timestamp: startIso } as never], laps: [], bestLapIndex: 0, theoreticalBestTime: 0, sectors: [], clockOffsetSec
} as unknown as Session);

const track = (clock: VideoTrack['clock'], matchedSessionId: string | null): VideoTrack => ({
  id: 'v1', fileName: 'GX010017.MP4', fileSize: 5, durationSec: 60, rawRecordedAt: null, recordedAtJst: null,
  videoTimezone: 'JST', gpsTimezone: 'JST', matchedSessionId, clock, isAutoMatched: false
});

// Car 1: 9/18 の走行。Car 2: 9/13 の走行 (開始は 9/18 の 10 分前の時刻にしてある)
const car1 = session('car1', '2026-09-18T00:20:00.000Z');
const car2 = session('car2', '2026-09-18T00:10:00.000Z');
const all = [car1, car2];

describe('runs.json の行と開いている動画の読み替え', () => {
  it('その走行のログに付いた時刻は、何番目のログからの秒で書く', () => {
    const v = rowVideoFromTrack(track({ source: 'manual', logId: 'car2', offsetSec: 30, utcMs: null }, 'car2'), [], [car2], all);
    expect(v.clock).toEqual({ source: 'manual', logPart: 1, offsetSec: 30, utcMs: Date.parse('2026-09-18T00:10:30.000Z') });
    expect(v.part).toBe(1);
  });

  it('比べる相手の動画を Car 1 のログで合わせた時刻は、その走行 (Car 2) のログでの秒に直して書く', () => {
    // Car 1 のログの先頭から 30 秒 = Car 2 のログの先頭から 630 秒
    const v = rowVideoFromTrack(track({ source: 'manual', logId: 'car1', offsetSec: 30, utcMs: null }, 'car2'), [], [car2], all);
    expect(v.clock).toEqual({ source: 'manual', logPart: 1, offsetSec: 630, utcMs: Date.parse('2026-09-18T00:20:30.000Z') });
  });

  it('Car 1 のログで打ったピンも、その走行のログの時刻に直す', () => {
    const pin: SyncPin = { id: 'p', name: 'P', sessionTimeSec: 100, videoTimeSec: 70, trackId: 'v1', calculatedOffsetSec: 30, sessionId: 'car1', createdAt: 'c' };
    const v = rowVideoFromTrack(track({ source: 'manual', logId: 'car2', offsetSec: 630, utcMs: null }, 'car2'), [pin], [car2], all);
    expect(v.pins).toEqual([{ name: 'P', logPart: 1, logTimeSec: 700, videoTimeSec: 70, utcMs: Date.parse('2026-09-18T00:21:40.000Z'), createdAt: 'c' }]);
  });

  it('世界の時刻の動画 (GPS・撮影日時) は logPart を null で書く', () => {
    const v = rowVideoFromTrack(track({ source: 'gps', logId: null, offsetSec: 0, utcMs: 12345 }, 'car2'), [], [car2], all);
    expect(v.clock).toEqual({ source: 'gps', logPart: null, offsetSec: 0, utcMs: 12345 });
  });

  it('書いたものを戻すと、今のログの ID に付いた同じ時刻になる', () => {
    const v = rowVideoFromTrack(track({ source: 'manual', logId: 'car1', offsetSec: 30, utcMs: null }, 'car2'), [], [car2], all);
    const reopened = session('car2_new_id', '2026-09-18T00:10:00.000Z');
    const back = syncVideoFromRow(v, [reopened])!;
    expect(back.clock).toEqual({ source: 'manual', logId: 'car2_new_id', offsetSec: 630, utcMs: Date.parse('2026-09-18T00:20:30.000Z') });
    expect(back.matchedSessionId).toBe('car2_new_id');
  });

  it('何番目のログが無いときは、控えの世界の時刻で戻す。それも無ければ戻さない', () => {
    expect(syncVideoFromRow({ name: 'a.mp4', clock: { source: 'manual', logPart: 2, offsetSec: 5, utcMs: 999 } }, [car2])!.clock).toEqual({ source: 'manual', logId: null, offsetSec: 0, utcMs: 999 });
    expect(syncVideoFromRow({ name: 'a.mp4', clock: { source: 'manual', logPart: 2, offsetSec: 5, utcMs: null } }, [car2])).toBeNull();
  });

  it('ピンは今のログの ID に戻す', () => {
    const pins = syncPinsFromRow({ name: 'a.mp4', pins: [{ name: 'P', logPart: 1, logTimeSec: 10, videoTimeSec: 3 }] }, 'track', [car2]);
    expect(pins).toEqual([{ name: 'P', sessionTimeSec: 10, videoTimeSec: 3, sessionId: 'car2', trackId: 'track' }]);
  });

  it('ログの時計の補正は何番目ごと。前の行の知らない項目は残す', () => {
    expect(rowParts([session('a', '2026-01-01T00:00:00Z', 1.5), session('b', '2026-01-01T01:00:00Z')], { 1: { clockOffsetSec: 0, x: 1 } }))
      .toEqual({ 1: { clockOffsetSec: 1.5, x: 1 }, 2: { clockOffsetSec: 0 } });
  });

  it('前の行の時刻・ピンの知らない項目は残す', () => {
    const prev = { name: 'GX010017.MP4', extra: 1, clock: { source: 'manual' as const, logPart: 1, offsetSec: 1, utcMs: null, future: 'k' }, pins: [{ name: 'P', logPart: 1, logTimeSec: 1, videoTimeSec: 70, note: 'n' }] };
    const pin: SyncPin = { id: 'p', name: 'P', sessionTimeSec: 100, videoTimeSec: 70, trackId: 'v1', calculatedOffsetSec: 30, sessionId: 'car2', createdAt: 'c' };
    const v = rowVideoFromTrack(track({ source: 'manual', logId: 'car2', offsetSec: 30, utcMs: null }, 'car2'), [pin], [car2], all, prev);
    expect(v.extra).toBe(1);
    expect(v.clock?.future).toBe('k');
    expect(v.pins?.[0]).toMatchObject({ note: 'n', logTimeSec: 100 });
  });
});
