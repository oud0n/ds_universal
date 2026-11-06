import {describe,expect,it} from 'vitest';
import {createEngineRuntime,type EngineRuntimePorts} from './EngineRuntime';
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
function runtime(repo=repository(),overrides:Partial<EngineRuntimePorts<BinaryFile>>={}){
 const tasks=new Map<number,()=>void>();let next=0;const preferences=new Map<string,string>();
 const instance=createEngineRuntime({media:{remoteFile:remote=>file(remote.name),metadata:async f=>({fileName:f.name,fileSize:f.size,creationTime:null,durationSec:30,timescale:1000}),gps:async()=>({videoStartUtcMs:[]}),open:()=>`test:${next++}`,release:()=>{},nowMs:()=>1000,random:()=>0.5},preferences:{read:key=>preferences.get(key)??null,write:(key,value)=>{if(value===null)preferences.delete(key);else preferences.set(key,value);}},scheduler:{schedule:task=>{const id=next++;tasks.set(id,task);return id;},cancel:id=>{tasks.delete(id as number);},defer:task=>{void Promise.resolve().then(task);}},repository:async()=>repo.store,courses:{prepare:async()=>{},find:async()=>null},remoteMetadata:async remote=>({fileName:remote.name,fileSize:remote.size,creationTime:null,durationSec:30,timescale:1000}),pins:{load:()=>[],save:()=>{}},runsChanged:()=>{},...overrides});
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
  let selected=false;
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

describe('adversarial engine boundary regressions',()=>{
 it.each([true,false])('serializes delete and save in both orders (delete first=%s)',async(deleteFirst)=>{
  const a=runtime(),initial=JSON.stringify({version:2,runs:{a:{name:'A',updatedAt:''},b:{name:'B',updatedAt:''}}});a.repo.text.set('course/runs.json',initial);
  const writing=deferred<void>(),release=deferred<void>();let writes=0,reads=0;
  const write=a.repo.store.writeText,read=a.repo.store.readTextStrict;
  a.repo.store.readTextStrict=async path=>{reads++;return read(path);};
  a.repo.store.writeText=async(path,text)=>{if(++writes===1){writing.resolve();await release.promise;}await write(path,text);};
  const remove=()=>a.runs.removeRunRow(a.repo.store,'course','a.nmea');
  const update=()=>a.runs.updateRun(a.repo.store,'course','b.nmea',prev=>({...prev,name:'B2'}));
  const first=deleteFirst?remove():update();await writing.promise;
  const second=deleteFirst?update():remove();await Promise.resolve();await Promise.resolve();expect(reads).toBe(1);
  release.resolve();await Promise.all([first,second]);
  const saved=JSON.parse(a.repo.text.get('course/runs.json')!);expect(saved.runs.a).toBeUndefined();expect(saved.runs.b.name).toBe('B2');
 });
 it('blocks both mutation paths if a known conflict copy is unreadable or malformed',async()=>{
  const a=runtime(),initial=JSON.stringify({version:2,runs:{run:{name:'base',updatedAt:''}}});a.repo.text.set('course/runs.json',initial);a.runs.noteRunsConflictCopies('course',['course/runs 2.json']);
  const read=a.repo.store.readTextStrict;
  a.repo.store.readTextStrict=async path=>{if(path.endsWith('runs 2.json'))throw Error('unavailable');return read(path);};
  await expect(a.runs.updateRun(a.repo.store,'course','run.nmea',prev=>({...prev,note:'new'}))).rejects.toThrow('unavailable');
  await expect(a.runs.removeRunRow(a.repo.store,'course','run.nmea')).rejects.toThrow('unavailable');expect(a.repo.text.get('course/runs.json')).toBe(initial);
  a.repo.store.readTextStrict=read;a.repo.text.set('course/runs 2.json','broken');
  await expect(a.runs.updateRun(a.repo.store,'course','run.nmea',prev=>({...prev,note:'new'}))).rejects.toThrow();
  a.repo.text.set('course/runs 2.json',JSON.stringify({version:2,runs:{run:{name:'remote',updatedAt:'2026-01-01'}}}));
  await a.runs.updateRun(a.repo.store,'course','run.nmea',prev=>({...prev,note:'new'}));
  expect(JSON.parse(a.repo.text.get('course/runs.json')!).runs.run.name).toBe('remote');
 });
 it('strictly retries unopened metadata before permitting storage selection',async()=>{
  const a=runtime(),row=item();a.repo.setFail(true);
  await expect(a.controller.setRunMeta(a.repo.store,row,{note:'not open'})).rejects.toThrow('offline');
  let picks=0;await expect(a.storage.trackStorageSelection(()=>{picks++;return true;})).rejects.toThrow('offline');expect(picks).toBe(0);
  a.repo.setFail(false);await a.storage.trackStorageSelection(()=>{picks++;return true;});
  expect(JSON.parse(a.repo.text.get('course/runs.json')!).runs.run.note).toBe('not open');expect(picks).toBe(1);
 });
 it('stops and clears the source in the same snapshot when the final Car is removed',()=>{
  const a=runtime();a.session.assign([run()], 'a',1,0);a.session.setIsPlaying(true);
  const snapshots:any[]=[];a.session.subscribe(()=>snapshots.push(a.session.getSnapshot()));a.session.selectCarsAtLapStart([]);
  expect(snapshots).toHaveLength(1);expect(snapshots[0].playhead).toEqual({source:null,sessionSec:0});expect(snapshots[0].isPlaying).toBe(false);
 });
 it('normal selection and analysis replacement publish a consistent clock once',()=>{
  const a=runtime(),b=run('b');b.sourceFile={...b.sourceFile!,file:'b.nmea'};
  a.session.analysis.update(()=>({sessions:[run(),b],selectedCars:[]}));a.session.selectLap('a',1,0);a.session.setIsPlaying(true);
  let calls=0;const off=a.session.subscribe(()=>{calls++;const state=a.session.getSnapshot();expect(state.playhead.source).toBe(state.analysis.selectedCars[0].sessionId);expect(state.isPlaying).toBe(false);});
  a.session.selectLap('b',1,0);expect(calls).toBe(1);off();
 });
 it('preserves class receivers for pin persistence and repository reads',async()=>{
  class Pins {private values=new Map<string,any[]>();load(key:string){return this.values.get(key)??[];}save(key:string,value:any[]){this.values.set(key,value);}}
  const pins=new Pins(),a=runtime(undefined,{pins});a.pins.setPins('course',[]);expect(a.pins.getPins('course')).toEqual([]);
  class Repository implements RunRepository {
   storageRevision=0;#data=new Map<string,string>();
   async list(){return this.listAll();}async listAll(){return [{path:'course/run.bon4',size:2,mtimeMs:1,local:true}];}
   async read(){return new Uint8Array(2);}async readText(path:string){return this.#data.get(path)??null;}async readTextStrict(path:string){return this.readText(path);}
   async writeText(path:string,text:string){this.#data.set(path,text);}videoUrl(path:string){return path;}async startDownload(){}async fileStatus(){return {local:true,downloading:false};}async supportsVideos(){return true;}
  }
  const store=new Repository(),host=runtime(undefined,{courses:{prepare:async()=>{},find:async()=>({name:'course',controlLine:{name:'test',latA:35,lonA:140,latB:35.01,lonB:140.01},sectors:[]})}});
  expect((await host.controller.listRuns(store)).length).toBe(1);
 });
 it('releases only locally acquired handles and rolls back all staged handles on failure',async()=>{
  let next=0,failAt=2,before=0;const leases=new Set<string>();
  const media=createVideoSyncManager<BinaryFile>({remoteFile:remote=>file(remote.name),metadata:async f=>({fileName:f.name,fileSize:f.size,creationTime:null,durationSec:30,timescale:1}),gps:async()=>({videoStartUtcMs:[]}),open:()=>{if(++next===failAt)throw Error('open failed');const handle=String(next);leases.add(handle);return handle;},release:handle=>{expect(leases.delete(handle)).toBe(true);},nowMs:()=>0,random:()=>0.5});
  await expect(media.addVideoFiles([file('a.mp4'),file('b.mp4')],[],false,()=>true,()=>{before++;})).rejects.toThrow('open failed');expect(leases.size).toBe(0);expect(media.getTracks()).toEqual([]);expect(before).toBe(0);
  failAt=-1;await media.addVideoFiles([{name:'remote.mp4',size:8,lastModified:0,url:'repository:shared',path:'course/remote.mp4'}],[],false);
  media.removeTrack(media.getTracks()[0].id);expect(leases.size).toBe(0);
 });
 it('keeps an existing proxy usable when acquiring its replacement fails',async()=>{
  let fail=false,next=0;const leases=new Set<string>();
  const media=createVideoSyncManager<BinaryFile>({remoteFile:remote=>file(remote.name),metadata:async f=>({fileName:f.name,fileSize:f.size,creationTime:null,durationSec:30,timescale:1}),gps:async()=>({videoStartUtcMs:[]}),open:()=>{if(fail)throw Error('open failed');const handle=String(++next);leases.add(handle);return handle;},release:handle=>{expect(leases.delete(handle)).toBe(true);},nowMs:()=>0,random:()=>0.5});
  await media.addVideoFiles([file('GX010001.MP4'),file('GL010001.LRV')],[],false);const old=media.getTracks()[0].proxyUrl;
  fail=true;await expect(media.addVideoFiles([file('GL010001.LRV')],[],false)).rejects.toThrow('open failed');expect(media.getTracks()[0].proxyUrl).toBe(old);expect(leases.has(old!)).toBe(true);
  fail=false;media.dispose();expect(leases.size).toBe(0);
 });
 it('cannot publish a delayed media result or accept new analysis after close',async()=>{
  const gate=deferred<any>();let opens=0;
  const a=runtime(undefined,{media:{remoteFile:remote=>file(remote.name),metadata:()=>gate.promise,gps:async()=>({videoStartUtcMs:[]}),open:()=>{opens++;return 'lease';},release:()=>{},nowMs:()=>0,random:()=>0.5}});
  const pending=a.media.addVideoFiles([file()],[],false);await a.close();gate.resolve({fileName:'clip.mp4',fileSize:8,creationTime:null,durationSec:30,timescale:1});await pending;
  expect(opens).toBe(0);expect(a.media.getTracks()).toEqual([]);expect(a.session.getSnapshot().closed).toBe(true);expect(()=>a.session.assign([run()],'a',1,0)).toThrow('closed');
 });
 it('round trips two same-name videos and their same-name pins by project identity',async()=>{
  const a=runtime(),b=runtime(),s=run();s.points=[{timestamp:'2026-01-01T00:00:00Z',time:0},{timestamp:'2026-01-01T00:01:00Z',time:60}] as any;
  const remote=(path:string)=>({name:'GX010001.MP4',size:8,lastModified:0,url:'repository:'+path,path});
  await a.media.addVideoFiles([remote('A/GX010001.MP4'),remote('B/GX010001.MP4')],[s],false);
  const [first,second]=a.media.getTracks();a.media.setOffsetIn(first.id,s,3);a.media.setOffsetIn(second.id,s,9);
  const pins=[first,second].map((track,i)=>({id:'p'+i,name:'mark',sessionTimeSec:12,videoTimeSec:i+1,calculatedOffsetSec:11-i,trackId:track.id,sessionId:s.id,createdAt:'2026-01-01'}));
  const json=a.media.exportProjectJson([s],'course',pins),restored=b.media.importProjectJson(json,[s]);b.pins.mergeImported('course',restored.pins);
  expect(b.media.getTracks().map(t=>t.clock.offsetSec)).toEqual([3,9]);expect(new Set(b.pins.getPins('course').map(p=>p.trackId)).size).toBe(2);
  b.pins.mergeImported('course',b.media.importProjectJson(json,[s]).pins);expect(b.pins.getPins('course')).toHaveLength(2);
  const live=a.media.importProjectJson(json,[s]);expect(a.media.getTracks().map(t=>t.clock.offsetSec)).toEqual([3,9]);expect(live.pins.map(p=>p.trackId)).toEqual([first.id,second.id]);
  await b.media.addVideoFiles([remote('A/GX010001.MP4'),remote('B/GX010001.MP4')],[s],false);expect(b.media.getTracks()).toHaveLength(2);
 });
});

describe('failed IO and concurrent configuration',()=>{
 it('keeps a successful new definition when an earlier deletion finishes later',async()=>{
  const a=runtime();await a.formats.loadCsvFormats();
  const fmt:any={version:1,id:'user:A',name:'A',kind:'log',filePattern:'*.csv',header:[],headerRow:0,delimiter:',',time:{column:'t',as:'elapsedSec'},columns:{lat:{target:'lat'},lon:{target:'lon'}}};
  await a.formats.saveCsvFormat(fmt);
  const started=deferred<void>(),release=deferred<void>(),write=a.repo.store.writeText;
  a.repo.store.writeText=async(path,text)=>{if(path==='formats/A.csvformat.json'&&text.includes('deleted')){started.resolve();await release.promise;}await write(path,text);};
  const deleting=a.formats.deleteCsvFormat('user:A');await started.promise;
  await a.formats.saveCsvFormat({...fmt,id:'user:B',name:'B'});release.resolve();await deleting;
  expect(a.formats.currentCsvFormats().map(f=>f.name)).toEqual(['B']);
 });
 it('includes a failed overlay layout in strict retry and permits retry of the same value',async()=>{
  const a=runtime(),s=run(),row=item();a.session.assign([s],s.id,1,0);
  a.controller.registerRunSessions(a.repo.store,row,[s],a.session.analysis.getSessions);
  await a.controller.attachRunVideos({store:a.repo.store,item:row,runSessions:[s],videos:[],fromRuns:true,sessions:a.session.analysis.getSessions,circuitName:'Course'});
  a.repo.setFail(true);await expect(a.controller.setOpenRunOverlayLayout(s.id,'custom')).rejects.toThrow('offline');
  await expect(a.controller.flushOpenRunsStrict()).rejects.toThrow('offline');a.repo.setFail(false);
  await a.controller.setOpenRunOverlayLayout(s.id,'custom');expect(JSON.parse(a.repo.text.get('course/runs.json')!).runs.run.overlayLayout).toBe('custom');
 });
 it('does not publish a format save that completes after runtime closure',async()=>{
  const a=runtime();await a.formats.loadCsvFormats();const started=deferred<void>(),release=deferred<void>(),write=a.repo.store.writeText;
  a.repo.store.writeText=async(path,text)=>{started.resolve();await release.promise;await write(path,text);};
  const pending=a.formats.saveCalcChannels([{key:'water',label:'water',expr:'speed'}]);const rejected=expect(pending).rejects.toThrow('closed');await started.promise;await a.close();release.resolve();await rejected;
  expect(a.formats.csvFormatsReady()).toBe(false);expect(a.channels.allChannels().some(c=>c.id==='custom:water')).toBe(false);
 });
});
