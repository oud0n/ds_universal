// 合成H264/GPMFと専用Chromeのみ。個人動画・実保管場所・機器には接続しない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Page} from './cdp.mjs';
const url=new URL(process.env.E2E_URL??'http://127.0.0.1:5173/'),port=Number(process.env.E2E_CDP_PORT);
assert(['localhost','127.0.0.1'].includes(url.hostname)&&port>0);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'laploupe-video-input-')),plain=path.join(dir,'plain.mp4');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=10','-t','4','-c:v','libx264','-pix_fmt','yuv420p',plain]);
const base=fs.readFileSync(plain),epoch=Date.UTC(2000,0,1),day=9000,count=120;
const words=(...values)=>{const out=Buffer.alloc(values.length*4);values.forEach((n,i)=>out.writeUInt32BE(n,i*4));return out;};
const box=(name,...body)=>{const data=Buffer.concat(body);return Buffer.concat([words(data.length+8),Buffer.from(name),data]);};
const position=t=>[35.39486+0.0005*Math.sin(t*Math.PI/20),140.08803+0.0005*Math.cos(t*Math.PI/20)];
function gopro(day,hz=1){
 const payload=Buffer.alloc(8+72*count);payload.write('GPS9');payload[4]='d'.charCodeAt(0);payload[5]=72;payload.writeUInt16BE(count,6);
 for(let r=0;r<count;r++)[...position(r/hz),1,hz===1?12:12+r%7,12,day,r/hz,1,3].forEach((n,i)=>payload.writeDoubleBE(n,8+r*72+i*8));
 let offset=0;while(offset+8<=base.length&&base.toString('ascii',offset+4,offset+8)!=='moov')offset+=base.readUInt32BE(offset);
 assert.equal(offset+base.readUInt32BE(offset),base.length,'ffmpeg places moov last');
 const trak=where=>box('trak',box('mdia',box('hdlr',words(0,0),Buffer.from('meta')),box('mdhd',words(0,0,0,1000)),box('minf',box('stbl',box('stsd',words(0,1,8),Buffer.from('gpmd')),box('stsz',words(0,payload.length,1)),box('stts',words(0,1,1,count*1000/hz)),box('stco',words(0,1,where))))));
 return Buffer.concat([base.subarray(0,offset),box('moov',base.subarray(offset+8),trak(base.length+trak(0).length+8)),box('mdat',payload)]);
}
const first=path.join(dir,'a','GX010017.MP4'),second=path.join(dir,'b','GX010017.MP4');
for(const [file,d]of [[first,day],[second,day+1]]){fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,gopro(d));fs.utimesSync(file,(epoch+d*86400000)/1000,(epoch+d*86400000)/1000);}
assert.equal(fs.statSync(first).size,fs.statSync(second).size);
const log=path.join(dir,'base.gpx');
fs.writeFileSync(log,`<gpx><trk><trkseg>${Array.from({length:count*10},(_,i)=>{const [lat,lon]=position(i/10);return `<trkpt lat="${lat}" lon="${lon}"><time>${new Date(epoch+day*86400000+i*100).toISOString()}</time></trkpt>`;}).join('')}</trkseg></trk></gpx>`);
const outDir=fileURLToPath(new URL('./out/lap-video-input/',import.meta.url));fs.mkdirSync(outDir,{recursive:true});
const p=await Page.connect(port,{newTab:true,label:'video-input',outDir});
try{
 await p.goto(url.href);await p.waitFor('window.__laploupe');await p.ev("import('/src/utils/i18n.ts').then(m=>m.setLang('en'))");
 await p.setFiles('[data-testid=log-file-input]',[first]);await p.waitFor('window.__laploupe.sessions.length===1&&window.__laploupe.videos.length===1');
 await p.setFiles('[data-testid=log-file-input]',[second]);await p.waitFor('window.__laploupe.sessions.length===2&&window.__laploupe.videos.length===2');
 assert.equal(await p.ev('new Set(window.__laploupe.videos.map(v=>v.matchedSessionId)).size'),2,'different capture is not skipped or assigned to old GPS');
 const secondBytes=fs.readFileSync(second).toString('base64');
 await p.ev(`window.__laploupe.loadFiles([new File([Uint8Array.from(atob(${JSON.stringify(secondBytes)}),c=>c.charCodeAt(0))],'GX010017.MP4',{lastModified:${epoch+(day+1)*86400000},type:'video/mp4'})])`);
 assert.equal(await p.ev('window.__laploupe.sessions.length'),2,'the same source is still deduplicated');
 // 動画Aだけを開いた状態で、同名同サイズの撮影BのプロジェクトをUIから戻す。
 const project=await p.ev(`(async()=>{const m=(await import('/src/services/videoSyncManager.ts')).videoSyncManager;const [a,b]=m.getTracks();window.captureA=a.id;window.captureAClock=JSON.stringify(a.clock);const json=m.exportProjectJson(window.__laploupe.analysisSnapshot().sessions,'course',[],new Set([b.id]));m.removeTrack(b.id);return json;})()`);
 const projectPath=path.join(dir,'capture-b.dssync.json');fs.writeFileSync(projectPath,project);
 await p.ev("window.__laploupe.go('video')");await p.waitFor("[...document.querySelectorAll('[data-testid=video-window]')].some(e=>e.offsetParent!==null)");
 await p.ev("[...document.querySelectorAll('[data-testid=video-window]')].find(e=>e.offsetParent!==null).setAttribute('data-input-test','true')");
 await p.setFiles('[data-input-test] input[type=file][accept*="dssync"]',[projectPath]);
 await p.waitFor('window.__laploupe.videos.length===2');
 assert.equal(await p.ev("import('/src/services/videoSyncManager.ts').then(({videoSyncManager:m})=>JSON.stringify(m.getTracks().find(t=>t.id===window.captureA).clock))"),await p.ev('window.captureAClock'),'project B does not overwrite active capture A');
 assert.equal(await p.ev("import('/src/services/videoSyncManager.ts').then(({videoSyncManager:m})=>m.getTracks().filter(t=>!t.objectUrl).length)"),1,'capture B remains an unmatched placeholder');
 const notes=p.notes.length;
 await p.ev("window.__laploupe.loadFiles([new File([new Uint8Array(8)],'GL010017.LRV')])");
 assert.ok(p.notes.slice(notes).some(note=>note.includes('Could not load the proxy video:')),'ambiguous proxy is reported instead of an unhandled rejection');
 // 新しいAppで、より細かい既存GPSへ合わせる途中のmetadata読込みを止める。
 await p.goto(url.href);await p.waitFor('window.__laploupe');await p.ev("import('/src/utils/i18n.ts').then(m=>m.setLang('en'))");
 await p.ev("import('/src/services/videoPrefs.ts').then(m=>m.setAddVideoGpsLog(false))");
 await p.setFiles('[data-testid=log-file-input]',[log]);await p.waitFor('window.__laploupe.sessions.length===1');
 const videoBytes=fs.readFileSync(first).toString('base64');
 await p.ev(`(()=>{
  const file=new File([Uint8Array.from(atob(${JSON.stringify(videoBytes)}),c=>c.charCodeAt(0))],'GX010018.MP4',{lastModified:${epoch+day*86400000},type:'video/mp4'}),slice=file.slice.bind(file);let headers=0;
  file.slice=(start,end,type)=>{const value=slice(start,end,type);if(start===0&&++headers===3)return {arrayBuffer:()=>new Promise(resolve=>window.finishVideoMetadata=()=>resolve(value.arrayBuffer()))};return value;};
  window.videoInputPromise=window.__laploupe.loadFiles([file]);
 })()`);
 await p.waitFor('window.finishVideoMetadata',15000,'metadata after matching an existing GPS');
 assert.equal(await p.ev('window.__laploupe.sessions.length'),1,'the matched branch does not add a second GPS');
 await p.click('toggle-data-drawer');
 await p.ev("document.querySelector('[data-testid=data-drawer] button[title=\"Delete session\"]').click()");
 await p.waitFor('window.__laploupe.sessions.length===0');
 await p.ev('window.finishVideoMetadata();window.videoInputPromise');
 assert.equal(await p.ev("import('/src/services/videoSyncManager.ts').then(({videoSyncManager:m})=>m.getTracks().length)"),0,'no media points at the removed source');
 // 通常の一時I/O失敗を正常な動画にせず、同じ入力を読み直せる。
 const failedNotes=p.notes.length;
 await p.ev(`(()=>{
  const file=new File([Uint8Array.from(atob(${JSON.stringify(videoBytes)}),c=>c.charCodeAt(0))],'broken-read.mp4',{type:'video/mp4'}),slice=file.slice.bind(file);let fail=true;
  file.slice=(start,end,type)=>{if(fail){fail=false;return {arrayBuffer:async()=>{throw new Error('temporary read failure');}};}return slice(start,end,type);};
  window.retryReadFile=file;return window.__laploupe.loadFiles([file]);
 })()`);
 assert.ok(p.notes.slice(failedNotes).some(note=>note.includes('Could not load broken-read.mp4:')),'ordinary read failure is shown');
 assert.equal(await p.ev('window.__laploupe.sessions.length'),0,'failed input does not publish an empty run');
 assert.equal(await p.ev('window.__laploupe.videos.length'),0,'failed input does not publish fallback metadata');
 await p.ev('window.__laploupe.loadFiles([window.retryReadFile])');
 await p.waitFor('window.__laploupe.sessions.length===1&&window.__laploupe.videos.length===1');
 assert.equal(await p.ev("import('/src/services/videoSyncManager.ts').then(({videoSyncManager:m})=>m.getTracks()[0].durationSec)"),4,'retry loads the real duration');
 // 古い混合入力のファイル読込みを止め、その間に選び直した動画を準備する。
 await p.goto(url.href);await p.waitFor('window.__laploupe');
 const logText=fs.readFileSync(log,'utf8');
 await p.ev(`(()=>{
  const log=new File([${JSON.stringify(logText)}],'old.gpx'),original=log.arrayBuffer.bind(log);
  let held=false;log.arrayBuffer=()=>{if(held)return original();held=true;return new Promise(resolve=>window.finishOldLog=()=>resolve(original()));};
  const old=new File([Uint8Array.from(atob(${JSON.stringify(videoBytes)}),c=>c.charCodeAt(0))],'older.mp4');
  window.oldMixed=window.__laploupe.loadFiles([log,old]);
  const next=new File([Uint8Array.from(atob(${JSON.stringify(videoBytes)}),c=>c.charCodeAt(0))],'newer.mp4'),slice=next.slice.bind(next);let hold=true;
  next.slice=(start,end,type)=>{const value=slice(start,end,type);if(hold){hold=false;return {arrayBuffer:()=>new Promise(resolve=>window.finishNewVideo=()=>resolve(value.arrayBuffer()))};}return value;};
  window.newVideo=window.__laploupe.loadFiles([next]);
 })()`);
 await p.waitFor('window.finishNewVideo&&window.finishOldLog');
 await p.ev('window.finishOldLog();window.oldMixed');
 await p.ev('window.finishNewVideo();window.newVideo');
 assert.deepEqual(await p.ev('window.__laploupe.videos.map(v=>v.fileName)'),['newer.mp4'],'old mixed input cannot supersede the newer selection');
 assert.equal(await p.ev('window.__laploupe.sessions.some(s=>s.fileName==="old.gpx")'),false,'old log cannot publish after selection changed');
 // GPSのrange読込み中と、解析結果の採用待ちで設定が変わっても最新値で公開する。
 await p.goto(url.href);await p.waitFor('window.__laploupe');
 await p.ev(`(async()=>{
  const {setGFilterLevel}=await import('/src/services/physics.ts');setGFilterLevel('strong');
  const file=new File([Uint8Array.from(atob(${JSON.stringify(gopro(day,10).toString('base64'))}),c=>c.charCodeAt(0))],'filter.mp4'),slice=file.slice.bind(file);let headers=0;
  file.slice=(start,end,type)=>{const value=slice(start,end,type);if(start===0&&++headers===2)return {arrayBuffer:()=>new Promise(resolve=>window.finishGpsRead=()=>resolve(value.arrayBuffer()))};return value;};
  window.filterImport=window.__laploupe.loadFiles([file]);
 })()`);
 await p.waitFor('window.finishGpsRead');
 await p.ev("import('/src/services/physics.ts').then(m=>m.setGFilterLevel('weak'))");
 await p.ev('window.finishGpsRead();window.filterImport');
 const physics=await p.ev(`import('/src/services/physics.ts').then(({applyGFilter})=>{
  const pts=window.__laploupe.analysisSnapshot().sessions[0].points,values=p=>p.map(q=>[q.accelG,q.corneringG,q.turningRadius]);
  return {actual:values(pts),weak:values(applyGFilter(pts.map(p=>({...p})),'weak')),strong:values(applyGFilter(pts.map(p=>({...p})),'strong'))};
 })`);
 assert.notDeepEqual(physics.weak,physics.strong,'synthetic GPS distinguishes smoothing levels');
 assert.deepEqual(physics.actual,physics.weak,'pending import uses the current G smoothing');
 // metadataだけ成功し、GPSの物理I/Oが失敗してもcreation時計で公開しない。
 await p.goto(url.href);await p.waitFor('window.__laploupe');
 const gpsFailure=await p.ev(`(async()=>{
  const {videoSyncManager:m}=await import('/src/services/videoSyncManager.ts');
  const file=new File([Uint8Array.from(atob(${JSON.stringify(videoBytes)}),c=>c.charCodeAt(0))],'gps-read.mp4'),slice=file.slice.bind(file);let headers=0;
  file.slice=(start,end,type)=>{if(start===0&&++headers===2)return {arrayBuffer:async()=>{throw Error('temporary GPS read failure');}};return slice(start,end,type);};
  let failure='';try{await m.addVideoFiles([file],[],true);}catch(error){failure=error.message;}
  const failedTracks=m.getTracks().length;await m.addVideoFiles([file],[],true);
  const core=await import('/src/engine/gpmfParser.ts');let partial='';
  try{await core.parseGoproGps([{size:40,read:async()=>{throw Error('partial chapter IO');}},core.blobByteSource(file)]);}catch(error){partial=error.message;}
  const plain=new File([Uint8Array.from(atob(${JSON.stringify(base.toString('base64'))}),c=>c.charCodeAt(0))],'plain.mp4');
  const mixed=await core.parseGoproGps([core.blobByteSource(plain),core.blobByteSource(file)]);
  return {failure,failedTracks,source:m.getTracks()[0].clock.source,partial,validPoints:mixed.points.length};
 })()`);
 assert.equal(gpsFailure.failure,'temporary GPS read failure');assert.equal(gpsFailure.failedTracks,0);assert.equal(gpsFailure.source,'gps');
 assert.equal(gpsFailure.partial,'partial chapter IO','a partial IO failure cannot become a successful shortened GPS log');
 assert.equal(gpsFailure.validPoints,count,'a real absence of GPS can still be combined with a readable chapter');
 assert.deepEqual(p.errors,[]);console.log('PASS video identity, stale input, failed IO retry and current physics preferences');
}finally{await p.close();fs.rmSync(dir,{recursive:true,force:true});}
