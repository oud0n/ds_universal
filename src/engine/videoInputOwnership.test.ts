import {expect,it} from 'vitest';
import {createEngineSession} from './EngineSession';
import {createVideoSyncManager} from './videoSyncManager';
import {isLoadedLocalVideo,type VideoTrack} from './videoTypes';
import {NO_CLOCK} from './mediaClock';
import type {BinaryFile} from './ports';
import type {Session} from '../types/telemetry';
const file=(modified=1000):BinaryFile=>({name:'GX010017.MP4',size:8,lastModified:modified,arrayBuffer:async()=>new ArrayBuffer(8),slice:()=>({arrayBuffer:async()=>new ArrayBuffer(0)})});
const session=():Session=>({id:'source',points:[],laps:[],fileName:'run',sessionName:'run',date:'',circuitName:'',samplingRate:10,totalDistance:0,bestLapIndex:0,theoreticalBestTime:0,sectors:[]});
it('deduplicates local recordings by known source attributes and never substitutes remote media',()=>{
 const original=file(),track:VideoTrack={id:'video',file:original,fileName:original.name,fileSize:original.size,objectUrl:'owned',durationSec:1,rawRecordedAt:new Date(1000),recordedAtJst:null,clock:NO_CLOCK,matchedSessionId:null,videoTimezone:'UTC',gpsTimezone:'UTC',isAutoMatched:false};
 expect(isLoadedLocalVideo(track,file(),{creationTime:new Date(1000)})).toBe(true);
 expect(isLoadedLocalVideo(track,file(2000),{creationTime:new Date(1000)})).toBe(false);
 expect(isLoadedLocalVideo(track,file(),{creationTime:new Date(2000)})).toBe(false);
 expect(isLoadedLocalVideo({...track,file:undefined,remote:{path:'elsewhere/GX010017.MP4',name:original.name,size:8,lastModified:1000,url:'borrowed'}},file(),{creationTime:new Date(1000)})).toBe(false);
});
it('retires superseded media imports and rejects later target edits, removal and read-period changes',async()=>{
 const engine=createEngineSession(),s=session();engine.analysis.update(()=>({sessions:[s],selectedCars:[]}));
 const first=engine.beginMediaImport();engine.beginMediaImport();expect(first.isCurrent()).toBe(false);
 const current=engine.beginMediaImport(),target=current.forSession(s);engine.markClockEdited(s.id);expect(target()).toBe(false);
 const removing=engine.beginMediaImport().forSession(s);engine.analysis.update(()=>({sessions:[],selectedCars:[]}));expect(removing()).toBe(false);
 const reading=engine.beginMediaImport();await engine.storage.trackStorageSelection(()=>null);expect(reading.isCurrent()).toBe(false);
 const manual=engine.beginMediaImport();engine.operations.manualSelection.current++;expect(manual.isCurrent()).toBe(false);
 const closed=engine.beginMediaImport();await engine.close();expect(closed.isCurrent()).toBe(false);
});
it('does not acquire or publish delayed media for a GPS log closed during metadata IO',async()=>{
 const engine=createEngineSession(),s=session();engine.analysis.update(()=>({sessions:[s],selectedCars:[]}));
 let finish!:(x:any)=>void,opened=0;const held=new Promise<any>(r=>finish=r);
 const media=createVideoSyncManager<BinaryFile>({remoteFile:()=>file(),metadata:()=>held,gps:async()=>({videoStartUtcMs:[]}),open:()=>{opened++;return 'owned';},release:()=>{},nowMs:()=>1,random:()=>0.5});
 const target=engine.beginMediaImport().forSession(s),loading=media.addVideoFiles([file()],engine.analysis.getSessions(),false,target);
 engine.analysis.update(()=>({sessions:[],selectedCars:[]}));finish({fileName:'GX010017.MP4',fileSize:8,creationTime:null,durationSec:1,timescale:1000});await loading;
 expect(opened).toBe(0);expect(media.getTracks()).toEqual([]);
});
