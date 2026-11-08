import {getGFilterLevel} from '../../services/physics';
/** 設定を解析開始時に一度取得し、最初の物理計算へ渡す。 */
export function withLogPreferences<T extends (...args:any[])=>any>(parse:T,levelIndex:number):T {
 return ((...args:Parameters<T>)=>{
  const input:unknown[]=[...args];
  while(input.length<levelIndex)input.push(undefined);
  if(input[levelIndex]===undefined)input[levelIndex]=getGFilterLevel();
  return parse(...input);
 }) as T;
}
