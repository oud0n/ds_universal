/**
 * 2 つのログの比べ (同じ走行か・時計のずれとその扱い) を、Web Worker で行い、ログの組ごとに覚えておく。
 * 1 組 0.4 秒ほどかかり、ログが多いと画面が引っかかるため (docs/video_sets_design.md の 4)。
 * Worker を使えないところ (テスト) では、その場で計算する
 */
import type { Session } from '../types/telemetry';
import { analyseTimed, toTimed, PairAnalysis, TimedPoint } from './clockOffsetEstimator';

import {createPairAnalyser} from '../engine/pairAnalysis';
let worker: Worker | null = null;
// Worker が動かなかった (読み込めない・落ちた)。以後はその場で計算する
let workerBroken = false;
let nextId = 0;
const pending = new Map<number, { resolve: (r: PairAnalysis | null) => void; ref: TimedPoint[]; other: TimedPoint[] }>();

function getWorker(): Worker | null {
  if (worker || workerBroken || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./pairAnalysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result: PairAnalysis | null }>) => {
      pending.get(e.data.id)?.resolve(e.data.result);
      pending.delete(e.data.id);
    };
    // Worker が読み込めなかった・落ちたときは、待っている比べをその場で計算して返す (待ったままにしない)
    worker.onerror = () => {
      workerBroken = true;
      worker?.terminate();
      worker = null;
      for (const [id, p] of pending) { p.resolve(analyseTimed(p.ref, p.other)); pending.delete(id); }
    };
  } catch {
    worker = null;
    workerBroken = true;
  }
  return worker;
}

function pack(points: TimedPoint[]): Float64Array {
  const a = new Float64Array(points.length * 4);
  points.forEach((p, i) => { a[i * 4] = p.t; a[i * 4 + 1] = p.lat; a[i * 4 + 2] = p.lon; a[i * 4 + 3] = p.speed; });
  return a;
}

const analyser = createPairAnalyser({analyse: (ref,oth)=>{
 const w=getWorker();
 if(!w)return Promise.resolve(analyseTimed(ref,oth));
 return new Promise<PairAnalysis|null>(resolve=>{
  const id=++nextId;pending.set(id,{resolve,ref,other:oth});
  try {const a=pack(ref),b=pack(oth);w.postMessage({id,ref:a,other:b},[a.buffer,b.buffer]);}
  catch {pending.delete(id);resolve(analyseTimed(ref,oth));}
 });
}});
export const {analyseSessions,isSameRun}=analyser;
