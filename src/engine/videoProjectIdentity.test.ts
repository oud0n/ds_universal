import {expect,it} from 'vitest';
import {createVideoSyncManager} from './videoSyncManager';
import {clockAtUtc} from './mediaClock';
import {compatibleVideoSource} from './videoTypes';
import type {BinaryFile} from './ports';
const file=(stamp=1000):BinaryFile=>({name:'GX010017.MP4',size:8,lastModified:stamp,arrayBuffer:async()=>new ArrayBuffer(8),slice:()=>({arrayBuffer:async()=>new ArrayBuffer(0)})});
const remote=(stamp=1000)=>({name:'GX010017.MP4',size:8,lastModified:stamp,path:'course/GX010017.MP4',url:'repository:video'});
function model(seed:number){let lease=0;return createVideoSyncManager<BinaryFile>({remoteFile:r=>file(r.lastModified),metadata:async f=>({fileName:f.name,fileSize:f.size,creationTime:new Date(f.lastModified),durationSec:30,timescale:1000}),gps:async()=>({videoStartUtcMs:[]}),open:()=>`owned:${seed}:${lease++}`,release:()=>{},nowMs:()=>seed,random:()=>0.5});}
async function project(seed:number,stamp:number){const media=model(seed);await media.addVideoFiles([file(stamp)],[],false);const track=media.getTracks()[0];media.setClock(track.id,clockAtUtc('manual',stamp+9000));return {media,track,json:media.exportProjectJson([],'course',[{id:'pin',name:'point',trackId:track.id,sessionTimeSec:2,videoTimeSec:1,calculatedOffsetSec:1,createdAt:'2026-01-01'}])};}

it('does not overwrite a remote recording with a same-name local project from another capture',async()=>{
 const active=model(1);await active.addVideoFiles([remote(1000)],[],false);const original=active.getTracks()[0];active.setClock(original.id,clockAtUtc('manual',5000));const before={...original.clock};
 const saved=await project(2,2000),restored=active.importProjectJson(saved.json);
 expect(original.clock).toEqual(before);expect(active.getTracks()).toHaveLength(2);expect(restored.pins[0].trackId).not.toBe(original.id);expect(active.getTracks()[1].objectUrl).toBeUndefined();
});
it.each([false,true])('keeps an unmatched project placeholder when a different known capture is opened (remote=%s)',async isRemote=>{
 const saved=await project(2,2000),active=model(3);active.importProjectJson(saved.json);const placeholder=active.getTracks()[0],clock={...placeholder.clock};
 await active.addVideoFiles([isRemote?remote(1000):file(1000)],[],false);
 expect(placeholder.objectUrl).toBeUndefined();expect(placeholder.clock).toEqual(clock);expect(active.getTracks()).toHaveLength(2);expect(active.getTracks()[1].rawRecordedAt?.getTime()).toBe(1000);
 await active.addVideoFiles([file(2000)],[],false);expect(placeholder.objectUrl).toBeDefined();expect(placeholder.clock).toEqual(clock);
});
it('selects one of two same-name placeholders by known recording time',async()=>{
 const a=await project(1,1000),b=await project(2,2000),active=model(3);active.importProjectJson(a.json);active.importProjectJson(b.json);
 expect(active.getTracks()).toHaveLength(2);await active.addVideoFiles([file(2000)],[],false);
 expect(active.getTracks().map(t=>!!t.objectUrl)).toEqual([false,true]);
});
it('rejects an explicit project key with contradictory source attributes before any mutation',async()=>{
 const a=await project(1,1000),b=await project(2,2000),data=JSON.parse(b.json);data.videos[0].key=JSON.parse(a.json).videos[0].key;
 const before=a.media.getTracks().map(t=>({...t,clock:{...t.clock}}));expect(()=>a.media.importProjectJson(JSON.stringify(data))).toThrow('ambiguous');expect(a.media.getTracks()).toEqual(before);
});
it('does not restore stale saved-row synchronization onto a changed source, while accepting unknown legacy attributes',async()=>{
 const a=await project(1,1000),b=await project(2,2000),data=JSON.parse(b.json).videos[0],before={...a.track.clock};
 expect(a.media.restoreTrackSync(a.track.id,data,[])).toBe(false);expect(a.track.clock).toEqual(before);
 data.fileSize=0;delete data.rawRecordedAt;data.recordedAtJst=null;
 expect(a.media.restoreTrackSync(a.track.id,data,[])).toBe(true);
 expect(compatibleVideoSource(a.track,{fileName:a.track.fileName,rawRecordedAt:'invalid'})).toBe(false);
});
it('exports distinct keys for a reused remote path with different known recording times',async()=>{
 const media=model(1);await media.addVideoFiles([remote(1000),remote(2000)],[],false);
 const data=JSON.parse(media.exportProjectJson([],'course'));expect(new Set(data.videos.map((v:any)=>v.key)).size).toBe(2);
 const restored=model(2);restored.importProjectJson(JSON.stringify(data));expect(restored.getTracks()).toHaveLength(2);
});
