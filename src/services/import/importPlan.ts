/**
 * 取り込みの案を作る (2026-10-21、PLAN-24 の取り込みの画面。設計は Fable の案 B)。画面もファイルの書き込みもしない、計算だけ。
 *
 * 1. 記録の空き (10 分以上) で分ける (logLoader.parseLogBuffer がした分け方)
 * 2. 場所で分ける: 30 秒ごとに近くのサーキット (5 km 以内) を決め、場所が替わった所で分ける (1 分より短い替わりは前後に混ぜる)
 * 3. それぞれ: サーキットなら、どのコースか (同じ敷地の違うコースは計測線を通ったかで)・周の数。スタートとゴールが別のコースなら区間。
 *    サーキットでないところは、計測線を自動で置けたら「知らない場所」、置けなければ「移動」(移動は既定で取り込まない)
 * 4. 保存先: <サーキットのフォルダ>/<日付>/<走り始めの時刻>.nmea。同じ名前がもうあれば「取り込み済み」
 */

import type { CircuitPreset, ControlLine, TelemetryPoint } from '../../types/telemetry';
import { findMatchingCircuit } from '../circuitDatabase';
import { extractLaps } from '../lapCalculator';
import { createAutoControlLine } from '../autoCourseLines';
import { courseFolder } from '../../utils/courseNames';
import { runFileBase } from '../runFiles';
import type { ParsedLog } from '../logLoader';

export type ImportKind = 'laps' | 'stage' | 'transit' | 'unknown';

export type ImportDest =
  | { kind: 'circuit'; folder: string; courseName: string }
  | { kind: 'unsorted' };

export interface ImportPart {
  id: string;
  /** 走り始め・終わり (UTC ミリ秒) */
  startMs: number;
  endMs: number;
  points: TelemetryPoint[];
  /** 走行の始まり (点に時刻の文字がない形式で、点の時刻を出すため) */
  startDate?: Date;
  /** 速さの折れ線 (画面に出す。80 点ほど) */
  sparkline: number[];
  kind: ImportKind;
  /** 周 (区間) の数 */
  laps: number;
  course: CircuitPreset | null;
  /** 知らない場所で、自動で置けた計測線 (新しいコースにするとき使う) */
  autoLine?: ControlLine;
  dest: ImportDest;
  /** 書くファイル (保管場所からの道。拡張子なし) */
  base: string;
  /** 取り込むか (移動・取り込み済みは既定で外す) */
  checked: boolean;
  /** 同じ名前の走行がもうある (取り込み済み) */
  already: boolean;
}

export interface ImportPlan {
  sourceName: string;
  /** 読んだ形式 (nmea・bon4 など) */
  sourceKind: string;
  parts: ImportPart[];
}

export const UNSORTED = 'unsorted';
/** 場所を決める間隔 (秒) */
const PLACE_STEP_SEC = 30;
/** これより短い場所の替わりは、前後に混ぜる (秒) */
const PLACE_MIN_SEC = 60;
/** サーキットとみなす距離 (km) */
const NEAR_KM = 5;

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * cosLat * 111.32, (lat2 - lat1) * 111.32);
}

/** 点の UTC 時刻 (ミリ秒)。時刻の文字が無ければ、走行の始まり + 経過 */
function pointMs(p: TelemetryPoint, startDate?: Date): number {
  const t = p.timestamp ? Date.parse(p.timestamp) : NaN;
  if (Number.isFinite(t)) return t;
  return (startDate?.getTime() ?? 0) + p.time * 1000;
}

export interface PlanDeps {
  /** 場所から近くのサーキットを探す (試験で差し替える) */
  findCircuit?: (lat: number, lon: number, points?: TelemetryPoint[]) => CircuitPreset | undefined;
}

/** 1 つの走行を、場所 (近くのサーキット) の替わり目で分ける。返すのは [始まりの添字, 終わりの添字 (含まない), 場所の ID] */
export function splitByPlace(points: TelemetryPoint[], deps: PlanDeps = {}): Array<[number, number, string]> {
  const find = deps.findCircuit ?? findMatchingCircuit;
  if (points.length === 0) return [];
  // 30 秒ごとの場所
  const marks: Array<{ i: number; place: string }> = [];
  let nextT = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.time < nextT) continue;
    nextT = p.time + PLACE_STEP_SEC;
    const c = find(p.latitude, p.longitude);
    marks.push({ i, place: c && distanceKm(p.latitude, p.longitude, c.centerLat, c.centerLon) < NEAR_KM ? c.id : '' });
  }
  // 同じ場所の続きにまとめる
  let runs: Array<{ from: number; place: string; marks: number }> = [];
  for (const m of marks) {
    const last = runs[runs.length - 1];
    if (last && last.place === m.place) last.marks++;
    else runs.push({ from: m.i, place: m.place, marks: 1 });
  }
  // 短い替わり (1 分より短い) は前の続きに混ぜる (はじめのものは次に混ぜる)
  const minMarks = Math.ceil(PLACE_MIN_SEC / PLACE_STEP_SEC);
  for (let changed = true; changed && runs.length > 1;) {
    changed = false;
    const k = runs.findIndex(r => r.marks < minMarks);
    if (k < 0) break;
    if (k === 0) { runs[1] = { ...runs[1], from: runs[0].from, marks: runs[1].marks + runs[0].marks }; runs.splice(0, 1); }
    else { runs[k - 1].marks += runs[k].marks; runs.splice(k, 1); }
    // 混ぜたあとに同じ場所が並んだら 1 つに
    const merged: typeof runs = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.place === r.place) last.marks += r.marks;
      else merged.push({ ...r });
    }
    runs = merged;
    changed = true;
  }
  return runs.map((r, k) => [r.from, k + 1 < runs.length ? runs[k + 1].from : points.length, r.place]);
}

/** 道の最後の名前 (YYYYMMDDhhmmss) を、端末の時刻として読む */
function stemMs(stem: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(stem);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** 同じフォルダ・日付に、走り始めの近い (10 秒以内) 走行があるか */
function sameRunExists(existing: ReadonlySet<string>, base: string, startMs: number): boolean {
  const dir = base.slice(0, base.lastIndexOf('/') + 1);
  for (const e of existing) {
    if (!e.startsWith(dir)) continue;
    const t = stemMs(e.slice(dir.length));
    if (t !== null && Math.abs(t - startMs) <= 10_000) return true;
  }
  return false;
}

/** 速さの折れ線 (n 点に間引く) */
function sparkline(points: TelemetryPoint[], n = 80): number[] {
  if (points.length <= n) return points.map(p => p.speed ?? 0);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = Math.floor((k * points.length) / n);
    const b = Math.max(a + 1, Math.floor(((k + 1) * points.length) / n));
    let m = 0;
    for (let i = a; i < b; i++) m = Math.max(m, points[i].speed ?? 0);
    out.push(m);
  }
  return out;
}

/**
 * 取り込みの案を作る。existing は保管場所にある走行の道 (拡張子なし。例 sodegaura/20260913/20260913092357)。
 * 同じ道があれば「取り込み済み」として外しておく
 */
export function planImport(parsed: ParsedLog, sourceName: string, existing: ReadonlySet<string>, deps: PlanDeps = {}): ImportPlan {
  const find = deps.findCircuit ?? findMatchingCircuit;
  const parts: ImportPart[] = [];
  for (const [pi, part] of parsed.parts.entries()) {
    const pts = part.points as TelemetryPoint[];
    for (const [si, [from, to, place]] of splitByPlace(pts, deps).entries()) {
      const seg = pts.slice(from, to);
      if (seg.length < 2) continue;
      const startMs = pointMs(seg[0], part.startDate);
      const endMs = pointMs(seg[seg.length - 1], part.startDate);
      let kind: ImportKind;
      let laps = 0;
      let course: CircuitPreset | null = null;
      let autoLine: ControlLine | undefined;
      if (place) {
        // 同じ敷地に計測線の違うコースがあるときは、計測線を通ったコースにする
        // 場所は真ん中の点で見る (始めの短い移動を混ぜたとき、始めの点がサーキットから遠いことがある)
        const mid = seg[seg.length >> 1];
        course = find(mid.latitude, mid.longitude, seg) ?? null;
        const r = course?.controlLine ? extractLaps(seg, course.controlLine, course.sectors ?? [], course.finishLine) : null;
        laps = r ? r.laps.filter(l => !l.isWholeSession && !l.isPartialLap).length : 0;
        kind = course?.finishLine ? 'stage' : 'laps';
      } else {
        autoLine = createAutoControlLine(seg);
        kind = autoLine ? 'unknown' : 'transit';
        if (autoLine) laps = extractLaps(seg, autoLine).laps.filter(l => !l.isWholeSession && !l.isPartialLap).length;
      }
      const dest: ImportDest = course ? { kind: 'circuit', folder: courseFolder(course.name, course.folder, course.id), courseName: course.name } : { kind: 'unsorted' };
      const stamp = runFileBase(startMs);
      const base = `${dest.kind === 'circuit' ? dest.folder : UNSORTED}/${stamp.slice(0, 8)}/${stamp}`;
      // 同じ日付のフォルダに、走り始めが 10 秒以内の走行があれば取り込み済み (記録したときの名前は、最初に位置が取れた時刻で付くので、
      // ログの最初の点と少しずれることがある)
      const already = existing.has(base) || sameRunExists(existing, base, startMs);
      parts.push({
        id: `${pi}-${si}`,
        startMs, endMs, points: seg, ...(part.startDate ? { startDate: part.startDate } : {}), sparkline: sparkline(seg),
        kind, laps, course, ...(autoLine ? { autoLine } : {}), dest, base,
        checked: !already && kind !== 'transit',
        already
      });
    }
  }
  return { sourceName, sourceKind: parsed.kind, parts };
}
