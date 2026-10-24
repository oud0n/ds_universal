/**
 * runs.json の 2 版の行 (runsFile.ts) と、開いている動画・ログ (videoSyncManager) の間の読み替え (docs/run_storage_v2.md)。
 *
 * runs.json にはログの ID (開くたびに変わる sess_…) を書かない。動画の時刻は「その走行の何番目のログの先頭から何秒」か
 * 「世界の時刻」で持つ。開いたときは、その走行のログ (読み込んだ順 = 何番目) の今の ID に読み替える。
 * 書くときは、その走行のログで表し直す (比べる相手の動画を手で合わせると、Car 1 のログに付いた時刻になっているため)
 */

import type { Session } from '../types/telemetry';
import { clockOffsetIn, clockStartUtcMs, sessionStartUtcMs, type VideoClock } from './mediaClock';
import type { RunClock, RunPin, RunRow, RunVideo } from './runsFile';
import type { SyncProjectData, VideoTrack } from './videoSyncManager';
import type { SyncPin } from './videoSyncPinManager';

const round3 = (x: number) => Number(x.toFixed(3));

/** 行の動画を、同期を戻す形 (同期プロジェクトの動画の形、今のログの ID) にする。時刻を持たない動画は null */
export function syncVideoFromRow(v: RunVideo, runSessions: Session[]): SyncProjectData['videos'][number] | null {
  const c = v.clock;
  if (!c) return null;
  const logSession = c.logPart !== null ? runSessions[c.logPart - 1] : undefined;
  // そのログが無い (分かれ方が変わった) ときは、控えの世界の時刻で戻す
  const clock: VideoClock = logSession
    ? { source: c.source, logId: logSession.id, offsetSec: c.offsetSec, utcMs: c.utcMs }
    : { source: c.source, logId: null, offsetSec: 0, utcMs: c.utcMs };
  if (!logSession && clock.utcMs === null) return null;
  const shown = v.part ? runSessions[v.part - 1] : undefined;
  return {
    fileName: v.name,
    fileSize: v.size ?? 0,
    durationSec: v.durationSec ?? 0,
    rawRecordedAt: v.recordedAt ?? null,
    recordedAtJst: v.recordedAt ?? null,
    ...(v.timezone?.video ? { videoTimezone: v.timezone.video } : {}),
    ...(v.timezone?.gps ? { gpsTimezone: v.timezone.gps } : {}),
    matchedSessionId: shown?.id ?? null,
    ...(v.chosen ? { sessionChosenManually: true } : {}),
    clock
  };
}

/** 行の動画のピンを、開いている動画 (trackId) のピンにする (時刻は、その走行のログの今の ID で) */
export function syncPinsFromRow(v: RunVideo, trackId: string, runSessions: Session[]): Array<{ name: string; sessionTimeSec: number; videoTimeSec: number; sessionId?: string; createdAt?: string }> {
  return (v.pins ?? []).map(p => {
    const s = runSessions[p.logPart - 1];
    return { name: p.name, sessionTimeSec: p.logTimeSec, videoTimeSec: p.videoTimeSec, ...(s ? { sessionId: s.id } : {}), ...(p.createdAt ? { createdAt: p.createdAt } : {}), trackId };
  });
}

/**
 * 開いている動画を、その走行の行の動画にする。時刻は、その走行のログ (runSessions) で表し直す。
 * prev はその動画の前の行 (知らない項目を残すため)
 */
export function rowVideoFromTrack(track: VideoTrack, pins: SyncPin[], runSessions: Session[], allSessions: Session[], prev?: RunVideo): RunVideo {
  const partOf = (id: string | null | undefined) => {
    const i = id ? runSessions.findIndex(s => s.id === id) : -1;
    return i >= 0 ? i + 1 : null;
  };
  const shownPart = partOf(track.matchedSessionId);
  // 時刻を表し直すときの、その走行のログ (動画を出すログ。分からなければ 1 番目)
  const own = (shownPart ? runSessions[shownPart - 1] : undefined) ?? runSessions[0];
  const ownPart = own ? runSessions.indexOf(own) + 1 : 1;
  const utcMs = clockStartUtcMs(track.clock, allSessions);
  let clock: RunClock | undefined;
  const c = track.clock;
  const logPart = partOf(c.logId);
  if (logPart !== null) {
    clock = { source: c.source, logPart, offsetSec: round3(c.offsetSec), utcMs };
  } else if (c.logId) {
    // ほかのログ (Car 1 など) に付いた時刻: その走行のログでの秒に直す。直せなければ世界の時刻で
    const off = clockOffsetIn(c, own, allSessions);
    if (off !== null && own) clock = { source: c.source, logPart: ownPart, offsetSec: off, utcMs };
    else if (utcMs !== null) clock = { source: c.source, logPart: null, offsetSec: 0, utcMs };
  } else if (utcMs !== null) {
    clock = { source: c.source, logPart: null, offsetSec: 0, utcMs };
  }
  const rowPins: RunPin[] = [];
  for (const p of pins) {
    const pinPart = partOf(p.sessionId);
    if (pinPart !== null) {
      const start = sessionStartUtcMs(runSessions[pinPart - 1]);
      rowPins.push({ name: p.name, logPart: pinPart, logTimeSec: round3(p.sessionTimeSec), videoTimeSec: round3(p.videoTimeSec), utcMs: start === null ? null : Math.round(start + p.sessionTimeSec * 1000), createdAt: p.createdAt });
      continue;
    }
    // ほかのログ (Car 1 など) の時刻で打ったピン: 世界の時刻を通して、その走行のログの時刻に直す
    const base = allSessions.find(s => s.id === p.sessionId);
    const baseStart = sessionStartUtcMs(base);
    const ownStart = sessionStartUtcMs(own);
    if (baseStart === null || ownStart === null) {
      // 基準のログが分からない古いピンは、その走行のログで打ったものとみなす
      if (!p.sessionId && own) rowPins.push({ name: p.name, logPart: ownPart, logTimeSec: round3(p.sessionTimeSec), videoTimeSec: round3(p.videoTimeSec), createdAt: p.createdAt });
      continue;
    }
    const at = baseStart + p.sessionTimeSec * 1000;
    rowPins.push({ name: p.name, logPart: ownPart, logTimeSec: round3((at - ownStart) / 1000), videoTimeSec: round3(p.videoTimeSec), utcMs: Math.round(at), createdAt: p.createdAt });
  }
  const { clock: _c, pins: _p, part: _pt, chosen: _ch, ...rest } = prev ?? { name: track.fileName };
  return {
    ...rest,
    name: track.fileName,
    size: track.fileSize,
    durationSec: track.durationSec,
    recordedAt: track.rawRecordedAt ? track.rawRecordedAt.toISOString() : null,
    timezone: { video: track.videoTimezone, gps: track.gpsTimezone },
    part: shownPart,
    ...(track.isSessionChosenManually ? { chosen: true } : {}),
    ...(clock ? { clock } : {}),
    ...(rowPins.length ? { pins: rowPins } : {})
  };
}

/** その走行のログの時計の補正 (何番目ごと)。前の行の知らない項目は残す */
export function rowParts(runSessions: Session[], prev?: RunRow['parts']): NonNullable<RunRow['parts']> {
  const parts: NonNullable<RunRow['parts']> = {};
  runSessions.forEach((s, i) => { parts[String(i + 1)] = { ...prev?.[String(i + 1)], clockOffsetSec: s.clockOffsetSec ?? 0 }; });
  return parts;
}
