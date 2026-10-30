/**
 * ラップタイマーの差の基準にする、保管場所の過去の周 (比べる相手)。
 * 既定は「この車のベスト」(このコースの、選んだ車の自分の走行のベストの周)
 */
import { lapKey, lapPointsFromFile, type LapCourse, type LapIndex } from '../lapIndex';
import { findRunRow, type RunsFile } from '../runsFile';
import type { PastReference } from '../liveLapTimer';
import type { TelemetryPoint } from '../../types/telemetry';
import type { RunStore } from '../runStore';

/** 控え (laptimes.json) の 1 周と、そのファイル */
export interface IndexedLap {
  file: string;
  part?: number;
  n: number;
  time: number;
  startMs: number;
  sectors: number[];
}

export interface LapReferenceContext {
  /** 選んだ車 (空なら車を書いていない走行) */
  car: string;
  /** 自分の走行で、選んだ車の、隠していない周 */
  ownLaps: IndexedLap[];
  /** 自分のではない走行 (参考ラップ) の、隠していない周 */
  referenceLaps: Array<IndexedLap & { driver?: string; car?: string }>;
  /** その周の点 (読めなければ null) */
  lapPoints(lap: IndexedLap): Promise<TelemetryPoint[] | null>;
}

export interface LapReferenceChoice {
  ref: PastReference;
  /** 画面の「ベスト」の横に出す短い印 (日付など。日本語・英語) */
  tag: [string, string];
}

export interface LapReferenceSource {
  id: string;
  label: [string, string];
  load(ctx: LapReferenceContext): Promise<LapReferenceChoice | null>;
}

/** 周の点から、周の始めからの距離 (m) と経過 (秒) の組を作る */
export function traceOf(points: TelemetryPoint[]): number[] {
  const out: number[] = [];
  for (const p of points) out.push((p.distance - points[0].distance) * 1000, p.time - points[0].time);
  return out;
}

export const dayTag = (ms: number): string => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };

/** 1 つの周を、そのまま比べる相手にする */
export async function lapAsReference(ctx: LapReferenceContext, lap: IndexedLap, tag: [string, string] = [dayTag(lap.startMs), dayTag(lap.startMs)]): Promise<LapReferenceChoice | null> {
  const pts = await ctx.lapPoints(lap);
  if (!pts || pts.length < 2) return null;
  return { ref: { timeSec: lap.time, trace: traceOf(pts), sectorsSec: lap.sectors, startMs: lap.startMs }, tag };
}

export const fastest = <T extends { time: number }>(laps: T[]): T | null => laps.reduce<T | null>((a, l) => (!a || l.time < a.time ? l : a), null);

/** 既定: この車のベスト */
export const carBestSource: LapReferenceSource = {
  id: 'car-best',
  label: ['この車のベスト', 'Best with this car'],
  load: async ctx => { const best = fastest(ctx.ownLaps); return best ? lapAsReference(ctx, best) : null; }
};

/** 保管場所の控えと走行の行から、比べる相手を選ぶ材料を作る */
export function makeReferenceContext(store: RunStore, folder: string, course: LapCourse, car: string, index: LapIndex, runs: RunsFile | null): LapReferenceContext {
  const hidden = new Set(index.hidden.map(h => lapKey(h.file, h.part, h.n)));
  const ownLaps: IndexedLap[] = [];
  const referenceLaps: LapReferenceContext['referenceLaps'] = [];
  for (const [file, rec] of Object.entries(index.files)) {
    const row = runs ? findRunRow(runs, file) : undefined;
    for (const l of rec.laps) {
      if (hidden.has(lapKey(file, l.part, l.n))) continue;
      const lap: IndexedLap = { file, ...(l.part !== undefined ? { part: l.part } : {}), n: l.n, time: l.time, startMs: l.startMs, sectors: l.sectors };
      if (row?.reference) referenceLaps.push({ ...lap, driver: row.reference.driver, car: row.reference.car });
      else if ((row?.car?.trim() ?? '') === car) ownLaps.push(lap);
    }
  }
  const files = new Map<string, Promise<Uint8Array | null>>();
  return {
    car, ownLaps, referenceLaps,
    lapPoints: async lap => {
      let bytes = files.get(lap.file);
      if (!bytes) { bytes = store.read(`${folder}/${lap.file}`).catch(() => null); files.set(lap.file, bytes); }
      const b = await bytes;
      return b ? lapPointsFromFile(lap.file, b, course, lap.part, lap.n) : null;
    }
  };
}
