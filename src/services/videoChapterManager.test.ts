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
  it.each([['GX010017.MP4','GX010017.MP4'],['GX010017.MP4','GX030017.MP4']])('章番号が重なる・欠ける動画は独立させる (%s, %s)',(first,second)=>{
    const tracks=[track('a',first),track('b',second)];const grouped=groupVideoTracksByChapter(tracks);
    expect(grouped.groups).toEqual([]);expect(grouped.standaloneTracks).toEqual(tracks);
  });
  it('連続した章番号でも撮影日が別なら独立させる',()=>{
    const tracks=[track('a','GX010017.MP4'),track('b','GX020017.MP4')];
    tracks[0].rawRecordedAt=new Date('2026-01-01T00:00:00Z');tracks[1].rawRecordedAt=new Date('2026-01-02T00:00:00Z');
    expect(groupVideoTracksByChapter(tracks).standaloneTracks).toEqual(tracks);
    tracks[1].rawRecordedAt=new Date('2026-01-01T00:01:40Z');expect(groupVideoTracksByChapter(tracks).groups).toHaveLength(1);
  });
});
