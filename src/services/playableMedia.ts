/**
 * 再生する動画 (1 台のカメラの 1 回の撮影)。チャプターに分かれたファイルも 1 つにまとめ、時刻からそのときのチャプターと
 * チャプターの中の位置を決める。動画は基準のログの時刻に置いたもの (PlacedTrack) を使う
 */
import type { PlacedTrack } from './videoSyncManager';
import { groupVideoTracksByChapter, resolveChapterPlayback } from './videoChapterManager';

export interface PlayableMedia {
  /** 最初のチャプターの動画の ID (チャプターのない動画はその動画の ID) */
  id: string;
  /** チャプター順の動画 (チャプターのない動画は 1 本) */
  tracks: PlacedTrack[];
  label: string;
  /** 基準のログの時刻での、最初のコマの位置と、最後のコマの位置 (秒) */
  startSec: number;
  endSec: number;
  isPlaced: boolean;
}

/** 今、そのメディアのどの動画のどこを出すか。outOfRange: 撮影の前・後 (動画は止め、「映像はありません」を出す) */
export interface MediaPosition {
  track: PlacedTrack;
  localTime: number;
  durationSec: number;
  outOfRange: boolean;
}

export function buildMedia(tracks: PlacedTrack[]): PlayableMedia[] {
  const { groups, standaloneTracks } = groupVideoTracksByChapter(tracks);
  const out: PlayableMedia[] = [];
  for (const g of groups) {
    const list = g.tracks.map(ct => ct.track);
    out.push({
      id: list[0].id,
      tracks: list,
      label: list.length > 1 ? `${list[0].fileName} (+${list.length - 1})` : list[0].fileName,
      startSec: g.baseSyncOffsetSec,
      endSec: g.baseSyncOffsetSec + g.totalDurationSec,
      isPlaced: list[0].isPlaced
    });
  }
  for (const t of standaloneTracks) {
    out.push({ id: t.id, tracks: [t], label: t.fileName, startSec: t.syncOffsetSec, endSec: t.syncOffsetSec + (t.durationSec || 0), isPlaced: t.isPlaced });
  }
  // 読み込んだ順に並べる
  const order = new Map(tracks.map((t, i) => [t.id, i]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** 動画 (どのチャプターでも) を含むメディア */
export function mediaOfTrack(media: PlayableMedia[], trackId: string | null | undefined): PlayableMedia | undefined {
  return trackId ? media.find(m => m.tracks.some(t => t.id === trackId)) : undefined;
}

/** 基準のログの時刻 sessionTime に出す位置 */
export function positionInMedia(media: PlayableMedia, sessionTime: number): MediaPosition {
  if (media.tracks.length > 1) {
    const { groups } = groupVideoTracksByChapter(media.tracks);
    const r = groups[0] && resolveChapterPlayback(groups[0], sessionTime);
    if (r) return { track: r.activeTrack.track, localTime: r.localVideoTimeSec, durationSec: r.activeTrack.durationSec, outOfRange: r.isOutOfRange };
  }
  const t = media.tracks[0];
  const local = sessionTime - t.syncOffsetSec;
  return { track: t, localTime: local, durationSec: t.durationSec, outOfRange: !t.isPlaced || local < 0 || (t.durationSec > 0 && local > t.durationSec) };
}

/** メディアの中の位置 (先頭からの秒) に出す位置。走行比較で、比較の車の時刻から決めた位置に使う */
export function positionAtMediaTime(media: PlayableMedia, mediaSec: number): MediaPosition {
  return positionInMedia(media, media.startSec + mediaSec);
}
