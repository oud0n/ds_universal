import { describe, expect, it } from 'vitest';
import { lapsFromMarks, ownLapInVideo, splitVideoPath, videoRefCandidates, type VideoRef } from './videoLaps';
import type { RunItem } from './runOpener';
import type { RunFileInfo } from './runStore';

const file = (path: string): RunFileInfo => ({ path, size: 10, mtimeMs: 1 } as RunFileInfo);
const run = (folder: string, f: string, videos: string[] = [], extra: Partial<RunItem> = {}): RunItem =>
  ({ folder, file: f, courseName: null, startMs: null, lapCount: 0, best: null, videos, synced: false, folderVideos: [], laps: [], pending: false, entry: null, ...extra });

describe('動画だけの参考ラップ: 印から周を作る', () => {
  it('計測線から計測線までが 1 周、その間のセクターの印で分ける', () => {
    const laps = lapsFromMarks([
      { t: 10, kind: 'line' }, { t: 40, kind: 'sector' }, { t: 75.5, kind: 'sector' }, { t: 110.2, kind: 'line' },
      { t: 210, kind: 'line' }, { t: 5, kind: 'sector' }
    ]);
    expect(laps).toEqual([
      { n: 1, start: 10, time: 100.2, sectors: [30, 35.5, 34.7] },
      { n: 2, start: 110.2, time: 99.8, sectors: [] }
    ]);
  });
  it('計測線が 1 つだけ・近すぎる印は周にしない', () => {
    expect(lapsFromMarks([{ t: 10, kind: 'line' }])).toEqual([]);
    expect(lapsFromMarks([{ t: 10, kind: 'line' }, { t: 10.5, kind: 'line' }, { t: 60, kind: 'line' }]).map(l => l.time)).toEqual([49.5]);
  });
});

describe('参考ラップにできる動画', () => {
  it('どの走行にも付いていない、サーキットのフォルダの動画だけ', () => {
    const files = ['sodegaura/20261025/20261025100000.nmea', 'sodegaura/20261025/20261025100000.mov', 'sodegaura/20261025/20261025100000_front.mov',
      'sodegaura/20261025/GX010001.MP4', 'sodegaura/20261025/GX010002.MP4', 'sodegaura/fast.mp4', 'exports/a.mp4', 'sodegaura/x/y/z.mp4'].map(file);
    const runs = [run('sodegaura', '20261025/20261025100000.nmea', ['GX010001.MP4'])];
    const refs = [{ path: 'sodegaura/fast.mp4' } as VideoRef];
    expect(videoRefCandidates(files, runs, refs).map(f => f.path)).toEqual(['sodegaura/20261025/GX010002.MP4']);
  });
  it('道を分ける', () => {
    expect(splitVideoPath('sodegaura/20261025/a.mp4')).toEqual({ folder: 'sodegaura', file: '20261025/a.mp4' });
    expect(splitVideoPath('sodegaura/a.mp4')).toEqual({ folder: 'sodegaura', file: 'a.mp4' });
    expect(splitVideoPath('a.mp4')).toBeNull();
    expect(splitVideoPath('sodegaura/x/a.mp4')).toBeNull();
  });
});

describe('自分の周が、付けた動画の何秒目か', () => {
  const T0 = Date.parse('2026-10-25T01:00:00Z');
  const r = run('sodegaura', '20261025/a.nmea', ['a.mov'], {
    startMs: T0,
    entry: { updatedAt: '', videos: [{ name: 'a.mov', durationSec: 600, clock: { source: 'gps', logPart: 1, offsetSec: 30, utcMs: null } }] }
  });
  it('ログの先頭からの位置で同期した動画', () => {
    expect(ownLapInVideo(r, { startMs: T0 + 100_000, time: 90 })).toEqual({ video: 'a.mov', path: 'sodegaura/20261025/a.mov', sec: 70 });
  });
  it('動画の外の周・分かれた走行の 2 番目は null', () => {
    expect(ownLapInVideo(r, { startMs: T0 + 10_000, time: 90 })).toBeNull();
    expect(ownLapInVideo(r, { startMs: T0 + 600_000, time: 90 })).toBeNull();
    expect(ownLapInVideo(r, { startMs: T0 + 100_000, time: 90, part: 2 })).toBeNull();
  });
});
