/**
 * マスター・タイムライン (Unified Master Timeline) & タイムゾーン自動判定エンジン
 */
import { Session, Lap, TelemetryPoint } from '../types/telemetry';
import { VideoTrack, getTimezoneOffsetMs } from './videoSyncManager';

export interface VideoMapping {
  videoId: string;
  masterStartSec: number;
  masterEndSec: number;
  durationSec: number;
}

export interface SessionMapping {
  sessionId: string;
  masterStartSec: number;
  masterEndSec: number;
  durationSec: number;
}

export interface MasterTimeline {
  startEpochMs: number;
  endEpochMs: number;
  totalDurationSec: number;
  videoMappings: VideoMapping[];
  sessionMappings: SessionMapping[];
}

/**
 * GPS緯度経度から現地タイムゾーンを自動判定
 */
export function detectCircuitTimezone(lat: number, lon: number): string {
  // 日本の領土範囲: 北緯24〜46度、東経122〜154度
  if (lat >= 24 && lat <= 46 && lon >= 122 && lon <= 154) {
    return 'JST';
  }
  // 欧州 (ニュルブルクリンク, スパ等): 北緯35〜60度、東経-10〜25度
  if (lat >= 35 && lat <= 60 && lon >= -10 && lon <= 25) {
    return '+1'; // CET
  }
  // 米国西海岸 (ラグナセカ等): 北緯32〜49度、西経-125〜-114度
  if (lat >= 32 && lat <= 49 && lon >= -125 && lon <= -114) {
    return '-8'; // PST
  }
  return 'UTC';
}

/**
 * 整数時差スキャン (Auto-TZ Scan)
 * カメラ側がUTC記録かローカル記録かによる時差ズレ (0h, ±9h, ±8h等) を自動検知
 */
export function scanBestTimezoneOffset(
  videoRecordedAt: Date,
  sessionStartDate: Date,
  circuitTz: string = 'JST'
): { bestOffsetSec: number; detectedShiftHours: number; confidence: 'high' | 'medium' | 'low' } {
  // 候補となる時差シフト (時間単位)
  const candidateHours = [0, 9, -9, 8, -8, 1, -1, 5, -5];

  let bestShift = 0;
  let minDiffSec = Infinity;
  let bestOffsetSec = 0;

  const vidEpoch = videoRecordedAt.getTime();
  const sessEpoch = sessionStartDate.getTime();

  for (const shiftH of candidateHours) {
    // shiftH 時間の補正を適用した仮想差分
    const shiftMs = shiftH * 3600 * 1000;
    const diffSec = (vidEpoch - (sessEpoch + shiftMs)) / 1000;
    const absDiff = Math.abs(diffSec);

    // サーキット走行セッション内の合理的な時間差 (最長4時間以内)
    if (absDiff < minDiffSec && absDiff < 4 * 3600) {
      minDiffSec = absDiff;
      bestShift = shiftH;
      bestOffsetSec = diffSec;
    }
  }

  // 判定信頼度
  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (minDiffSec <= 600) {
    confidence = 'high'; // 10分以内の差分 = 完全に同一セッション
  } else if (minDiffSec <= 1800) {
    confidence = 'medium'; // 30分以内の差分
  }

  return {
    bestOffsetSec: Number(bestOffsetSec.toFixed(3)),
    detectedShiftHours: bestShift,
    confidence
  };
}

/**
 * 全動画トラックおよびGPSセッションを包括するマスター・タイムラインを算出
 */
export function buildMasterTimeline(
  sessions: Session[],
  videos: VideoTrack[]
): MasterTimeline {
  let minStartEpoch = Infinity;
  let maxEndEpoch = -Infinity;

  interface TrackInterval {
    id: string;
    type: 'session' | 'video';
    startEpoch: number;
    endEpoch: number;
    durationSec: number;
  }

  const intervals: TrackInterval[] = [];

  // 1. GPSセッションのスキャン
  for (const sess of sessions) {
    if (sess.points.length === 0 || !sess.points[0].timestamp) continue;
    const p0Time = new Date(sess.points[0].timestamp).getTime();
    const durationSec = sess.points[sess.points.length - 1].time || 0;
    const endEpoch = p0Time + durationSec * 1000;

    intervals.push({
      id: sess.id,
      type: 'session',
      startEpoch: p0Time,
      endEpoch,
      durationSec
    });

    if (p0Time < minStartEpoch) minStartEpoch = p0Time;
    if (endEpoch > maxEndEpoch) maxEndEpoch = endEpoch;
  }

  // 2. 動画トラックのスキャン
  for (const vid of videos) {
    if (!vid.rawRecordedAt) continue;
    const vidStartEpoch = vid.rawRecordedAt.getTime() - (vid.syncOffsetSec ? 0 : 0);
    // 関連付けられたセッションがある場合、syncOffsetSecから絶対時刻を補正
    const matchedSess = sessions.find(s => s.id === vid.matchedSessionId);
    let startEpoch = vid.rawRecordedAt.getTime();

    if (matchedSess && matchedSess.points[0]?.timestamp) {
      const sessP0 = new Date(matchedSess.points[0].timestamp).getTime();
      startEpoch = sessP0 + vid.syncOffsetSec * 1000;
    }

    const durationSec = vid.durationSec || 0;
    const endEpoch = startEpoch + durationSec * 1000;

    intervals.push({
      id: vid.id,
      type: 'video',
      startEpoch,
      endEpoch,
      durationSec
    });

    if (startEpoch < minStartEpoch) minStartEpoch = startEpoch;
    if (endEpoch > maxEndEpoch) maxEndEpoch = endEpoch;
  }

  // フォールバック (有効なデータがない場合)
  if (minStartEpoch === Infinity) {
    minStartEpoch = Date.now();
    maxEndEpoch = minStartEpoch + 3600 * 1000;
  }

  const totalDurationSec = Math.max(1, (maxEndEpoch - minStartEpoch) / 1000);

  const videoMappings: VideoMapping[] = [];
  const sessionMappings: SessionMapping[] = [];

  for (const item of intervals) {
    const masterStartSec = Math.max(0, (item.startEpoch - minStartEpoch) / 1000);
    const masterEndSec = masterStartSec + item.durationSec;

    if (item.type === 'video') {
      videoMappings.push({
        videoId: item.id,
        masterStartSec: Number(masterStartSec.toFixed(3)),
        masterEndSec: Number(masterEndSec.toFixed(3)),
        durationSec: item.durationSec
      });
    } else {
      sessionMappings.push({
        sessionId: item.id,
        masterStartSec: Number(masterStartSec.toFixed(3)),
        masterEndSec: Number(masterEndSec.toFixed(3)),
        durationSec: item.durationSec
      });
    }
  }

  return {
    startEpochMs: minStartEpoch,
    endEpochMs: maxEndEpoch,
    totalDurationSec: Number(totalDurationSec.toFixed(3)),
    videoMappings,
    sessionMappings
  };
}

/**
 * マスター時間 (0〜totalDurationSec) から動画内再生時刻への変換
 */
export function masterToVideoTime(
  masterSec: number,
  mapping: VideoMapping
): { videoTime: number; isInRange: boolean } {
  const vTime = masterSec - mapping.masterStartSec;
  const isInRange = vTime >= 0 && vTime <= mapping.durationSec;
  return {
    videoTime: Math.max(0, Math.min(mapping.durationSec, vTime)),
    isInRange
  };
}

/**
 * マスター時間からGPSセッション内経過秒への変換
 */
export function masterToSessionTime(
  masterSec: number,
  mapping: SessionMapping
): { sessionTime: number; isInRange: boolean } {
  const sTime = masterSec - mapping.masterStartSec;
  const isInRange = sTime >= 0 && sTime <= mapping.durationSec;
  return {
    sessionTime: Math.max(0, Math.min(mapping.durationSec, sTime)),
    isInRange
  };
}

/**
 * マスター時間から現在該当するラップ情報を特定
 */
export function masterToCurrentLap(
  masterSec: number,
  session: Session,
  mapping: SessionMapping
): { currentLap: Lap | null; lapDisplayTimeSec: number; lapLabel: string } {
  const { sessionTime, isInRange } = masterToSessionTime(masterSec, mapping);
  if (!isInRange) {
    return {
      currentLap: null,
      lapDisplayTimeSec: 0,
      lapLabel: masterSec < mapping.masterStartSec ? 'Before Session' : 'Session Ended'
    };
  }

  const lap = session.laps.find(l => sessionTime >= l.startTime && sessionTime <= l.endTime);
  if (lap) {
    return {
      currentLap: lap,
      lapDisplayTimeSec: sessionTime - lap.startTime,
      lapLabel: `Lap ${lap.lapNumber}`
    };
  }

  return {
    currentLap: null,
    lapDisplayTimeSec: sessionTime,
    lapLabel: 'Out / In Lap'
  };
}
