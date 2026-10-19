/**
 * 動画の時刻 (docs/video_sets_design.md の 2)。動画とログの時刻の換算は、すべてここを通す。
 *
 * 動画の時刻は 1 つの形で持つ: 「ログ X の先頭から何秒」(ログに付いた時刻) か、「UTC の何時何分」(ログに付かない時刻)。
 * 出どころ (GPS・手で合わせた・撮影日時) は印だけで、換算の仕方は変わらない。
 * - ログに付いた時刻は、そのログの時計の補正を変えると一緒に動く (そのログのデータに対して合わせたので)
 * - UTC の時刻は動かない
 * 画面に出すときは、そのとき基準にしているログ (Car 1) での位置に直す (placeTrack)。動画を別のログに付け替えることはしない
 */
import type { Session } from '../types/telemetry';

/** 動画の時刻の出どころ。gps: 動画自身の GPS、manual: 手で合わせた・同期ピン、creation: ファイルの撮影日時 (±1 秒) */
export type ClockSource = 'gps' | 'manual' | 'creation';

export interface VideoClock {
  source: ClockSource;
  /** 時刻を付けたログ。null なら utcMs が時刻 */
  logId: string | null;
  /** logId のログの先頭 (時計の補正を引いた本当の時刻) から、動画の先頭のコマまでの秒 */
  offsetSec: number;
  /** 動画の先頭のコマの本当の時刻 (UTC、ミリ秒)。logId があるときは、そのログがないとき (読み込む前など) の控え */
  utcMs: number | null;
}

export const NO_CLOCK: VideoClock = { source: 'creation', logId: null, offsetSec: 0, utcMs: null };

/**
 * ログの先頭の本当の時刻 (UTC、ミリ秒)。ログの時計の補正 (clockOffsetSec) を引いたもの。時刻のないログは null。
 * ロガーごとの時計のずれは、ここ 1 か所で直す
 */
export function sessionStartUtcMs(session: Session | null | undefined): number | null {
  const ts = session?.points[0]?.timestamp;
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms - (session!.clockOffsetSec ?? 0) * 1000 : null;
}

/** 動画の先頭のコマの本当の時刻 (UTC、ミリ秒)。決まらなければ null */
export function clockStartUtcMs(clock: VideoClock, sessions: Session[]): number | null {
  if (clock.logId) {
    const start = sessionStartUtcMs(sessions.find(s => s.id === clock.logId));
    if (start !== null) return start + clock.offsetSec * 1000;
  }
  return clock.utcMs;
}

/**
 * 動画の先頭のコマの、あるログの時刻での位置 (秒)。決まらなければ null。
 * そのログに付いた時刻なら、時刻のないログ (UTC にできないログ) でもそのまま使える
 */
export function clockOffsetIn(clock: VideoClock, session: Session | null | undefined, sessions: Session[]): number | null {
  if (!session) return null;
  if (clock.logId === session.id) return clock.offsetSec;
  const v = clockStartUtcMs(clock, sessions);
  const s = sessionStartUtcMs(session);
  return v !== null && s !== null ? round3((v - s) / 1000) : null;
}

/** ログに付いた時刻を作る。そのログの先頭から offsetSec 秒 */
export function clockOnLog(source: ClockSource, session: Session, offsetSec: number): VideoClock {
  const start = sessionStartUtcMs(session);
  return { source, logId: session.id, offsetSec: round3(offsetSec), utcMs: start === null ? null : start + offsetSec * 1000 };
}

/** ログに付かない時刻を作る */
export function clockAtUtc(source: ClockSource, utcMs: number): VideoClock {
  return { source, logId: null, offsetSec: 0, utcMs };
}

/** sec 秒あとの時刻 (チャプターの 2 本目以降など、同じ時計で続く動画) */
export function shiftClock(clock: VideoClock, sec: number): VideoClock {
  return {
    ...clock,
    offsetSec: clock.logId ? round3(clock.offsetSec + sec) : 0,
    utcMs: clock.utcMs === null ? null : clock.utcMs + sec * 1000
  };
}

/** 控えの UTC を今のログの時刻で入れ直す (保存の前。ログを読み込まずに開いても位置が分かるように) */
export function refreshClockUtc(clock: VideoClock, sessions: Session[]): VideoClock {
  const utcMs = clockStartUtcMs(clock, sessions);
  return utcMs === clock.utcMs ? clock : { ...clock, utcMs };
}

function round3(x: number): number {
  return Number(x.toFixed(3));
}
