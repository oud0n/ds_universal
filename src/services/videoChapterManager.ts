/**
 * GoPro / DJI / アクションカメラ チャプター分割動画（4GB制限分割）自動管理モジュール
 */
import { VideoTrack } from './videoSyncManager';

export interface ChapterInfo {
  brand: 'gopro' | 'dji' | 'generic';
  sessionId: string;
  chapterIndex: number; // 1-based index (1, 2, 3...)
  originalFileName: string;
}

export interface VideoChapterTrack {
  track: VideoTrack;
  chapterInfo: ChapterInfo;
  chapterIndex: number;
  groupOffsetSec: number; // チャプター1開始からの累積オフセット秒 (チャプター1は0)
  durationSec: number;
}

export interface VideoChapterGroup {
  groupId: string;             // 例: "chapter_gopro_0017"
  brand: string;
  sessionId: string;
  tracks: VideoChapterTrack[]; // chapterIndex 昇順でソート済み
  totalDurationSec: number;    // グループ全体の合計再生時間 (秒)
  baseSyncOffsetSec: number;   // チャプター1の同期オフセット (秒)
  matchedSessionId: string | null;
}

export interface ChapterPlaybackResolution {
  activeTrack: VideoChapterTrack;
  localVideoTimeSec: number;     // HTML5 <video> にセットすべきローカル再生位置 (秒)
  chapterIndex: number;          // 1-based (例: 1, 2, 3)
  totalChapters: number;         // グループ内の全チャプター数
  groupRelativeTimeSec: number;  // チャプター1開始からの経過秒
  isOutOfRange: boolean;         // チャプター全体の再生範囲外かどうか
}

/**
 * ファイル名からアクションカメラのチャプター分割情報を検出
 */
export function detectChapterInfo(fileName: string): ChapterInfo | null {
  // 1. GoPro HERO6以降 (HEVC: GX, AVC: GH)
  // 例: GX010017.MP4 (Chapter 1), GX020017.MP4 (Chapter 2)
  const goProHero6 = /^G[XH](\d{2})(\d{4})\.(mp4|mov)$/i;
  const mHero6 = goProHero6.exec(fileName);
  if (mHero6) {
    return {
      brand: 'gopro',
      sessionId: mHero6[2],
      chapterIndex: parseInt(mHero6[1], 10),
      originalFileName: fileName,
    };
  }

  // 2. GoPro HERO5以前
  // 1本目: GOPR0017.MP4 (Chapter 1)
  const goProHero5First = /^GOPR(\d{4})\.(mp4|mov)$/i;
  const mHero5First = goProHero5First.exec(fileName);
  if (mHero5First) {
    return {
      brand: 'gopro',
      sessionId: mHero5First[1],
      chapterIndex: 1,
      originalFileName: fileName,
    };
  }

  // 2本目以降: GP010017.MP4 (Chapter 2), GP020017.MP4 (Chapter 3)
  const goProHero5Subsequent = /^GP(\d{2})(\d{4})\.(mp4|mov)$/i;
  const mHero5Sub = goProHero5Subsequent.exec(fileName);
  if (mHero5Sub) {
    return {
      brand: 'gopro',
      sessionId: mHero5Sub[2],
      chapterIndex: parseInt(mHero5Sub[1], 10) + 1,
      originalFileName: fileName,
    };
  }

  // 3. DJI Action カメラ
  // 例: DJI_0017_001.MP4, DJI_202609180926_001.MP4
  const djiPattern1 = /^DJI_(\d{4})_(\d{3})\.(mp4|mov)$/i;
  const mDji1 = djiPattern1.exec(fileName);
  if (mDji1) {
    return {
      brand: 'dji',
      sessionId: mDji1[1],
      chapterIndex: parseInt(mDji1[2], 10),
      originalFileName: fileName,
    };
  }

  const djiPattern2 = /^DJI_(\d{8,14})_(\d{3})\.(mp4|mov)$/i;
  const mDji2 = djiPattern2.exec(fileName);
  if (mDji2) {
    return {
      brand: 'dji',
      sessionId: mDji2[1],
      chapterIndex: parseInt(mDji2[2], 10),
      originalFileName: fileName,
    };
  }

  // 4. 汎用連番パターン (例: circuit_part1.mp4, race_pt02.mov)
  const genericPattern = /^(.+?)[-_](?:part|pt|ch)(\d+)\.(mp4|mov)$/i;
  const mGeneric = genericPattern.exec(fileName);
  if (mGeneric) {
    return {
      brand: 'generic',
      sessionId: mGeneric[1],
      chapterIndex: parseInt(mGeneric[2], 10),
      originalFileName: fileName,
    };
  }

  return null;
}

/**
 * 登録されている全動画トラックをチャプターグループと単独トラックに分類・連結計算
 */
export function groupVideoTracksByChapter(tracks: VideoTrack[]): {
  groups: VideoChapterGroup[];
  standaloneTracks: VideoTrack[];
} {
  const standaloneTracks: VideoTrack[] = [];
  const groupMap = new Map<string, { brand: string; sessionId: string; tracks: VideoChapterTrack[] }>();

  tracks.forEach(track => {
    const info = detectChapterInfo(track.fileName);
    if (!info) {
      standaloneTracks.push(track);
      return;
    }

    const key = `${info.brand}_${info.sessionId}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        brand: info.brand,
        sessionId: info.sessionId,
        tracks: []
      });
    }

    groupMap.get(key)!.tracks.push({
      track,
      chapterInfo: info,
      chapterIndex: info.chapterIndex,
      groupOffsetSec: 0,
      durationSec: track.durationSec || 0,
    });
  });

  const groups: VideoChapterGroup[] = [];

  groupMap.forEach((gData, key) => {
    // もし単一チャプターのみで、チャプター番号も1の場合は単独トラックとしても扱えるが、
    // チャプター命名（例: GX010017）がある場合は将来の後続追加に備えてグループとして管理
    gData.tracks.sort((a, b) => a.chapterIndex - b.chapterIndex);

    let cumulativeOffset = 0;
    for (const cTrack of gData.tracks) {
      cTrack.groupOffsetSec = cumulativeOffset;
      cumulativeOffset += cTrack.durationSec;
    }

    let baseSyncOffsetSec = 0;
    let matchedSessionId: string | null = null;

    // オフセットが設定されているトラックを探して逆算
    const matchedTrack = gData.tracks.find(ct => ct.track.matchedSessionId) || gData.tracks[0];
    if (matchedTrack) {
      baseSyncOffsetSec = (matchedTrack.track.syncOffsetSec || 0) - matchedTrack.groupOffsetSec;
      matchedSessionId = matchedTrack.track.matchedSessionId || null;
    }

    const group: VideoChapterGroup = {
      groupId: `chapter_${key}`,
      brand: gData.brand,
      sessionId: gData.sessionId,
      tracks: gData.tracks,
      totalDurationSec: cumulativeOffset,
      baseSyncOffsetSec: Number(baseSyncOffsetSec.toFixed(3)),
      matchedSessionId,
    };

    groups.push(group);
  });

  return { groups, standaloneTracks };
}

/**
 * チャプターグループ全体の基準オフセットを変更した際、全チャプターの syncOffsetSec を再計算
 */
export function syncGroupOffsets(group: VideoChapterGroup, baseSyncOffsetSec: number): void {
  group.baseSyncOffsetSec = Number(baseSyncOffsetSec.toFixed(3));
  group.tracks.forEach(ct => {
    ct.track.syncOffsetSec = Number((group.baseSyncOffsetSec + ct.groupOffsetSec).toFixed(3));
    if (group.matchedSessionId) {
      ct.track.matchedSessionId = group.matchedSessionId;
    }
  });
}

/**
 * GPSセッション時間 (秒) から、現在再生すべきチャプターとそのチャプター内のローカル再生位置を解決
 */
export function resolveChapterPlayback(
  group: VideoChapterGroup,
  sessionTimeSec: number
): ChapterPlaybackResolution | null {
  if (group.tracks.length === 0) {
    return null;
  }

  const groupRelativeTimeSec = sessionTimeSec - group.baseSyncOffsetSec;
  const totalChapters = group.tracks.length;
  const firstTrack = group.tracks[0];
  const lastTrack = group.tracks[totalChapters - 1];

  // 動画開始前
  if (groupRelativeTimeSec < 0) {
    return {
      activeTrack: firstTrack,
      localVideoTimeSec: 0,
      chapterIndex: firstTrack.chapterIndex,
      totalChapters,
      groupRelativeTimeSec,
      isOutOfRange: true,
    };
  }

  // 動画終了後
  if (groupRelativeTimeSec >= group.totalDurationSec) {
    return {
      activeTrack: lastTrack,
      localVideoTimeSec: lastTrack.durationSec,
      chapterIndex: lastTrack.chapterIndex,
      totalChapters,
      groupRelativeTimeSec,
      isOutOfRange: true,
    };
  }

  // 該当するチャプターを探索
  for (let i = 0; i < totalChapters; i++) {
    const ct = group.tracks[i];
    const chapterEnd = ct.groupOffsetSec + ct.durationSec;
    if (groupRelativeTimeSec >= ct.groupOffsetSec && groupRelativeTimeSec < chapterEnd) {
      const localVideoTimeSec = Math.max(0, Math.min(ct.durationSec, groupRelativeTimeSec - ct.groupOffsetSec));
      return {
        activeTrack: ct,
        localVideoTimeSec: Number(localVideoTimeSec.toFixed(3)),
        chapterIndex: ct.chapterIndex,
        totalChapters,
        groupRelativeTimeSec: Number(groupRelativeTimeSec.toFixed(3)),
        isOutOfRange: false,
      };
    }
  }

  // 浮動小数点境界値のフォールバック
  return {
    activeTrack: lastTrack,
    localVideoTimeSec: lastTrack.durationSec,
    chapterIndex: lastTrack.chapterIndex,
    totalChapters,
    groupRelativeTimeSec,
    isOutOfRange: false,
  };
}

/**
 * 現在のチャプターから次のチャプターを取得 (シームレス連続再生用)
 */
export function getNextChapter(
  group: VideoChapterGroup,
  currentTrackId: string
): VideoChapterTrack | null {
  const index = group.tracks.findIndex(ct => ct.track.id === currentTrackId);
  if (index !== -1 && index + 1 < group.tracks.length) {
    return group.tracks[index + 1];
  }
  return null;
}

/**
 * 現在のチャプターから前のチャプターを取得
 */
export function getPreviousChapter(
  group: VideoChapterGroup,
  currentTrackId: string
): VideoChapterTrack | null {
  const index = group.tracks.findIndex(ct => ct.track.id === currentTrackId);
  if (index !== -1 && index > 0) {
    return group.tracks[index - 1];
  }
  return null;
}

/**
 * トラックIDから所属するチャプターグループを検索
 */
export function findChapterGroupForTrack(
  groups: VideoChapterGroup[],
  trackId: string
): VideoChapterGroup | null {
  for (const group of groups) {
    if (group.tracks.some(ct => ct.track.id === trackId)) {
      return group;
    }
  }
  return null;
}
