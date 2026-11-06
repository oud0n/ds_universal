import type {VideoSyncManager} from './videoSyncManager';
import type {SyncPinStore} from './syncPinStore';
import type {Session,SelectedCarSlot} from '../types/telemetry';
import type {RunItem} from './runRecords';
import {assignLap,selectAvailableCars,type AnalysisState} from './lapAssignmentState';
import {asSessionSec,type SessionSec} from './playbackPosition';
import {createStorageContext,type StorageContext} from './storageContext';
import {EngineError} from './errors';

export interface Playhead {source:string|null;sessionSec:SessionSec}
export interface EngineSnapshot {analysis:AnalysisState;playhead:Playhead;isPlaying:boolean;playbackSpeed:number;closed:boolean}
type Change<T>=T|((current:T)=>T);
export interface EngineSessionOptions {storage?:StorageContext;flush?:()=>Promise<void>;onClosing?:()=>void;onClose?:()=>void;onClockChanged?:()=>void}

/** 一つの正本。点列・Carの採用と基準時計の更新を同じ通知で公開する。 */
export function createEngineSession(options:EngineSessionOptions={}){
 let snapshot:EngineSnapshot={analysis:{sessions:[],selectedCars:[]},playhead:{source:null,sessionSec:asSessionSec(0)},isPlaying:false,playbackSpeed:1,closed:false};
 let closing:Promise<void>|null=null;
 const listeners=new Set<()=>void>();
 let clockRevision=0;
 const clockVersions=new Map<string,number>(),clockRequests=new Map<string,number>();
 const markClockEdited=(id:string)=>{active();clockRevision++;clockVersions.set(id,(clockVersions.get(id)??0)+1);};
 const storage=options.storage??createStorageContext();
 const operations={
  mediaImports:{current:0},projectImports:{current:0},pickerActive:{current:false},slotRequests:{current:[0,0,0,0]},selectionEpoch:{current:0},manualSelection:{current:0},
  pendingParses:{current:new Map<string,{readers:number;parsed?:Promise<Session[]>}>()},savedOpening:{current:false},runOpening:{current:false},
  runSessions:{current:new Map<string,string[]>()},runItems:{current:new Map<string,RunItem>()},attachedRun:{current:null as string|null},openedRun:{current:null as string|null},runDownloadToken:{current:0}
 };
 const active=()=>{if(snapshot.closed||closing)throw new EngineError('engine.closed',{ja:'エンジンは終了しました。',en:'The engine is closed.'});};
 const publish=(next:EngineSnapshot)=>{if(next===snapshot)return;snapshot=next;for(const listener of listeners)listener();};
 const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
 const baseOf=(state:AnalysisState)=>[...state.selectedCars].sort((a,b)=>a.slot-b.slot).find(car=>state.sessions.some(s=>s.id===car.sessionId&&s.laps.some(l=>l.lapNumber===car.lapNumber)));
 const adopt=(state:AnalysisState,restart=false)=>{
  active();
  const valid=state.selectedCars.every((car,i)=>Number.isInteger(car.slot)&&car.slot>=0&&car.slot<=3&&(i===0||state.selectedCars[i-1].slot<car.slot)&&state.sessions.some(s=>s.id===car.sessionId&&s.laps.some(l=>l.lapNumber===car.lapNumber)));
  const next=valid?state:selectAvailableCars(state,state.selectedCars),before=baseOf(snapshot.analysis),base=baseOf(next);
  for(const prior of snapshot.analysis.sessions){const live=next.sessions.find(s=>s.id===prior.id);if(live&&(live.clockOffsetSec??0)!==(prior.clockOffsetSec??0))clockRevision++;if(!live||live.points!==prior.points||(live.clockOffsetSec??0)!==(prior.clockOffsetSec??0))clockVersions.set(prior.id,(clockVersions.get(prior.id)??0)+1);}
  const changed=before?.sessionId!==base?.sessionId||before?.lapNumber!==base?.lapNumber;
  const reset=restart||changed;
  const lap=base&&next.sessions.find(s=>s.id===base.sessionId)?.laps.find(l=>l.lapNumber===base.lapNumber);
  publish({...snapshot,analysis:next,...(reset?{playhead:{source:base?.sessionId??null,sessionSec:asSessionSec(lap?.startTime??0)},isPlaying:false}:{})});
  return next;
 };
 const analysis={getSnapshot:()=>snapshot.analysis,getSessions:()=>snapshot.analysis.sessions,subscribe,update(change:(state:AnalysisState)=>AnalysisState){active();const next=change(snapshot.analysis);return next===snapshot.analysis?next:adopt(next);}};
 const setPlayhead=(change:Change<Playhead>)=>{
  if(snapshot.closed||closing)return;
  const next=typeof change==='function'?change(snapshot.playhead):change;
  if(!Number.isFinite(next.sessionSec)||next.source!==(baseOf(snapshot.analysis)?.sessionId??null))return;
  if(next.source!==snapshot.playhead.source||next.sessionSec!==snapshot.playhead.sessionSec)publish({...snapshot,playhead:next});
 };
 const cancelPending=()=>{operations.mediaImports.current++;operations.projectImports.current++;operations.pickerActive.current=false;operations.selectionEpoch.current++;operations.runDownloadToken.current++;};
 const resetStorage=()=>{cancelPending();operations.runSessions.current.clear();operations.runItems.current.clear();operations.attachedRun.current=null;operations.openedRun.current=null;};
 return {
  beginMediaImport(){
   active();const ticket=++operations.mediaImports.current,root=storage.getStorageRevision(),reads=storage.getStorageReadRevision(),selection=operations.selectionEpoch.current,manual=operations.manualSelection.current;
   // 同じ入力内で保存ログの選択を挟む場合の外側の寿命。公開前には選択の世代も検査する。
   const isInputCurrent=()=>!snapshot.closed&&!closing&&!storage.isStorageTransitioning()&&ticket===operations.mediaImports.current&&root===storage.getStorageRevision()&&reads===storage.getStorageReadRevision()&&manual===operations.manualSelection.current;
   const isCurrent=()=>isInputCurrent()&&selection===operations.selectionEpoch.current;
   return {isCurrent,isInputCurrent,forSession(target:Session){const points=target.points,offset=target.clockOffsetSec??0,version=clockVersions.get(target.id)??0;return()=>{const live=snapshot.analysis.sessions.find(s=>s.id===target.id);return isCurrent()&&live?.points===points&&(live?.clockOffsetSec??0)===offset&&(clockVersions.get(target.id)??0)===version;};}};
  },
  beginProjectImport(){
   active();const ticket=++operations.projectImports.current,root=storage.getStorageRevision(),reads=storage.getStorageReadRevision(),clocks=clockRevision;
   return()=>!snapshot.closed&&!closing&&!storage.isStorageTransitioning()&&ticket===operations.projectImports.current&&clocks===clockRevision&&root===storage.getStorageRevision()&&reads===storage.getStorageReadRevision();
  },
  applySyncProject(text:string,media:Pick<VideoSyncManager,'importProjectJson'>,pins:Pick<SyncPinStore,'mergeImported'>){
   active();if(storage.isStorageTransitioning())throw new EngineError('storage.busy',{ja:'保管場所を選択中です。',en:'Storage selection is in progress.'});
   const result=media.importProjectJson(text,snapshot.analysis.sessions);
   for(const [id,sec]of result.clockOffsets){
    if(!snapshot.analysis.sessions.some(s=>s.id===id))continue;
    markClockEdited(id);analysis.update(state=>({...state,sessions:state.sessions.map(s=>s.id===id?{...s,clockOffsetSec:sec}:s)}));
   }
   if(result.clockOffsets.length)options.onClockChanged?.();
   pins.mergeImported(result.data.circuitName||'default',result.pins);
   return result.data;
  },
  markClockEdited,
  beginClockEstimate(id:string){
   active();const target=snapshot.analysis.sessions.find(s=>s.id===id);
   const ticket=(clockRequests.get(id)??0)+1;clockRequests.set(id,ticket);
   const version=clockVersions.get(id)??0,root=storage.getStorageRevision(),reads=storage.getStorageReadRevision(),selection=operations.selectionEpoch.current;
   const targetOffset=target?.clockOffsetSec??0;
   const current=()=>{const live=snapshot.analysis.sessions.find(s=>s.id===id);return !snapshot.closed&&!closing&&!storage.isStorageTransitioning()&&root===storage.getStorageRevision()&&reads===storage.getStorageReadRevision()&&selection===operations.selectionEpoch.current&&clockRequests.get(id)===ticket&&!!target&&live?.points===target.points&&(live?.clockOffsetSec??0)===targetOffset&&(clockVersions.get(id)??0)===version;};
   return {isCurrent:current,forReference(reference:Session){const points=reference.points,offset=reference.clockOffsetSec??0,version=clockVersions.get(reference.id)??0;return()=>{const live=snapshot.analysis.sessions.find(s=>s.id===reference.id);return current()&&live?.points===points&&(live?.clockOffsetSec??0)===offset&&(clockVersions.get(reference.id)??0)===version;};}};
  },
  storage,operations,analysis,getSnapshot:()=>snapshot,subscribe,setPlayhead,cancelPending,resetStorage,
  replaceAnalysis:(state:AnalysisState,restart=true)=>adopt(state,restart),
  selectCarsAtLapStart:(cars:SelectedCarSlot[])=>adopt(selectAvailableCars(snapshot.analysis,cars),true),
  selectLap(id:string,lap:number,slot:number){active();const next=assignLap(snapshot.analysis,[],id,lap,slot,false);return adopt(next,baseOf(next)?.slot===slot);},
  setIsPlaying(change:Change<boolean>){if(snapshot.closed||closing)return;const next=typeof change==='function'?change(snapshot.isPlaying):change;if(next!==snapshot.isPlaying)publish({...snapshot,isPlaying:next});},
  setPlaybackSpeed(change:Change<number>){if(snapshot.closed||closing)return;const next=typeof change==='function'?change(snapshot.playbackSpeed):change;if(Number.isFinite(next)&&next>0&&next!==snapshot.playbackSpeed)publish({...snapshot,playbackSpeed:next});},
  assign(incoming:Session[],id:string,lap:number,slot:number,retained:readonly string[]=[],register?:(incoming:Session[])=>Session[]){
   active();
   const proposed=assignLap(snapshot.analysis,incoming,id,lap,slot,false),base=proposed.sessions.find(s=>s.id===proposed.selectedCars[0]?.sessionId);
   const keep=base&&!base.sourceFile?retained:[];
   assignLap(snapshot.analysis,incoming,id,lap,slot,true,keep);
   const next=assignLap(snapshot.analysis,register?.(incoming)??incoming,id,lap,slot,true,keep);
   return adopt(next,baseOf(next)?.slot===slot);
  },
  close():Promise<void>{
   if(snapshot.closed)return Promise.resolve();if(closing)return closing;
   cancelPending();options.onClosing?.();
   closing=(async()=>{await options.flush?.();options.onClose?.();resetStorage();operations.pendingParses.current.clear();clockRequests.clear();clockVersions.clear();publish({...snapshot,analysis:{sessions:[],selectedCars:[]},playhead:{source:null,sessionSec:asSessionSec(0)},isPlaying:false,closed:true});listeners.clear();})().finally(()=>{closing=null;});
   return closing;
  }
 };
}
export type EngineSession=ReturnType<typeof createEngineSession>;
export type InputRequest=ReturnType<EngineSession['beginMediaImport']>;

/** Webと他のホストに共通の保存先切替え契約。解除はホストの寿命に合わせる。 */
export function bindStorageLifecycle(session:EngineSession,controller:{flushOpenRunsStrict():Promise<void>;abandonOpenRuns():void}){
 const {storage}=session;let revision=storage.getStorageRevision();
 const before=storage.subscribeBeforeStorageSelection(()=>controller.flushOpenRunsStrict());
 const changed=storage.subscribeStorageRevision(()=>{const next=storage.getStorageRevision();if(next===revision)return;revision=next;session.resetStorage();controller.abandonOpenRuns();});
 return()=>{before();changed();};
}
