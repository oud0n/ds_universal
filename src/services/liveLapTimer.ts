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
  /** 進む向き (度、北から右回り。端末の GPS が出すとき) */
  course?: number;
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
  /** この周の間に、測位が 2 秒より長く途切れた (ベストの周・デルタの基準にしない) */
  hadGap: boolean;
  /** セクターごとの途切れ (sectorsSec と同じ並び)。途切れたセクターは、セクターのベストの基準にしない */
  sectorGaps?: boolean[];
  /** セクター線・計測線を跨いだ所での、ベストの周との差 (セクターの数だけ。最後は周の差)。ベストが無かった所は null */
  splitDeltas?: Array<number | null>;
}

export interface LiveLapEvent {
  kind: 'lap';
  lap: LiveLap;
  /** その周を終える前のベストとの差 (秒。負なら速い)。初めての周は null */
  diffToBestSec: number | null;
  /** ベストを更新した (途切れた周は、速くてもベストにしない) */
  isBest: boolean;
}

export interface LiveSectorEvent {
  kind: 'sector';
  /** 0 から */
  index: number;
  timeSec: number;
  /** そのセクターのベストとの差 (秒)。ベストがまだないときは null */
  diffSec: number | null;
  /** 跨いだ所での、ベストの周との差 (秒。同じ距離を走ったときとの差)。ベストがないときは null */
  deltaSec: number | null;
}

/** 過去の走行のベストの周 (差の基準)。trace: 周の始まりからの距離 (m) と経過 (秒) の組 */
export interface PastReference {
  timeSec: number;
  trace: number[];
  sectorsSec: number[];
  /** その周の始まり (UTC ミリ秒。何日の走行か出すため) */
  startMs: number;
}

/** 差の基準にしている周 (過去の走行のベストか、この走行のベストの速い方) */
export interface LapReference {
  timeSec: number;
  /** この走行の周なら何周目か (過去の走行なら null) */
  lapNumber: number | null;
  /** 過去の走行なら、その周の始まり (UTC ミリ秒) */
  pastStartMs: number | null;
}

/** 今の周で終えたセクター */
export interface LiveSector {
  timeSec: number;
  diffSec: number | null;
  deltaSec: number | null;
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
  /** この走行のベスト (途切れた周は入れない) */
  best: LiveLap | null;
  /** 差の基準 (過去の走行のベストか、この走行のベストの速い方) */
  reference: LapReference | null;
  /** ベストの周の、同じ距離を走ったときとの差 (秒。負なら速い)。ベストがないときは null */
  deltaSec: number | null;
  /** 今の周で終えたセクター */
  currentSectors: LiveSector[];
  /** セクターの数 (計測線と重ならないセクター線の数 + 1。セクター線がなければ 0) */
  sectorCount: number;
  /** セクターの差の基準のタイム (セクターごとのベスト) */
  referenceSectorsSec: number[];
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
  /** 数えた周の向き (向きが替わったら、それまでの逆向きの周は捨てる) */
  private lapsDirection = 0;
  private prev: LiveFix | null = null;
  private lapNumber: number | null = null;
  private lapStartMs: number | null = null;
  private lastCrossMs = -Infinity;
  private lapDistanceM = 0;
  private lapHadGap = false;
  /** 今のセクターの間に途切れた / 終えたセクターごとの途切れ */
  private sectorHadGap = false;
  private splitGaps: boolean[] = [];
  /** 今の周で次に横切るセクター線 */
  private nextSector = 0;
  private lastSplitMs = 0;
  private splitsSec: number[] = [];
  private currentSectors: LiveSector[] = [];
  /** 今の周の、走った距離 (m) と経過 (秒) の組 */
  private trace: number[] = [];
  /** 差の基準の周の跡 (過去の走行のベストか、この走行のベスト) */
  private bestTrace: number[] | null = null;
  /** この走行のベストの周の跡 */
  private ownBestTrace: number[] | null = null;
  private laps: LiveLap[] = [];
  private best: LiveLap | null = null;
  /** セクターの差を出す基準 (セクターごとのベスト) */
  private refSectors: number[] = [];
  /** 過去の走行のベスト (差の基準。この走行のベストが速くなるまで使う) */
  private past: PastReference | null = null;
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
      this.sectorHadGap = true;
      return [];
    }
    if (dt > GAP_MARK_MS) { this.lapHadGap = true; this.sectorHadGap = true; }

    const events: LiveTimerEvent[] = [];
    const seg = distanceM(prev, fix);
    const cross = crossGate(prev, fix, this.gate);
    let lapCrossed = false;
    if (cross) {
      const tMs = prev.tMs + cross.t * dt;
      const speed = prev.speedKmh + cross.t * (fix.speedKmh - prev.speedKmh);
      // コースのデータの線には向きがないので、横切った向きに速さの分だけ票を入れ、多い方をコースの向きとする
      // (初めに逆向きに横切っても (ピット・パドック)、周回で速く横切れば、すぐそちらの向きになる。
      // 周回を重ねると票が大きくなるので、そのあとのスピンなどでは替わらない)
      if (speed >= SLOW_CROSSING_KMH) this.sideScore += cross.side * speed;
      const direction = Math.sign(this.sideScore);
      // 向きが替わったら、それまでに逆向きで数えた周 (パドックで 2 回逆向きに横切ったなど) は捨て、周を数え直す
      if (direction !== 0 && this.lapsDirection !== 0 && direction !== this.lapsDirection) {
        this.laps = [];
        this.best = null;
        this.ownBestTrace = null;
        this.bestTrace = this.past?.trace ?? null;
        this.refSectors = this.past ? [...this.past.sectorsSec] : [];
        this.lapsDirection = 0;
        this.lapNumber = null;
        this.deltaSec = null;
      }
      // 最短の間隔は、同じ向きの通過どうしで見る (逆向きの通過のすぐあとの周回の通過は数える)
      const counted = direction !== 0 && cross.side === direction && speed >= SLOW_CROSSING_KMH
        && ((tMs - this.lastCrossMs) / 1000 >= MIN_LAP_SEC || this.lapDirection !== direction);
      if (counted) {
        lapCrossed = true;
        this.lastCrossMs = tMs;
        // 横切るまでの分を足して周を終える。向きが替わったあとの初めての通過は、前の (逆向きの) 通過からを周と数えない
        this.lapDistanceM += seg * cross.t;
        if (this.lapStartMs !== null && this.lapDirection === direction) events.push(this.finishLap(tMs));
        // 逆向きで始めた周は数えないので、周の番号も進めない
        else if (this.lapStartMs !== null && this.lapNumber !== null) this.lapNumber--;
        this.startLap(tMs, seg * (1 - cross.t), fix);
        this.lapDirection = direction;
      }
    }
    if (!lapCrossed) {
      this.lapDistanceM += seg;
      if (this.lapStartMs !== null) {
        const sectorEvent = this.checkSector(prev, fix, dt, seg);
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
      reference: this.reference(),
      deltaSec: this.deltaSec,
      currentSectors: this.currentSectors,
      sectorCount: this.sectorCount,
      referenceSectorsSec: this.refSectors,
      lapDistanceM: this.lapDistanceM
    };
  }

  private startLap(tMs: number, distanceSoFar: number, fix: LiveFix): void {
    this.lapNumber = (this.lapNumber ?? 0) + 1;
    this.lapStartMs = tMs;
    this.lapDistanceM = distanceSoFar;
    this.lapHadGap = false;
    this.sectorHadGap = false;
    this.splitGaps = [];
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
    const sectorGaps = complete ? [...this.splitGaps, this.sectorHadGap] : undefined;
    const lap: LiveLap = { number: this.lapNumber!, timeSec, sectorsSec, hadGap: this.lapHadGap, ...(sectorGaps ? { sectorGaps } : {}) };
    this.trace.push(this.lapDistanceM, timeSec);
    const prevRef = this.reference();
    if (this.sectorGates.length > 0) {
      lap.splitDeltas = [...this.currentSectors.map(c => c.deltaSec), prevRef ? timeSec - prevRef.timeSec : null];
    }
    // 測位が途切れた周は、計測線の通過の時刻があやしいので、速くてもベスト (デルタの基準) にしない
    const isBest = !lap.hadGap && (!prevRef || timeSec < prevRef.timeSec);
    this.laps = [...this.laps, lap];
    this.lapsDirection = this.lapDirection;
    if (!lap.hadGap && (!this.best || timeSec < this.best.timeSec)) { this.best = lap; this.ownBestTrace = this.trace; }
    if (isBest) this.bestTrace = this.trace;
    // セクターの差の基準は、セクターごとのベスト (どの周のものでもよい)。ベストの周でセクター線を取りこぼしても基準が残る
    // 途切れたセクターは基準にしない (ほかのセクターは使う)
    this.refSectors = bestSectors(this.refSectors, lap);
    return { kind: 'lap', lap, diffToBestSec: prevRef ? timeSec - prevRef.timeSec : null, isBest };
  }

  /**
   * 過去の走行のベストを差の基準にする (null で外す)。この走行のベストの方が速ければ、そちらのまま。
   * セクターの基準も、過去の周のセクターと合わせて速い方にする
   */
  setPastReference(ref: PastReference | null): void {
    this.past = ref && ref.trace.length >= 4 && ref.timeSec > 0 ? ref : null;
    const own = this.best;
    this.bestTrace = own && (!this.past || own.timeSec <= this.past.timeSec) ? this.ownBestTrace : this.past?.trace ?? null;
    this.refSectors = this.laps.reduce(bestSectors, this.past?.sectorsSec ?? []);
    this.deltaSec = this.lapStartMs === null ? null : this.deltaAt(this.lapDistanceM, this.trace[this.trace.length - 1] ?? 0);
  }

  /** 差の基準 (過去の走行のベストか、この走行のベストの速い方) */
  private reference(): LapReference | null {
    const own = this.best, past = this.past;
    if (own && (!past || own.timeSec <= past.timeSec)) return { timeSec: own.timeSec, lapNumber: own.number, pastStartMs: null };
    return past ? { timeSec: past.timeSec, lapNumber: null, pastStartMs: past.startMs } : null;
  }

  /**
   * 次のセクター線から順に見て、横切った線のセクターを終える。
   * 線を取りこぼしても (測位の途切れ・線の外を通ったとき)、その先の線で続ける (取りこぼした所のタイムは NaN)
   */
  private checkSector(prev: LiveFix, fix: LiveFix, dt: number, seg: number): LiveSectorEvent | null {
    for (let j = this.nextSector; j < this.sectorGates.length; j++) {
      const c = crossGate(prev, fix, this.sectorGates[j]);
      if (!c) continue;
      const tMs = prev.tMs + c.t * dt;
      if ((tMs - this.lastSplitMs) / 1000 < MIN_SECTOR_SEC) return null;
      // 取りこぼした線
      for (let k = this.nextSector; k < j; k++) {
        this.splitsSec.push(NaN);
        this.splitGaps.push(true);
        this.currentSectors = [...this.currentSectors, { timeSec: NaN, diffSec: null, deltaSec: null }];
      }
      const split = (tMs - this.lapStartMs!) / 1000;
      const prevSplit = j > 0 ? this.splitsSec[j - 1] : 0;
      const timeSec = split - prevSplit;
      const bestSector = this.refSectors[j];
      const diffSec = bestSector !== undefined && Number.isFinite(timeSec) ? timeSec - bestSector : null;
      // 跨いだ所の距離は、この測位までに足した分から、線の先の分を引いたもの
      const deltaSec = this.deltaAt(this.lapDistanceM - seg * (1 - c.t), split);
      this.splitsSec.push(split);
      this.splitGaps.push(this.sectorHadGap);
      this.sectorHadGap = false;
      this.currentSectors = [...this.currentSectors, { timeSec, diffSec, deltaSec }];
      this.nextSector = j + 1;
      this.lastSplitMs = tMs;
      return { kind: 'sector', index: j, timeSec, diffSec, deltaSec };
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

function bestSectors(previous: number[], lap: LiveLap): number[] {
  if (!lap.sectorsSec.length) return previous;
  return lap.sectorsSec.map((time, i) => {
    const old = previous[i];
    if (lap.sectorGaps?.[i]) return old;
    return old === undefined ? time : Math.min(old, time);
  });
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
  // 丸めると 0 になる差は + にそろえる (同じタイムで -0.00 と +0.00 が入れ替わって見えた)
  const shown = Math.abs(sec).toFixed(digits);
  return `${sec >= 0 || Number(shown) === 0 ? '+' : '-'}${shown}`;
}
