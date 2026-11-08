import type {Session} from '../../types/telemetry';
import type {GFilterLevel} from '../../engine/physics';
import {applyGFilter} from '../../engine/physics';
import {getGFilterLevel} from '../../services/physics';
import {extractLaps} from '../../engine/lapCalculator';

// 未公開の解析結果に使った設定。点列の寿命とともに解放し、正本や永続設定にはしない。
const levels=new WeakMap<Session['points'],GFilterLevel>();
export function noteParsedPhysics(points:Session['points'],level:GFilterLevel){levels.set(points,level);}
export function refreshParsedPhysics(sessions:Session[],level=getGFilterLevel()):Session[]{
 return sessions.map(session=>{
  const prior=levels.get(session.points);
  if(prior===undefined||prior===level)return session;
  const points=applyGFilter(session.points.map(point=>({...point})),level);
  levels.set(points,level);
  const computed=extractLaps(points,session.controlLine,session.sectors,session.finishLine);
  const laps=computed.laps.map(fresh=>{
   const old=session.laps.find(lap=>lap.lapNumber===fresh.lapNumber&&lap.startTime===fresh.startTime&&lap.endTime===fresh.endTime&&lap.startIndex===fresh.startIndex&&lap.endIndex===fresh.endIndex);
   return old?{...old,points:fresh.points}:fresh;
  });
  // 周内の点も補間し直す。周の識別と保存情報は保つ。
  return {...session,points,laps,bestLapIndex:computed.bestLapIndex,theoreticalBestTime:computed.theoreticalBestTime};
 });
}
