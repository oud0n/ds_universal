import { describe, expect, it } from 'vitest';
import { groupVideoTracksByChapter } from './videoChapterManager';
import { NO_CLOCK } from './mediaClock';
import type { VideoTrack } from './videoSyncManager';

const track = (id: string, fileName: string, path?: string): VideoTrack => ({
  id, fileName, fileSize: 1, durationSec: 100, rawRecordedAt: null, recordedAtJst: null,
  videoTimezone: 'JST', gpsTimezone: 'JST', matchedSessionId: null, clock: NO_CLOCK, isAutoMatched: false,
  ...(path ? { remote: { path, name: fileName, url: `lapfile://run/${path}`, size: 1 } as unknown as VideoTrack['remote'] } : {})
});

describe('groupVideoTracksByChapter', () => {
  it('同じフォルダの GoPro のチャプターは 1 つの撮影にまとめる', () => {
    const { groups } = groupVideoTracksByChapter([track('a', 'GX010017.MP4', 'sodegaura/20260918/GX010017.MP4'), track('b', 'GX020017.MP4', 'sodegaura/20260918/GX020017.MP4')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tracks.map(t => t.groupOffsetSec)).toEqual([0, 100]);
  });
  it('別のフォルダ (別の走行) の同じ名前の動画は、別の撮影とみなす (BUG-35 の (6))', () => {
    const { groups } = groupVideoTracksByChapter([track('a', 'GX010017.MP4', 'sodegaura/20260918/GX010017.MP4'), track('b', 'GX010017.MP4', 'sodegaura/20260913/GX010017.MP4')]);
    expect(groups).toHaveLength(2);
  });
  it('保管場所でない動画 (その場で選んだファイル) は今までどおり名前でまとめる', () => {
    const { groups } = groupVideoTracksByChapter([track('a', 'GX010017.MP4'), track('b', 'GX020017.MP4')]);
    expect(groups).toHaveLength(1);
  });
});
