import {describe,expect,it} from 'vitest';
import {createEngineRuntime} from './EngineRuntime';
import {asSessionSec,getPlaybackPosition} from './playbackPosition';
import {parseLogBuffer} from './logLoader';
import {createVideoSyncManager} from './videoSyncManager';
import type {BinaryFile,RunRepository} from './ports';
import type {Lap,Session} from '../types/telemetry';
import type {RunItem} from './runRecords';
import {StorageChangedError} from './storageContext';

const deferred=<T>()=>{let resolve!:(x:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};};
const file=(name='clip.mp4'):BinaryFile=>({name,size:8,lastModified:0,arrayBuffer:async()=>new ArrayBuffer(8),slice:()=>({arrayBuffer:async()=>new ArrayBuffer(0)})});
function repository(revision=0){
 const text=new Map<string,string>();let fail=false;
 const store:RunRepository={storageRevision:revision,list:async()=>[],listAll:async()=>[],read:async()=>new Uint8Array(),readText:async path=>text.get(path)??null,readTextStrict:async path=>text.get(path)??null,writeText:async(path,value)=>{if(fail)throw Error('offline');text.set(path,value);},videoUrl:path=>'test:'+path,startDownload:async()=>{},fileStatus:async()=>({local:true,downloading:false}),supportsVideos:async()=>true};
 return {store,text,setFail:(next:boolean)=>{fail=next;}};
}
function runtime(repo=repository()){
 const tasks=new Map<number,()=>void>();let next=0;const preferences=new Map<string,string>();
 const instance=createEngineRuntime({media:{remoteFile:remote=>file(remote.name),metadata:async f=>({fileName:f.name,fileSize:f.size,creationTime:null,durationSec:30,timescale:1000}),gps:async()=>({videoStartUtcMs:[]}),open:()=>`test:${next++}`,release:()=>{},nowMs:()=>1000,random:()=>0.5},preferences:{read:key=>preferences.get(key)??null,write:(key,value)=>{if(value===null)preferences.delete(key);else preferences.set(key,value);}},scheduler:{schedule:task=>{const id=next++;tasks.set(id,task);return id;},cancel:id=>{tasks.delete(id as number);},defer:task=>{void Promise.resolve().then(task);}},repository:async()=>repo.store,courses:{prepare:async()=>{},find:async()=>null},remoteMetadata:async remote=>({fileName:remote.name,fileSize:remote.size,creationTime:null,durationSec:30,timescale:1000}),pins:{load:()=>[],save:()=>{}},runsChanged:()=>{}});
 return {...instance,tasks,repo};
}
function run(id='a'):Session{
 const lap:Lap={lapNumber:1,lapTime:30,startTime:10,endTime:40,startIndex:0,endIndex:0,distance:1,topSpeed:100,bottomSpeed:30,avgSpeed:60,sectors:[],points:[]};
 return {id,sessionName:id,fileName:'run.nmea',laps:[lap],points:[],date:'2026-01-01',circuitName:'Course',samplingRate:10,totalDistance:1,bestLapIndex:0,theoreticalBestTime:30,sectors:[],sourceFile:{folder:'course',file:'run.nmea',part:1,storageRevision:0,size:1,mtimeMs:1,courseHash:'same'}};
}
const item=():RunItem=>({folder:'course',file:'run.nmea',courseName:'Course',startMs:0,lapCount:1,laps:[],best:30,videos:[],synced:false,pending:false,folderVideos:[],entry:null,storageRevision:0});

describe('host-independent engine ownership',()=>{
 it('publishes the Car, source clock and stop state together, and isolates another engine',()=>{
  const a=runtime(),b=runtime();let calls=0;
  a.session.setIsPlaying(true);a.session.subscribe(()=>{calls++;const snapshot=a.session.getSnapshot();expect(snapshot.analysis.selectedCars[0].sessionId).toBe(snapshot.playhead.source);expect(snapshot.isPlaying).toBe(false);});
  a.session.assign([run()], 'a',1,0);expect(calls).toBe(1);
  expect(a.session.getSnapshot().playhead.sessionSec).toBe(10);expect(b.session.analysis.getSessions()).toEqual([]);
  expect(getPlaybackPosition(asSessionSec(11),{...run().laps[0],points:[{time:0,distance:0},{time:30,distance:1}] as any}).lapSec).toBe(1);
 });
 it('rejects a missing lap before the save owner can be registered',()=>{
  const a=runtime();let calls=0;
  expect(()=>a.session.assign([run()], 'a',99,0,[],()=>{calls++;return [run()];})).toThrow();
  expect(calls).toBe(0);expect(a.session.analysis.getSessions()).toEqual([]);
 });
 it('keeps channels and format readiness separate for each host',async()=>{
  const a=runtime(),b=runtime();await a.formats.loadCsvFormats();expect(a.formats.csvFormatsReady()).toBe(true);expect(b.formats.csvFormatsReady()).toBe(false);
  a.channels.setCustomChannels([{key:'water',label:'A',get:()=>88}]);b.channels.setCustomChannels([{key:'water',label:'B',get:()=>22}]);
  expect(a.channels.channelDef('custom:water').label[0]).toBe('A');expect(b.channels.channelDef('custom:water').get({} as any)).toBe(22);
 });
 it('does not inherit another host’s conflict inventory for the same folder',async()=>{
  const a=runtime(),b=runtime();a.runs.noteRunsConflictCopies('course',['course/runs 2.json']);
  a.repo.text.set('course/runs 2.json',JSON.stringify({version:2,runs:{foreign:{name:'A',updatedAt:'2026-01-01'}}}));
  b.repo.text.set('course/runs 2.json',JSON.stringify({version:2,runs:{foreign:{name:'must not read',updatedAt:'2026-01-01'}}}));
  expect((await a.runs.readRunsFile(a.repo.store,'course')).runs.foreign.name).toBe('A');
  expect((await b.runs.readRunsFile(b.repo.store,'course')).runs.foreign).toBeUndefined();
  a.storage.invalidateStorageRevision();expect((await a.runs.readRunsFile({...a.repo.store,storageRevision:1},'course')).runs.foreign).toBeUndefined();
 });
 it('allows a second host to save while the first host’s IO is stalled',async()=>{
  const a=runtime(),b=runtime(),gate=deferred<string|null>();
  a.repo.store.readTextStrict=()=>gate.promise;
  const pending=a.runs.updateRun(a.repo.store,'course','run.nmea',()=>({name:'A'}));
  await b.runs.updateRun(b.repo.store,'course','run.nmea',()=>({name:'B'}));
  expect(JSON.parse(b.repo.text.get('course/runs.json')!).runs.run.name).toBe('B');
  gate.resolve(null);await pending;
 });
 it('serializes changes to different rows of the same file without losing a row',async()=>{
  const a=runtime();await Promise.all([a.runs.updateRun(a.repo.store,'course','a.nmea',()=>({name:'A'})),a.runs.updateRun(a.repo.store,'course','b.nmea',()=>({name:'B'}))]);
  const saved=JSON.parse(a.repo.text.get('course/runs.json')!);expect(saved.runs.a.name).toBe('A');expect(saved.runs.b.name).toBe('B');
 });
 it('retains failed metadata and blocks folder selection until retry succeeds',async()=>{
  const a=runtime(),s=run(),row=item();a.session.assign([s],s.id,1,0);a.controller.registerRunSessions(a.repo.store,row,[s],a.session.analysis.getSessions);
  a.repo.setFail(true);await expect(a.controller.setRunMeta(a.repo.store,row,{note:'keep'})).rejects.toThrow('offline');
  a.storage.subscribeBeforeStorageSelection(a.controller.flushOpenRunsStrict);let selected=false;
  await expect(a.storage.trackStorageSelection(()=>{selected=true;return true;})).rejects.toThrow('offline');expect(selected).toBe(false);
  a.repo.setFail(false);await a.storage.trackStorageSelection(()=>{selected=true;return true;});
  expect(selected).toBe(true);expect(JSON.parse(a.repo.text.get('course/runs.json')!).runs.run.note).toBe('keep');
 });
 it('returns a delayed response from the old storage as cancellation, not as empty data',async()=>{
  const a=runtime(),gate=deferred<string|null>();a.repo.store.readTextStrict=()=>gate.promise;
  const old=a.storage.revisionBoundStore(a.repo.store),pending=old.readTextStrict('course/runs.json');
  await a.storage.trackStorageSelection(()=>true);gate.resolve('stale');await expect(pending).rejects.toBeInstanceOf(StorageChangedError);
 });
 it('does not publish a video or allocate a playback handle after cancellation during metadata IO',async()=>{
  const gate=deferred<any>();let current=true,opened=0;
  const media=createVideoSyncManager<BinaryFile>({remoteFile:remote=>file(remote.name),metadata:()=>gate.promise,gps:async()=>({videoStartUtcMs:[]}),open:()=>{opened++;return 'handle';},release:()=>{},nowMs:()=>1,random:()=>0.5});
  const pending=media.addVideoFiles([file()],[],false,()=>current);current=false;
  gate.resolve({fileName:'clip.mp4',fileSize:8,creationTime:null,durationSec:30,timescale:1000});await pending;
  expect(media.getTracks()).toEqual([]);expect(opened).toBe(0);
 });
 it('uses caller-supplied CSV definitions rather than another host’s definitions',async()=>{
  const buffer=new TextEncoder().encode('t,lat,lon,spd\n0,35,140,30\n1,35.001,140.001,40\n2,35.002,140.002,50\n').buffer;
  const format:any={version:1,id:'custom',name:'input',kind:'log',filePattern:'*.csv',header:['t','lat','lon','spd'],headerRow:0,delimiter:',',time:{column:'t',as:'elapsedSec'},columns:{lat:{target:'lat'},lon:{target:'lon'},spd:{target:'speed',speedUnit:'km/h'}}};
  const result=await parseLogBuffer('input.csv',buffer,undefined,[format]);expect(result.parts[0].points[1].speed).toBe(40);
 });
});
