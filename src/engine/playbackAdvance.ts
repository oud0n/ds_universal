import {asSessionSec,type SessionSec} from './playbackPosition';
/** ホストのフレーム時刻と任意の音声時計を、同じ再生範囲へ反映する。 */
export function advancePlayback(input:{current:SessionSec;deltaSec:number;start:number;end:number;loop:boolean;master:number|null;movedOutside:boolean}){
 const {current,start,end}=input;
 let next=current+Math.max(0,input.deltaSec);
 if(input.master!==null&&Number.isFinite(input.master)&&!input.movedOutside&&Math.abs(input.master-next)<1)next=Math.max(current,input.master);
 const reached=next>=end;
 return {sessionSec:asSessionSec(reached?(input.loop?start:end):next),looped:reached&&input.loop,stopped:reached&&!input.loop};
}
/** 時間比較では、完走済みの枠を終点に留め、時計の元から外す。 */
export function comparisonTime(start:number,end:number,elapsed:number){const duration=Math.max(0,end-start);return {sessionSec:start+Math.max(0,Math.min(duration,elapsed)),hold:elapsed>=duration};}
