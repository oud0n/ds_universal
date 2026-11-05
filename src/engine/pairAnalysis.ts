import type {Session,TelemetryPoint} from '../types/telemetry';
import {analyseTimed,toTimed,type PairAnalysis,type TimedPoint} from './clockOffsetEstimator';
export interface PairExecutionPort { analyse(reference:TimedPoint[],other:TimedPoint[]):Promise<PairAnalysis|null> }
/** キャッシュは実データの組に結び付ける。ホストをまたがず、閉じた点列を強参照しない。 */
export function createPairAnalyser(execution:PairExecutionPort={analyse:async(a,b)=>analyseTimed(a,b)}) {
 const cache=new WeakMap<TelemetryPoint[],WeakMap<TelemetryPoint[],Promise<PairAnalysis|null>>>();
 const analyseSessions=(reference:Session,other:Session):Promise<PairAnalysis|null>=>{
  let matches=cache.get(reference.points);if(!matches){matches=new WeakMap();cache.set(reference.points,matches);}
  const hit=matches.get(other.points);if(hit)return hit;
  const referencePoints=reference.points,otherPoints=other.points;
  const pending=Promise.resolve().then(()=>execution.analyse(toTimed(referencePoints),toTimed(otherPoints)));
  matches.set(otherPoints,pending);
  void pending.catch(()=>{if(matches!.get(otherPoints)===pending)matches!.delete(otherPoints);});
  return pending;
 };
 return {analyseSessions,async isSameRun(a:Session,b:Session):Promise<boolean>{return a.id===b.id || ((await analyseSessions(a,b))?.sameRun??false);}};
}
