import {applyGFilter,getGFilterLevel} from '../../services/physics';
import type {TelemetryPoint} from '../../types/telemetry';
/** 形式の解析と、端末で選んだ表示用のGフィルターを分ける。 */
export function withLogPreferences<T extends (...args: any[]) => any>(parse:T):T {
 return ((...args:Parameters<T>)=>{
  const level=getGFilterLevel();
  const filter=(value:any):any=>{
   if(Array.isArray(value)) value.forEach(filter);
   else if(value && typeof value==='object') {
    if(Array.isArray(value.points)) applyGFilter(value.points as TelemetryPoint[],level);
    if(Array.isArray(value.parts)) value.parts.forEach(filter);
   }
   return value;
  };
  const value=parse(...args);
  return value && typeof value.then==='function'?value.then(filter):filter(value);
 }) as T;
}
