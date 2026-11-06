import type {Session} from '../../types/telemetry';
import type {GFilterLevel} from '../../engine/physics';
import {applyGFilter} from '../../engine/physics';
import {getGFilterLevel} from '../../services/physics';

// 未公開の解析結果に使った設定。点列の寿命とともに解放し、正本や永続設定にはしない。
const levels=new WeakMap<Session['points'],GFilterLevel>();
export function noteParsedPhysics(points:Session['points'],level:GFilterLevel){levels.set(points,level);}
export function refreshParsedPhysics(sessions:Session[],level=getGFilterLevel()):Session[]{
 return sessions.map(session=>{
  const prior=levels.get(session.points);
  if(prior===undefined||prior===level)return session;
  const points=applyGFilter(session.points.map(point=>({...point})),level);
  levels.set(points,level);
  // 時刻・座標・距離は変えない。周の番号・非表示や保存情報もそのまま保つ。
  return {...session,points};
 });
}
