/**
 * 再生する動画 (1 台のカメラの 1 回の撮影)。チャプターに分かれたファイルも 1 つにまとめ、時刻からそのときのチャプターと
 * チャプターの中の位置を決める。動画は基準のログの時刻に置いたもの (PlacedTrack) を使う
 */
import type { PlacedTrack } from './videoSyncManager';
import type { Lap, Session } from '../types/telemetry';
import { clockOffsetIn } from './mediaClock';
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

/** その車のログの時刻での、メディアの最初のコマの位置 (秒)。決まらなければ null */
export function mediaStartIn(media: PlayableMedia, session: Session, sessions: Session[]): number | null {
  return clockOffsetIn(media.tracks[0].clock, session, sessions);
}

/**
 * その周を映している動画: そのログの時刻に置いて、周と重なる時間がいちばん長いもの。重なるものがなければ undefined
 * (走行比較で、Car ごとの枠に出す動画)
 */
export function mediaForLap(media: PlayableMedia[], session: Session, lap: Lap, sessions: Session[]): PlayableMedia | undefined {
  let best: PlayableMedia | undefined, bestOverlap = 0;
  for (const m of media) {
    const overlap = lapOverlapSec(m, session, lap, sessions);
    if (overlap > bestOverlap) { best = m; bestOverlap = overlap; }
  }
  return best;
}

/** 動画が周を映している長さ (秒。映していなければ 0 以下) */
export function lapOverlapSec(m: PlayableMedia, session: Session, lap: Lap, sessions: Session[]): number {
  const start = mediaStartIn(m, session, sessions);
  if (start === null) return 0;
  return Math.min(lap.endTime, start + (m.endSec - m.startSec)) - Math.max(lap.startTime, start);
}
