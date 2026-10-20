/**
 * 走りながら周を区切るラップタイマー (docs/iphone_app_design.md の 5。暫定の版)。
 *
 * 測位を 1 つずつ渡すと、計測線・セクター線を横切ったかを見て、周のタイム・セクターのタイム・ベストとの差を出す。
 * 横切った時刻は、前後の測位の間で線を横切った所から求める (解析の画面の周の区切りと同じ判定。crossGate)。
 * 測位の出どころ (デジスパイスの BLE・iPhone の GPS・ログの再生) によらず同じに使う。画面は持たない
 */

import { crossGate, type Gate } from './lapCalculator';
import type { ControlLine, Sector } from '../types/telemetry';

export interface LiveFix {
  /** 測位の時刻 (UTC ミリ秒) */
  tMs: number;
  latitude: number;
  longitude: number;
  speedKmh: number;
  /** 測位できているか (できていない測位は使わない) */
  valid: boolean;
  altitude?: number;
}

export interface LiveCourse {
  controlLine: ControlLine;
  /** セクター線 (内蔵のコースのように、最後に計測線と同じ線が入っていてもよい。計測線と重なる線は使わない) */
  sectors: Sector[];
}

export interface LiveLap {
  /** 何周目か (計測線を初めて横切ってからの 1 周目が 1) */
  number: number;
  timeSec: number;
  /** セクターごとのタイム。セクター線を取りこぼした周は空 */
  sectorsSec: number[];
  /** この周の間に、測位が 2 秒より長く途切れた */
  hadGap: boolean;
}

export interface LiveLapEvent {
  kind: 'lap';
  lap: LiveLap;
  /** その周を終える前のベストとの差 (秒。負なら速い)。初めての周は null */
  diffToBestSec: number | null;
  isBest: boolean;
}

export interface LiveSectorEvent {
  kind: 'sector';
  /** 0 から */
  index: number;
  timeSec: number;
  /** ベストの周の同じセクターとの差 (秒)。ベストがまだない・ベストの周でセクターを取りこぼしたときは null */
  diffSec: number | null;
}

export type LiveTimerEvent = LiveLapEvent | LiveSectorEvent;

export interface LiveLapState {
  /** 走っている周 (計測線をまだ横切っていなければ null) */
  lapNumber: number | null;
  /** 今の周の始まり (UTC ミリ秒) */
  lapStartMs: number | null;
  /** 最後に使った測位 */
  lastFix: LiveFix | null;
  laps: LiveLap[];
  best: LiveLap | null;
  /** ベストの周の、同じ距離を走ったときとの差 (秒。負なら速い)。ベストがないときは null */
  deltaSec: number | null;
  /** 今の周で終えたセクター */
  currentSectors: Array<{ timeSec: number; diffSec: number | null }>;
  /** セクターの数 (計測線と重ならないセクター線の数 + 1。セクター線がなければ 0) */
  sectorCount: number;
  /** 今の周で走った距離 (m) */
  lapDistanceM: number;
}

/** 周の区切りとして数える最短の間隔 (秒)。GPS の揺れで同じ通過を 2 回数えないように */
const MIN_LAP_SEC = 15;
/** これより遅い通過は、周の区切りとして数えない (ピットで線の上に止まっているときの揺れ) */
const SLOW_CROSSING_KMH = 5;
/** これより長く測位が途切れたら、その周に印を付ける (ミリ秒) */
const GAP_MARK_MS = 2000;
/** これより長く測位が途切れたら、途切れの前後で線を横切ったとは見ない (ミリ秒) */
const GAP_BREAK_MS = 30000;
/** セクター線を、周の始まり・前のセクターからこれより早く数えない (秒) */
const MIN_SECTOR_SEC = 3;
/** 計測線とこれより近いセクター線 (m) は、計測線と同じ線とみなして使わない */
const SAME_LINE_M = 5;

const DEG = Math.PI / 180;

/** 2 点の間の距離 (m)。短い間なので平面とみなす */
function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const cosLat = Math.cos(((a.latitude + b.latitude) / 2) * DEG);
  const dx = (b.longitude - a.longitude) * cosLat * 111320;
  const dy = (b.latitude - a.latitude) * 111320;
  return Math.hypot(dx, dy);
}

function gateMid(g: Gate): { latitude: number; longitude: number } {
  return { latitude: (g.latA + g.latB) / 2, longitude: (g.lonA + g.lonB) / 2 };
}

export class LiveLapTimer {
  private readonly gate: Gate;
  private readonly sectorGates: Gate[];
  /** 通過の向きの票 (向き × 通過の速さの和)。多い方の向きをコースの向きとする */
  private sideScore = 0;
  /** 今の周を始めたときの向き (向きが替わったら、その周は数えない) */
  private lapDirection = 0;
  private prev: LiveFix | null = null;
  private lapNumber: number | null = null;
  private lapStartMs: number | null = null;
  private lastCrossMs = -Infinity;
  private lapDistanceM = 0;
  private lapHadGap = false;
  /** 今の周で次に横切るセクター線 */
  private nextSector = 0;
  private lastSplitMs = 0;
  private splitsSec: number[] = [];
  private currentSectors: Array<{ timeSec: number; diffSec: number | null }> = [];
  /** 今の周の、走った距離 (m) と経過 (秒) の組 */
  private trace: number[] = [];
  private bestTrace: number[] | null = null;
  private laps: LiveLap[] = [];
  private best: LiveLap | null = null;
  private deltaSec: number | null = null;

  constructor(course: LiveCourse) {
    this.gate = course.controlLine;
    const mid = gateMid(this.gate);
    this.sectorGates = course.sectors.filter(s => distanceM(gateMid(s), mid) >= SAME_LINE_M);
  }

  get sectorCount(): number {
    return this.sectorGates.length > 0 ? this.sectorGates.length + 1 : 0;
  }

  /** 測位を 1 つ渡す。周やセクターを終えたら、その知らせを返す */
  push(fix: LiveFix): LiveTimerEvent[] {
    if (!fix.valid || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return [];
    const prev = this.prev;
    // 時刻が戻った・同じ測位は使わない
    if (prev && fix.tMs <= prev.tMs) return [];
    this.prev = fix;
    if (!prev) return [];
    const dt = fix.tMs - prev.tMs;
    if (dt > GAP_BREAK_MS) {
      this.lapHadGap = true;
      return [];
    }
    if (dt > GAP_MARK_MS) this.lapHadGap = true;

    const events: LiveTimerEvent[] = [];
    const seg = distanceM(prev, fix);
    const cross = crossGate(prev, fix, this.gate);
    let lapCrossed = false;
    if (cross) {
      const tMs = prev.tMs + cross.t * dt;
      const speed = prev.speedKmh + cross.t * (fix.speedKmh - prev.speedKmh);
      // コースのデータの線には向きがないので、横切った向きに速さの分だけ票を入れ、多い方をコースの向きとする
      // (初めに逆向きにゆっくり横切っても (ピットなど)、周回で速く横切れば、すぐそちらの向きになる)
      if (speed >= SLOW_CROSSING_KMH) this.sideScore += cross.side * speed;
      const direction = Math.sign(this.sideScore);
      // 最短の間隔は、同じ向きの通過どうしで見る (逆向きの通過のすぐあとの周回の通過は数える)
      const counted = direction !== 0 && cross.side === direction && speed >= SLOW_CROSSING_KMH
        && ((tMs - this.lastCrossMs) / 1000 >= MIN_LAP_SEC || this.lapDirection !== direction);
      if (counted) {
        lapCrossed = true;
        this.lastCrossMs = tMs;
        // 横切るまでの分を足して周を終える。向きが替わったあとの初めての通過は、前の (逆向きの) 通過からを周と数えない
        this.lapDistanceM += seg * cross.t;
        if (this.lapStartMs !== null && this.lapDirection === direction) events.push(this.finishLap(tMs));
        this.startLap(tMs, seg * (1 - cross.t), fix);
        this.lapDirection = direction;
      }
    }
    if (!lapCrossed) {
      this.lapDistanceM += seg;
      if (this.lapStartMs !== null) {
        const sectorEvent = this.checkSector(prev, fix, dt);
        if (sectorEvent) events.push(sectorEvent);
        const elapsed = (fix.tMs - this.lapStartMs) / 1000;
        this.trace.push(this.lapDistanceM, elapsed);
        this.deltaSec = this.deltaAt(this.lapDistanceM, elapsed);
      }
    }
    return events;
  }

  getState(): LiveLapState {
    return {
      lapNumber: this.lapNumber,
      lapStartMs: this.lapStartMs,
      lastFix: this.prev,
      laps: this.laps,
      best: this.best,
      deltaSec: this.deltaSec,
      currentSectors: this.currentSectors,
      sectorCount: this.sectorCount,
      lapDistanceM: this.lapDistanceM
    };
  }

  private startLap(tMs: number, distanceSoFar: number, fix: LiveFix): void {
    this.lapNumber = (this.lapNumber ?? 0) + 1;
    this.lapStartMs = tMs;
    this.lapDistanceM = distanceSoFar;
    this.lapHadGap = false;
    this.nextSector = 0;
    this.lastSplitMs = tMs;
    this.splitsSec = [];
    this.currentSectors = [];
    this.trace = [0, 0, distanceSoFar, (fix.tMs - tMs) / 1000];
    this.deltaSec = this.bestTrace ? 0 : null;
  }

  private finishLap(tMs: number): LiveLapEvent {
    const timeSec = (tMs - this.lapStartMs!) / 1000;
    const complete = this.sectorGates.length > 0 && this.splitsSec.length === this.sectorGates.length && this.splitsSec.every(Number.isFinite);
    const sectorsSec = complete
      ? [...this.splitsSec.map((s, i) => s - (i > 0 ? this.splitsSec[i - 1] : 0)), timeSec - this.splitsSec[this.splitsSec.length - 1]]
      : [];
    const lap: LiveLap = { number: this.lapNumber!, timeSec, sectorsSec, hadGap: this.lapHadGap };
    this.trace.push(this.lapDistanceM, timeSec);
    const prevBest = this.best;
    const isBest = !prevBest || timeSec < prevBest.timeSec;
    this.laps = [...this.laps, lap];
    if (isBest) {
      this.best = lap;
      this.bestTrace = this.trace;
    }
    return { kind: 'lap', lap, diffToBestSec: prevBest ? timeSec - prevBest.timeSec : null, isBest };
  }

  /**
   * 次のセクター線から順に見て、横切った線のセクターを終える。
   * 線を取りこぼしても (測位の途切れ・線の外を通ったとき)、その先の線で続ける (取りこぼした所のタイムは NaN)
   */
  private checkSector(prev: LiveFix, fix: LiveFix, dt: number): LiveSectorEvent | null {
    for (let j = this.nextSector; j < this.sectorGates.length; j++) {
      const c = crossGate(prev, fix, this.sectorGates[j]);
      if (!c) continue;
      const tMs = prev.tMs + c.t * dt;
      if ((tMs - this.lastSplitMs) / 1000 < MIN_SECTOR_SEC) return null;
      // 取りこぼした線
      for (let k = this.nextSector; k < j; k++) {
        this.splitsSec.push(NaN);
        this.currentSectors = [...this.currentSectors, { timeSec: NaN, diffSec: null }];
      }
      const split = (tMs - this.lapStartMs!) / 1000;
      const prevSplit = j > 0 ? this.splitsSec[j - 1] : 0;
      const timeSec = split - prevSplit;
      const bestSector = this.best?.sectorsSec[j];
      const diffSec = bestSector !== undefined && Number.isFinite(timeSec) ? timeSec - bestSector : null;
      this.splitsSec.push(split);
      this.currentSectors = [...this.currentSectors, { timeSec, diffSec }];
      this.nextSector = j + 1;
      this.lastSplitMs = tMs;
      return { kind: 'sector', index: j, timeSec, diffSec };
    }
    return null;
  }

  /** ベストの周で、同じ距離を走ったときの経過との差 */
  private deltaAt(distM: number, elapsed: number): number | null {
    const t = this.bestTrace;
    if (!t || t.length < 4) return null;
    const n = t.length / 2;
    // ベストの周より長く走っている (外を回った・GPS の揺れ) ときは、ベストの周の終わりと比べる (計測線の手前で差が消えないように)
    if (distM >= t[(n - 1) * 2]) return elapsed - t[(n - 1) * 2 + 1];
    // 距離で二分探索
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid * 2] <= distM) lo = mid;
      else hi = mid;
    }
    const d0 = t[lo * 2];
    const d1 = t[hi * 2];
    const e0 = t[lo * 2 + 1];
    const e1 = t[hi * 2 + 1];
    const bestElapsed = d1 > d0 ? e0 + ((distM - d0) / (d1 - d0)) * (e1 - e0) : e0;
    return elapsed - bestElapsed;
  }
}

/** 周のタイムを m:ss.SSS (digits は小数の桁) */
export function formatLapTime(sec: number, digits = 3): string {
  if (!Number.isFinite(sec)) return '--:--';
  const sign = sec < 0 ? '-' : '';
  const a = Math.abs(sec);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  const sStr = s.toFixed(digits).padStart(digits > 0 ? digits + 3 : 2, '0');
  // 丸めで 60 秒になったとき
  if (sStr.startsWith('60')) return `${sign}${m + 1}:${(0).toFixed(digits).padStart(digits > 0 ? digits + 3 : 2, '0')}`;
  return `${sign}${m}:${sStr}`;
}

/** 差を +0.12 / -0.34 の形で */
export function formatDelta(sec: number | null, digits = 2): string {
  if (sec === null || !Number.isFinite(sec)) return '';
  return `${sec >= 0 ? '+' : '-'}${Math.abs(sec).toFixed(digits)}`;
}
