// 共通入口をブラウザのない別のJS環境で実際に読み込む。端末実機の代わりではない。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'src/engine');
const enginePrefix = engineDir.replaceAll('\\', '/') + '/';
const telemetryPrefix = path.join(root, '.build/telemetry/v1').replaceAll('\\', '/') + '/';
const utilsPrefix = path.join(root, 'src/utils').replaceAll('\\', '/') + '/';
const bundle = await rolldown({input:path.join(engineDir,'index.ts'),platform:'browser',treeshake:false});
try {
 const {output}=await bundle.generate({format:'iife',name:'LapLoupeEngine'});
 const chunk=output.find(item=>item.type==='chunk');
 assert(chunk);
 const allowedUtils = new Set(['timeFormat.ts','lapClock.ts','telemetrySearch.ts','timeRepair.ts']);
 for (const module of Object.keys(chunk.modules)) {
  const clean=module.replaceAll('\\','/');
  const allowedTelemetry = ['clock-offset/clockOffsetEstimator.js', 'log-conversion/nmeaExporter.js']
    .some(name => clean === telemetryPrefix + name);
  const allowed=clean.startsWith(enginePrefix) || allowedTelemetry || clean.endsWith('/src/types/telemetry.ts') || (clean.startsWith(utilsPrefix) && allowedUtils.has(path.basename(clean))) || clean.includes('/node_modules/fflate/') || clean.startsWith('\0') || clean.startsWith('rolldown:');
  assert(allowed,`Unexpected engine dependency: ${module}`);
 }
 const unavailable=['window','document','navigator','localStorage','File','Blob','URL','Worker','fetch','TextDecoder','TextEncoder','DecompressionStream','setTimeout','clearTimeout','setInterval','queueMicrotask','console','process','require'];
 const context=vm.createContext(Object.fromEntries(unavailable.map(key=>[key,undefined])));
 vm.runInContext(chunk.code,context,{timeout:10000});
 context.gate=(await fs.readFile(path.join(root,'courses/ControlLine/sodegaura.cln'),'utf8')).trim().split(/\s+/).map(Number);
 context.fixture=Array.from(await fs.readFile(path.join(root,'public/demo/sodegaura_20260815.nmea')));
 const result=await vm.runInContext(`(async()=>{
  const e=LapLoupeEngine;
  const log=await e.logLoader.parseLogBuffer('demo.nmea',Uint8Array.from(fixture).buffer);
  const part=log.parts[0];
  const line={latA:gate[1],lonA:gate[2],latB:gate[3],lonB:gate[4]};
  const counted=e.lapCalculator.extractLaps(part.points,line);
  if(!counted.laps.length) throw Error('No laps from real demo log');
  const run={id:'headless-run',fileName:'demo.nmea',sessionName:'Demo',date:'2026-08-15',circuitName:'Demo',samplingRate:part.samplingRate,points:part.points,laps:counted.laps,bestLapIndex:counted.bestLapIndex,totalDistance:part.points.at(-1).distance,theoreticalBestTime:counted.theoreticalBestTime,sectors:counted.sectors};
  const files=new Map(),preferences=new Map();
  let next=0;
  const metadata=async f=>({fileName:f.name,fileSize:f.size,creationTime:part.startDate??null,durationSec:40,timescale:1000});
  const mediaPorts={remoteFile:remote=>remote,metadata,gps:async()=>({videoStartUtcMs:[]}),open:()=>String(++next),release:()=>{},nowMs:()=>1,random:()=>0.5};
  const runtime=e.engineRuntime.createEngineRuntime({media:mediaPorts,preferences:{read:key=>preferences.get(key)??null,write:(key,value)=>preferences.set(key,value)},scheduler:{schedule:()=>++next,cancel:()=>{},defer:task=>Promise.resolve().then(task)},repository:async()=>null,courses:{prepare:async()=>{},find:async()=>null},remoteMetadata:metadata,pins:{load:()=>[],save:()=>{}},runsChanged:()=>{}});
  const a=runtime.session,b=e.engineSession.createEngineSession();
  const first=counted.laps[0];
  a.assign([run],run.id,first.lapNumber,0);
  a.setPlayhead({source:run.id,sessionSec:e.playbackPosition.asSessionSec(first.startTime+1)});
  const clock=e.playbackPosition.getPlaybackPosition(a.getSnapshot().playhead.sessionSec,first);
  if(clock.lapSec!==1 || b.getSnapshot().analysis.sessions.length) throw Error('Session isolation or clock failed');
  const cars=a.getSnapshot().analysis.selectedCars.length;
  await runtime.media.addVideoFiles([{name:'clip.mp4',size:1,lastModified:0,arrayBuffer:async()=>new ArrayBuffer(0),slice:()=>({arrayBuffer:async()=>new ArrayBuffer(0)})}],[run],false);
  const track=runtime.media.getTracks()[0];
  runtime.media.setMatchedSession(track.id,run.id);
  runtime.media.setOffsetIn(track.id,run,12.5);
  const saved=runtime.media.exportProjectJson([run],'Demo');
  files.set('sync.json',saved);
  const restored=e.videoSyncManager.createVideoSyncManager(mediaPorts);
  restored.importProjectJson(files.get('sync.json'),[run]);
  const placed=e.videoTypes.placeTrack(restored.getTracks()[0],run,[run]);
  if(placed.syncOffsetSec!==12.5)throw Error('Sync did not round trip');
  return {syncOffset:placed.syncOffsetSec,parts:log.parts.length,points:part.points.length,laps:counted.laps.length,clock:clock.lapSec,cars};
 })()`,context,{timeout:30000});
 assert(result.points>100);assert(result.laps>0);assert.equal(result.cars,1);
 process.stdout.write(`Portable engine: ${JSON.stringify(result)}; no browser/Node globals.\n`);
} finally { await bundle.close(); }
