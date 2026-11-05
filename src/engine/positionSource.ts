import type {PreferencesPort} from './ports';
export type PositionSource='digspice'|'racebox'|'drogger'|'phone';
export function createPositionSource(preferences:PreferencesPort){
 const key='lapTimer.source';
 let current:PositionSource|null=null;
 try{const v=preferences.read(key);if(v==='digspice'||v==='racebox'||v==='drogger'||v==='phone')current=v;}catch{/* 既定の出どころを使う。 */}
 const listeners=new Set<()=>void>();
 return {getPositionSource:()=>current,setPositionSource(source:PositionSource){if(source===current)return;current=source;try{preferences.write(key,source);}catch{/* 今の選択は保持する。 */}for(const listener of listeners)listener();},subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
}
