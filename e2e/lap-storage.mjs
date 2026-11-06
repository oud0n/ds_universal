import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Page} from './cdp.mjs';
// 新しく起動した開発サーバーと専用 Chrome を使う (HMR 前後の別 URL の module を混ぜない)。
// E2E_CDP_PORT=9222 E2E_URL=http://127.0.0.1:5173/ node e2e/lap-storage.mjs
// ffmpeg で短い合成動画を作る。保管場所はメモリ内で、実際の電子版・iCloud には接続しない。
const url=new URL(process.env.E2E_URL ?? 'http://127.0.0.1:5173/');
assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
const port=Number(process.env.E2E_CDP_PORT);assert.ok(port>0,'専用 Chrome のポートを指定してください');
const fixtureDir=fs.mkdtempSync(path.join(os.tmpdir(),'laploupe-storage-'));
const videoPath=path.join(fixtureDir,'synthetic.mp4');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','4','-c:v','libx264','-pix_fmt','yuv420p',videoPath]);
const outDir=fileURLToPath(new URL('./out/lap-storage/',import.meta.url));fs.mkdirSync(outDir,{recursive:true});
const p=await Page.connect(port,{newTab:true,label:'storage',outDir});
const waitNote = async n => {const end=Date.now()+10000;while(p.notes.length===n){if(Date.now()>end)throw Error('missing save error');await new Promise(r=>setTimeout(r,50));}};
const assigned = slot => p.waitFor(`[...document.querySelectorAll('[role=dialog] [role=status]')].some(e=>e.textContent.includes('Assigned ')&&e.textContent.includes('Car ${slot+1}'))`,15000,'assignment completion');
try {
 await p.viewport(1280,800,false);
 await p.send('Page.addScriptToEvaluateOnNewDocument',{source:`
 window.storeFiles = new Map(); window.storeWrites=[]; window.storeReads=[]; window.failWrites=false;
 window.electronAPI={onOpenFiles:callback=>{window.menuOpenFiles=callback;return()=>{window.menuOpenFiles=null}},readFileBuffer:async path=>{if(window.holdMenuRead&&path.endsWith('menu-old.nmea'))await new Promise(resolve=>window.finishMenuRead=resolve);return {success:true,name:path.slice(path.lastIndexOf('/')+1),dataArray:storeFiles.get('sodegaura/demo.nmea')};},laps:{getFolder:async()=>{if(window.holdFolder)await new Promise(resolve=>(window.folderWaiters??=[]).push(resolve));return window.folderRoot??'/synthetic/A'},pickFolder:async()=>null,
 list:async()=>window.failSavedList&&window.__laploupe?.openingSaved?.()?{success:false,error:'synthetic list failure'}:({success:true,files:[...storeFiles].map(([path,b])=>({path,size:b.byteLength,mtimeMs:123,local:true}))}),
 read:async path=>{storeReads.push(path);if(window.holdHistoryRead===path)await new Promise(resolve=>window.resumeHistoryRead=resolve);if(window.holdLegacyRead===path && window.__laploupe?.openingRun?.())await new Promise(resolve=>window.resumeLegacyRead=resolve);if(window.holdIndexRead===path)await new Promise(resolve=>window.resumeIndexRead=resolve);if(window.readDelayMs)await new Promise(r=>setTimeout(r,window.readDelayMs));if(window.holdSavedRead===path && window.__laploupe?.openingSaved?.())await new Promise(resolve=>window.resumeSavedRead=resolve);const b=storeFiles.get(path);return b?{success:true,data:b}:{success:false,error:'not found'}},
 readText:async path=>{if(window.failListedRunsMetadata&&path.endsWith('/runs.json'))return {success:false,error:'synthetic listing metadata failure'};if(window.failRunsMetadata&&window.__laploupe?.openingSaved?.()&&path.endsWith('/runs.json'))return {success:false,error:'synthetic metadata failure'};if(window.holdTextRead===path)await new Promise(resolve=>(window.textWaiters??=[]).push(resolve));return {success:true,text:storeFiles.has(path)?new TextDecoder().decode(storeFiles.get(path)):null}},
 writeText:async(path,text)=>{if(path.endsWith('/laptimes.json'))(window.indexWrites??=[]).push(JSON.parse(text));if(window.failWrites)return {success:false,error:'synthetic write failure'};storeWrites.push(path);storeFiles.set(path,new TextEncoder().encode(text));return {success:true}}
 }};
 `});
 await p.goto(url.href);await p.waitFor('window.__laploupe');
 await p.ev("import('/src/utils/i18n.ts').then(m=>m.setLang('en'))");
 await p.ev(`(async()=>{
 const b=new Uint8Array(await(await fetch('/demo/sodegaura_20260815.nmea')).arrayBuffer());storeFiles.set('sodegaura/demo.nmea',b);
 const {parseNmea}=await import('/src/services/nmeaParser.ts');
 const log=parseNmea(new TextDecoder().decode(b));const first=Date.parse(log.points[0].timestamp);
 const imu=['time_utc_ms,g_long,g_lat'];for(let t=0;t<2000;t++)imu.push((first+t*1000)+',0.123,0.234');
 storeFiles.set('sodegaura/demo.iphone_imu.csv',new TextEncoder().encode(imu.join(String.fromCharCode(10))));
 })()`);
 // 一覧の走査中に保存先を取り消しても、正常なログを周なしとして控えず、一覧は自動で読み直す。
 await p.ev("(async()=>{window.holdIndexRead='sodegaura/demo.nmea';window.__laploupe.go('library');(await import('/src/services/runsChanged.ts')).notifyRunsChanged();})()");
 await p.waitFor('window.resumeIndexRead',10000,'in-flight lap index read');
 await p.ev("(async()=>{window.holdIndexRead=null;await(await import('/src/services/storageRevision.ts')).trackStorageSelection(()=>null);window.resumeIndexRead();})()");
 await p.waitFor("document.querySelector('[data-testid=run-row]') && window.indexWrites?.some(x=>x.files['demo.nmea']?.laps.length>0)",15000,'run list recovers after cancel');
 assert.ok(await p.ev("window.indexWrites.every(x=>!x.files['demo.nmea']||x.files['demo.nmea'].laps.length>0)"),'interrupted read never writes a zero-lap record');
 // 従来のラップ履歴も、中断後に閉じ直さず表示が回復する。
 await p.ev("storeFiles.delete('sodegaura/laptimes.json');window.holdIndexRead='sodegaura/demo.nmea';window.resumeIndexRead=null");
 await p.ev("window.__laploupe.go('analysis')");await p.click('toggle-data-drawer');await p.click('open-lap-history');
 await p.waitFor('window.resumeIndexRead',10000,'in-flight legacy history scan');
 await p.ev("(async()=>{window.holdIndexRead=null;await(await import('/src/services/storageRevision.ts')).trackStorageSelection(()=>null);window.resumeIndexRead();})()");
 await p.waitFor("document.querySelectorAll('[data-testid=lap-history-row]').length>0",15000,'history recovers after cancel');
 assert.equal(await p.ev("document.querySelector('[role=dialog]').innerText.includes('The run folder changed.')"),false);
 await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");await p.click('data-drawer-close');
 await p.ev("window.__laploupe.go('analysis')");await p.click('open-lap-picker');
 const hasStored=await p.ev("[...document.querySelectorAll('button')].some(x=>x.textContent==='Stored runs')");if(hasStored)await p.clickText('Stored runs');
 await p.waitFor("document.querySelector('[data-testid=lap-picker-row]')",20000,'stored laps');
 await p.ev("window.holdFolder=true;document.querySelector('[data-testid=lap-picker-row] [data-slot=\"0\"]').click()");
 await p.waitFor('window.__laploupe.cars.length===1',15000,'stored assignment');
 // 動画の所有者を作る直前で止め、同じ元を別の Car へ追加する。
 await p.waitFor('window.folderWaiters?.length>0',5000,'attachment barrier');
 await p.ev("document.querySelector('[data-testid=lap-picker-row] [data-slot=\"1\"]').click()");
 await p.waitFor('window.__laploupe.cars.length===2',10000,'second pick during attachment');
 await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 await p.click('toggle-data-drawer');
 await p.ev(`(()=>{const e=document.querySelector('[data-testid=data-drawer] input[type=number][step="0.01"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'1.75');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await p.ev("import('/src/services/runOpener.ts').then(m=>m.flushOpenRunsStrict())");
 assert.equal(await p.ev("JSON.parse(new TextDecoder().decode(storeFiles.get('sodegaura/runs.json'))).runs.demo.parts['1'].clockOffsetSec"),1.75,'clock edit saves before video attachment finishes');
 await p.click('data-drawer-close');
 await p.ev('window.holdFolder=false;window.folderWaiters.forEach(f=>f())');
 await p.waitFor("window.storeReads.includes('sodegaura/demo.iphone_imu.csv')",10000,'IMU sidecar');
 assert.equal(await p.ev("import('/src/services/imuG.ts').then(m=>m.parseImuCsv(new TextDecoder().decode(storeFiles.get('sodegaura/demo.iphone_imu.csv')))?.t.length)"),2000);
 await p.ev("import('/src/services/runOpener.ts').then(m=>window.testRunOpener=m)");

 await p.waitFor("!!window.testRunOpener.getOpenRun()",10000,"video owner");
 const video=fs.readFileSync(videoPath).toString('base64');
 await p.ev(`(async()=>{const {videoSyncManager:m}=await import('/src/services/videoSyncManager.ts');const b=Uint8Array.from(atob(${JSON.stringify(video)}),x=>x.charCodeAt(0));await m.addVideoFiles([new File([b],'synthetic.mp4',{type:'video/mp4'})],[],false);m.getTracks()[0].remote={path:'sodegaura/synthetic.mp4',url:m.getTracks()[0].url,name:'synthetic.mp4',size:b.length,lastModified:0};})()`);
 await p.click('toggle-data-drawer');
 await p.ev(`(()=>{const e=document.querySelector('[data-testid=data-drawer] input[type=number][step="0.01"]');if(!e)throw Error('clock input missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'1.25');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 assert.equal(await p.ev('window.__laploupe.pointsOf(0).clockOffsetSec'),1.25);
 await p.click('data-drawer-close');
 await p.click('open-lap-picker');
 if(await p.ev("[...document.querySelectorAll('button')].some(x=>x.textContent==='Stored runs')"))await p.clickText('Stored runs');
 await p.waitFor("document.querySelector('[data-testid=lap-picker-row]')",10000,'stored reload');
 await p.ev("document.querySelector('[data-testid=lap-picker-row] [data-slot=\"1\"]').click()");
 await p.waitFor('window.__laploupe.cars.length===2',10000,'second stored assignment');
 await assigned(1);
 assert.equal(await p.ev('window.__laploupe.sessions.length'),1,'same source reuses its session');
 assert.equal(await p.ev('window.__laploupe.pointsOf(0).clockOffsetSec'),1.25,'second stored pick retains clock');
 await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 // 動画の保存元 A を残して直接開いた GPS B を基準にしても、同期編集を失わない。
 const loosePath=path.join(fixtureDir,'loose.nmea');fs.copyFileSync(fileURLToPath(new URL('../public/demo/sodegaura_20260815.nmea',import.meta.url)),loosePath);
 await p.ev(`(async()=>{
  window.testVideoManager=(await import('/src/services/videoSyncManager.ts')).videoSyncManager;
  const owner=testRunOpener.getOpenRun(), all=window.__laploupe.analysisSnapshot().sessions;
  const a=all.find(s=>s.fileName==='demo.nmea'), track=testVideoManager.getTracks()[0];
  window.originalOwnerItem=owner.item;window.originalStoredId=a.id;window.originalVideoId=track.id;
  storeFiles.set('sodegaura/synthetic.mp4',Uint8Array.from(atob(${JSON.stringify(video)}),x=>x.charCodeAt(0)));
  await testRunOpener.attachRunVideos({store:owner.store,item:owner.item,runSessions:[a],videos:[track.remote],fromRuns:true,sessions:()=>window.__laploupe.analysisSnapshot().sessions,circuitName:()=>a.circuitName});
  testVideoManager.setOffsetIn(track.id,a,2.25);await testRunOpener.flushOpenRunsStrict();
 })()`);
 await p.setFiles('[data-testid=log-file-input]',[loosePath]);
 await p.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Just open (no import)')");await p.clickText('Just open (no import)');
 await p.waitFor("window.__laploupe.sessions.some(s=>s.fileName==='loose.nmea')",15000,'direct alternate GPS');
 await p.ev("(()=>{const s=window.__laploupe.analysisSnapshot().sessions.find(s=>s.fileName==='loose.nmea');if(s.sourceFile)throw Error('expected loose source');window.looseId=s.id;window.__laploupe.selectCar(0,s.id,s.laps.find(l=>!l.isWholeSession&&!l.isPartialLap).lapNumber);})()");
 await p.click('toggle-data-drawer');
 await p.ev("[...document.querySelectorAll('button[title^=\"Unassign Car \"]')].filter(b=>!b.title.startsWith('Unassign Car 1 ')).forEach(b=>b.click())");
 await p.click('data-drawer-close');await p.click('open-lap-picker');await p.clickText('Open runs');
 await p.waitFor("[...document.querySelectorAll('[data-testid=lap-picker-row]')].some(r=>r.parentElement.querySelector('p')?.title.includes('loose.nmea'))");
 await p.ev("[...document.querySelectorAll('[data-testid=lap-picker-row]')].find(r=>r.parentElement.querySelector('p')?.title.includes('loose.nmea')).querySelector('[data-slot=\"0\"]').click()");
 await assigned(0);await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 assert.ok(await p.ev('window.__laploupe.sessions.some(s=>s.id===window.originalStoredId)'),'retains the video owner source while loose GPS is base');
 await p.ev("(async()=>{testVideoManager.setOffsetIn(originalVideoId,window.__laploupe.analysisSnapshot().sessions.find(s=>s.id===originalStoredId),7.5);await testRunOpener.flushOpenRunsStrict();})()");
 assert.ok(await p.ev("Object.values(JSON.parse(new TextDecoder().decode(storeFiles.get('sodegaura/runs.json'))).runs).some(r=>r.videos?.some(v=>v.name==='synthetic.mp4'&&v.clock.offsetSec===7.5))"),'sync edit saved while original run has no Car');
 await p.ev("testVideoManager.setOffsetIn(originalVideoId,window.__laploupe.analysisSnapshot().sessions.find(s=>s.id===originalStoredId),8.5)");
 await p.click('open-lap-picker');await p.clickText('Stored runs');
 await p.waitFor("[...document.querySelectorAll('[data-testid=lap-picker-row]')].some(r=>r.parentElement.querySelector('p')?.title.includes('demo.nmea'))");
 await p.ev("[...document.querySelectorAll('[data-testid=lap-picker-row]')].find(r=>r.parentElement.querySelector('p')?.title.includes('demo.nmea')).querySelector('[data-slot=\"0\"]').click()");
 await assigned(0);
 assert.equal(await p.ev('testVideoManager.getTracks().find(t=>t.id===originalVideoId).clock.offsetSec'),8.5);
 assert.ok(await p.ev('testRunOpener.getOpenRun().item===originalOwnerItem && window.__laploupe.cars[0].sessionId===originalStoredId'),'restored run reuses owner and session');
 await p.ev("document.querySelector('[data-testid=lap-picker-row] [data-slot=\"1\"]').click()");await assigned(1);
 await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 const before=await p.ev("(async()=>{const a=await import('/src/services/storageRevision.ts'),v=await import('/src/services/videoSyncManager.ts'),r=await import('/src/services/runOpener.ts');return {revision:a.getStorageRevision(),read:a.getStorageReadRevision(),tracks:v.videoSyncManager.getTracks().map(x=>x.id),owner:r.getOpenRun()?.item.file,cars:window.__laploupe.cars};})()");
 await p.ev("import('/src/services/storageRevision.ts').then(m=>m.trackStorageSelection(()=>null))");
 await new Promise(r=>setTimeout(r,200));
 const after=await p.ev("(async()=>{const a=await import('/src/services/storageRevision.ts'),v=await import('/src/services/videoSyncManager.ts'),r=await import('/src/services/runOpener.ts');const row=storeFiles.get('sodegaura/runs.json');return {revision:a.getStorageRevision(),read:a.getStorageReadRevision(),tracks:v.videoSyncManager.getTracks().map(x=>x.id),owner:r.getOpenRun()?.item.file,cars:window.__laploupe.cars,saved:row?JSON.parse(new TextDecoder().decode(row)):null};})()");
 assert.equal(after.revision,before.revision);assert.equal(after.read,before.read+2);assert.deepEqual(after.tracks,before.tracks);assert.equal(after.owner,before.owner);assert.deepEqual(after.cars,before.cars);

 const serialized=JSON.stringify(after.saved);assert.ok(serialized.includes('1.25'),'unsaved clock flushed before cancel');
 // 保存が失敗したときは、保存先の選択自体を始めず、割当てや動画を変えない。
 await p.click('toggle-data-drawer');
 await p.ev(`(()=>{const e=document.querySelector('[data-testid=data-drawer] input[type=number][step="0.01"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'2.5');e.dispatchEvent(new Event('input',{bubbles:true}));window.failWrites=true;})()`);
 await p.click('data-drawer-close');
 const failed=await p.ev("(async()=>{let called=false;try{await (await import('/src/services/storageRevision.ts')).trackStorageSelection(()=>{called=true;return '/synthetic/B'});return {called,rejected:false};}catch{return {called,rejected:true};}})()");
 assert.deepEqual(failed,{called:false,rejected:true});
 assert.equal(await p.ev("import('/src/services/storageRevision.ts').then(m=>m.getStorageRevision())"),before.revision);
 assert.equal(await p.ev('window.__laploupe.pointsOf(0).clockOffsetSec'),2.5);
 assert.deepEqual(await p.ev("import('/src/services/videoSyncManager.ts').then(m=>m.videoSyncManager.getTracks().map(x=>x.id))"),before.tracks);
 await p.ev("(()=>{storeFiles.set('sodegaura/B.nmea',storeFiles.get('sodegaura/demo.nmea'));const rows=JSON.parse(new TextDecoder().decode(storeFiles.get('sodegaura/runs.json')));rows.runs.B={updatedAt:'2026-01-01T00:00:00Z',name:'B target'};storeFiles.set('sodegaura/runs.json',new TextEncoder().encode(JSON.stringify(rows)));window.__laploupe.go('library')})()");
 await p.waitFor("[...document.querySelectorAll('[data-testid=run-row]')].some(r=>r.innerText.includes('B target'))");
 await p.ev("[...document.querySelectorAll('[data-testid=run-row]')].find(r=>r.innerText.includes('B target')).click()");
 await p.click('run-open-analysis');await p.waitFor('!window.__laploupe.runBusy');
 assert.deepEqual((await p.state()).cars,before.cars,'legacy open does not change Cars after save failure');
 assert.equal(await p.ev('testRunOpener.getOpenRun()?.item.file'),before.owner);
 await p.ev("window.__laploupe.go('analysis');window.failWrites=false;window.testRunOpener.flushOpenRunsStrict()");
 // 保存した比較の基準周を、走行の最速周で上書きしない。
 const chosenLap=await p.ev("(()=>{const laps=window.testRunOpener.getOpenRun().item.laps;const best=laps.reduce((a,b)=>a.time<b.time?a:b).n;const target=laps.find(l=>l.n!==best).n;const data={version:1,name:'non-best lap',createdAt:'2025-01-01T00:00:00Z',cars:[{slot:0,run:'sodegaura/demo.nmea',lap:target}]};storeFiles.set('sessions/non-best.lapsession.json',new TextEncoder().encode(JSON.stringify(data)));return target;})()");
 await p.ev("window.__laploupe.go('library')");
 await p.waitFor("document.querySelector('[data-testid=library-sessions]')",10000,'saved comparison');
 if(!await p.ev("!!document.querySelector('[data-testid=library-session-row]')"))await p.ev("document.querySelector('[data-testid=library-sessions] > button').click()");
 await p.waitFor("document.querySelector('[data-testid=library-session-row]')");
 const carsBeforeIO=(await p.state()).cars, notesBeforeIO=p.notes.length;
 await p.ev("window.failSavedList=true;document.querySelector('[data-testid=library-session-row] button').click()");
 await p.waitFor('!window.__laploupe.openingSaved()');
 assert.deepEqual((await p.state()).cars,carsBeforeIO,'failed list does not partially restore comparison');
 assert.ok(p.notes.slice(notesBeforeIO).some(s=>s.includes('Could not load the comparison')));
 assert.ok(!p.notes.slice(notesBeforeIO).some(s=>s.includes('runs of this session were not found')));
 await p.ev("window.failSavedList=false;window.failRunsMetadata=true;document.querySelector('[data-testid=library-session-row] button').click()");
 await p.waitFor('!window.__laploupe.openingSaved()');
 assert.deepEqual((await p.state()).cars,carsBeforeIO,'metadata IO does not replace the working comparison');
 await p.ev("window.failRunsMetadata=false;document.querySelector('[data-testid=library-session-row] button').click()");
 await p.waitFor(`window.__laploupe.screen==='analysis' && window.__laploupe.cars.length===1 && window.__laploupe.cars[0].lapNumber===${chosenLap}`);
 assert.ok(Math.abs((await p.state()).sessionTimeSec-(await p.state()).baseLap.startTime)<0.001,'saved base starts at its own lap');
 const beforeMissingLap=(await p.state()).cars;
 await p.ev("(()=>{const data={version:1,name:'Vanished lap',createdAt:'2025-01-01T00:00:00Z',cars:[{slot:0,run:'sodegaura/demo.nmea',lap:999999}]};storeFiles.set('sessions/vanished.lapsession.json',new TextEncoder().encode(JSON.stringify(data)));window.__laploupe.go('library')})()");
 await p.waitFor("[...document.querySelectorAll('[data-testid=library-session-row]')].some(r=>r.innerText.includes('Vanished lap'))");
 await p.ev("[...document.querySelectorAll('[data-testid=library-session-row]')].find(r=>r.innerText.includes('Vanished lap')).querySelector('button').click()");
 await p.waitFor('!window.__laploupe.openingSaved()');
 assert.deepEqual((await p.state()).cars,beforeMissingLap,'missing saved lap does not discard working analysis');
 await p.ev("window.__laploupe.go('analysis');storeFiles.set('sodegaura/B.nmea',storeFiles.get('sodegaura/demo.nmea'))");
 await p.click('open-lap-picker');
 if(await p.ev("[...document.querySelectorAll('button')].some(x=>x.textContent==='Stored runs')"))await p.clickText('Stored runs');
 await p.waitFor("[...document.querySelectorAll('[data-testid=lap-picker-row]')].some(r=>r.parentElement.querySelector('p')?.title.includes('B.nmea'))",15000,'second stored run');
 const pickStored = `(file,slot)=>{const row=[...document.querySelectorAll('[data-testid=lap-picker-row]')].find(r=>r.parentElement.querySelector('p')?.title.includes(file));if(!row)throw Error('missing '+file);row.querySelector('[data-slot="'+slot+'"]').click();}`;
 await p.ev(`(${pickStored})('demo.nmea',1)`);
 await p.waitFor('window.__laploupe.cars.length===2');
 await p.ev(`(${pickStored})('B.nmea',0)`);
 await p.waitFor("window.testRunOpener.getOpenRun()?.item.file==='B.nmea' && window.testRunOpener.companionRuns().includes('sodegaura/demo.nmea')",15000,'demoted owner');
 await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 await p.click('toggle-data-drawer');
 const aid=await p.ev("window.__laploupe.sessions.find(s=>s.fileName==='demo.nmea').id");
 const beforeManualFailure=(await p.state()).cars, notesBeforeManual=p.notes.length;
 await p.ev(`(()=>{const i=window.__laploupe.sessions.findIndex(s=>s.id===${JSON.stringify(aid)});const card=document.querySelectorAll('[data-testid=session-card]')[i];const e=card.querySelector('input[type=number][step="0.01"]');window.failWrites=true;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'5.75');e.dispatchEvent(new Event('input',{bubbles:true}));window.holdFolder=true;const b=[...card.querySelectorAll('tbody tr button')].find(x=>x.textContent.trim()==='1');if(!b)throw Error('legacy Car 1 missing');b.click();})()`);
 await waitNote(notesBeforeManual);
 assert.deepEqual((await p.state()).cars,beforeManualFailure,'legacy manual selection retains Cars after save failure');
 assert.ok(await p.ev("window.testRunOpener.companionRuns().includes('sodegaura/demo.nmea')"),'failed manual switch keeps retry owner');
 await p.ev(`(()=>{window.failWrites=false;const i=window.__laploupe.sessions.findIndex(s=>s.id===${JSON.stringify(aid)});const card=document.querySelectorAll('[data-testid=session-card]')[i];[...card.querySelectorAll('tbody tr button')].find(x=>x.textContent.trim()==='1').click();})()`);
 await p.waitFor(`window.__laploupe.cars.find(c=>c.slot===0)?.sessionId===${JSON.stringify(aid)}`);
 await p.waitFor('window.folderWaiters.length>2',5000,'promotion barrier');
 assert.ok(await p.ev("window.testRunOpener.companionRuns().includes('sodegaura/demo.nmea')"),'pending promotion keeps its companion owner');
 await p.ev('window.holdFolder=false;window.folderWaiters.forEach(f=>f())');
 await p.waitFor("window.testRunOpener.getOpenRun()?.item.file==='demo.nmea'",10000,'promoted owner');
 assert.equal(await p.ev(`window.__laploupe.pointsOf(window.__laploupe.sessions.findIndex(s=>s.id===${JSON.stringify(aid)})).clockOffsetSec`),5.75,'promotion preserves failed-save edit');
 await p.ev('window.failWrites=false;window.testRunOpener.flushOpenRunsStrict()');
 await p.click('data-drawer-close');
 await p.click('toggle-data-drawer');
 await p.ev(`(()=>{const i=window.__laploupe.sessions.findIndex(s=>s.id===${JSON.stringify(aid)});window.failWrites=true;document.querySelectorAll('[data-testid=session-card]')[i].querySelector('[data-testid=session-rename]').click();})()`);
 await p.waitFor("document.querySelector('[data-testid=session-name-input]')");
 await p.ev("(()=>{const e=document.querySelector('[data-testid=session-name-input]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Edited without disk');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
 await p.ev("document.querySelector('[data-testid=session-name-input]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))");
 await p.waitFor("window.testRunOpener.getOpenRunItem('sodegaura','demo.nmea').entry?.name==='Edited without disk'");
 await p.click('data-drawer-close');
 await p.click('open-lap-picker');await p.clickText('Stored runs');
 await p.waitFor("[...document.querySelectorAll('[data-testid=lap-picker-row]')].some(r=>r.parentElement.querySelector('p')?.title.includes('demo.nmea'))");
 await p.ev(`(${pickStored})('demo.nmea',1)`);
 await p.waitFor("document.querySelector('[role=dialog] [role=alert]')");
 assert.equal(await p.ev(`window.__laploupe.sessions.find(s=>s.id===${JSON.stringify(aid)}).sessionName`),'Edited without disk');
 await p.ev('window.failWrites=false');
 await p.ev(`(${pickStored})('demo.nmea',1)`);
 await p.waitFor(`window.__laploupe.cars.find(c=>c.slot===1)?.sessionId===${JSON.stringify(aid)}`);
 await assigned(1);
 assert.equal(await p.ev(`window.__laploupe.sessions.find(s=>s.id===${JSON.stringify(aid)}).sessionName`),'Edited without disk','stored reparse keeps pending name');
 await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click();window.failWrites=false");
 await p.ev("(()=>{for(const f of ['C','D'])storeFiles.set('sodegaura/'+f+'.nmea',storeFiles.get('sodegaura/demo.nmea'));const data={version:1,name:'Interleaved saved',createdAt:'2025-01-01T00:00:00Z',cars:['demo','C','D'].map((f,slot)=>({slot,run:'sodegaura/'+f+'.nmea',lap:1}))};storeFiles.set('sessions/interleaved.lapsession.json',new TextEncoder().encode(JSON.stringify(data)));window.holdSavedRead='sodegaura/D.nmea';window.__laploupe.go('library');})()");
 await p.waitFor("[...document.querySelectorAll('[data-testid=library-session-row] button')].some(b=>b.innerText.includes('Interleaved saved'))",15000,'overlap comparison');
 await p.ev("[...document.querySelectorAll('[data-testid=library-session-row] button')].find(b=>b.innerText.includes('Interleaved saved')).click()");
 await p.waitFor("typeof window.resumeSavedRead==='function'",15000,'saved-open companion barrier');
 const duringSaved=(await p.state()).cars;
 await p.ev("window.__laploupe.go('analysis')");
 await p.click('open-lap-picker');
 await p.waitFor("document.querySelector('[data-testid=lap-picker-row]')");
 await p.ev(`(${pickStored})('demo.nmea',1)`);
 await p.waitFor("document.querySelector('[role=dialog] [role=alert]')");
 assert.deepEqual((await p.state()).cars,duringSaved,'picker cannot replace unfinished saved restore');
 await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click();window.holdSavedRead=null;window.resumeSavedRead()");
 await p.waitFor('window.__laploupe.cars.length===3',15000,'finished saved comparison');
 const completed=await p.state();assert.ok(completed.cars.every(c=>completed.sessions.some(s=>s.id===c.sessionId)),'all restored Cars have a live source');
 const earlier=await p.ev("window.testRunOpener.getOpenRunItem('sodegaura','demo.nmea').laps.find(l=>!l.hidden).n");
 const later=await p.ev("window.testRunOpener.getOpenRunItem('sodegaura','demo.nmea').laps.filter(l=>!l.hidden).at(-1).n");
 assert.ok(later>earlier);
 const pickLap=`(n)=>{let run='';for(const row of document.querySelectorAll('[data-testid=lap-picker-row]')){const h=row.parentElement.querySelector('p');if(h)run=h.title;if(run.includes('demo.nmea')&&row.firstElementChild.textContent.trim()==='L'+n){row.querySelector('[data-slot="0"]').click();return;}}throw Error('missing lap '+n);}`;
 await p.ev('window.readDelayMs=10');
 await p.click('open-lap-picker');await p.clickText('Stored runs');
 await p.waitFor("document.querySelector('[data-testid=lap-picker-row]')");
 await p.ev(`(${pickLap})(${later})`);await assigned(0);
 const latePosition=await p.state();
 assert.equal(latePosition.cars.find(c=>c.slot===0).sessionId,aid,'same source before earlier pick');
 await p.ev(`(()=>{let snapshot=window.__laploupe;window.earlierRenders=[];Object.defineProperty(window,'__laploupe',{configurable:true,get:()=>snapshot,set:value=>{snapshot=value;if(value.baseLap?.lapNumber===${earlier})window.earlierRenders.push({time:value.sessionTimeSec,start:value.baseLap.startTime,id:value.cars.find(c=>c.slot===0)?.sessionId});}});})()`);
 await p.ev(`(${pickLap})(${earlier})`);
 await p.waitFor(`window.__laploupe.baseLap.lapNumber===${earlier}`);
 await assigned(0);await new Promise(r=>setTimeout(r,100));
 const earlyPosition=await p.state();
 assert.equal(earlyPosition.cars.find(c=>c.slot===0).sessionId,aid,'same source after earlier pick');
 const firstRenders=await p.ev('window.earlierRenders');
 assert.ok(firstRenders.length>0);assert.ok(firstRenders.every(r=>r.id===aid&&Math.abs(r.time-r.start)<0.001),'all earlier-lap renders start at their own lap start');
 assert.ok(Math.abs(earlyPosition.sessionTimeSec-earlyPosition.baseLap.startTime)<0.001,'same-session async earlier lap starts at its start');
 await p.ev("window.readDelayMs=0;document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 const beforeReject=(await p.state()).cars;
 await p.ev("(()=>{const item=window.testRunOpener.getOpenRunItem('sodegaura','demo.nmea');window.ownerLapsBefore=item.laps;window.ownerVideosBefore=item.folderVideos;const old=storeFiles.get('sodegaura/demo.nmea');const changed=new Uint8Array(old.length+1);changed.set(old);changed[old.length]=10;storeFiles.set('sodegaura/demo.nmea',changed);})()");
 await p.click('open-lap-picker');await p.clickText('Stored runs');
 await p.waitFor("[...document.querySelectorAll('[data-testid=lap-picker-row]')].some(r=>r.parentElement.querySelector('p')?.title.includes('demo.nmea'))",15000,'changed source catalog');
 await p.ev(`(${pickStored})('demo.nmea',3)`);
 await p.waitFor("document.querySelector('[role=dialog] [role=alert]')");
 assert.deepEqual((await p.state()).cars,beforeReject,'rejected assignment does not change Cars');
 assert.ok(await p.ev("(()=>{const item=window.testRunOpener.getOpenRunItem('sodegaura','demo.nmea');return item.laps===window.ownerLapsBefore && item.folderVideos===window.ownerVideosBefore;})()"),'rejected assignment does not mutate live run metadata');
 await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 // 保存した比較の途中で保存先を変えたら、旧結果で Car や画面を戻さない。
 await p.ev("(()=>{for(const f of ['E','F'])storeFiles.set('sodegaura/'+f+'.nmea',storeFiles.get('sodegaura/demo.nmea'));const data={version:1,name:'Interrupted restore',createdAt:'2025-01-01T00:00:00Z',cars:['E','F'].map((f,slot)=>({slot,run:'sodegaura/'+f+'.nmea',lap:1}))};storeFiles.set('sessions/interrupted.lapsession.json',new TextEncoder().encode(JSON.stringify(data)));window.holdSavedRead='sodegaura/F.nmea';window.resumeSavedRead=null;window.__laploupe.go('library');})()");
 await p.waitFor("[...document.querySelectorAll('[data-testid=library-session-row]')].some(x=>x.innerText.includes('Interrupted restore'))",10000,'saved comparison to interrupt');
 await p.ev("[...document.querySelectorAll('[data-testid=library-session-row]')].find(x=>x.innerText.includes('Interrupted restore')).querySelector('button').click()");
 await p.waitFor('window.resumeSavedRead',15000,'restore held on later run');
 const carsBeforeManual=(await p.state()).cars;
 await p.ev("(()=>{window.__laploupe.go('analysis');const s=window.__laploupe.analysisSnapshot().sessions.find(s=>s.id===window.__laploupe.cars[0].sessionId);const lap=s.laps.find(l=>l.lapNumber!==window.__laploupe.cars[0].lapNumber);window.__laploupe.selectCar(0,s.id,lap.lapNumber);})()");
 const manualCars=(await p.state()).cars;assert.notDeepEqual(manualCars,carsBeforeManual);
 await p.ev('window.holdSavedRead=null;window.resumeSavedRead()');
 await p.waitFor('!window.__laploupe.openingSaved()');
 assert.deepEqual((await p.state()).cars,manualCars,'late saved comparison does not replace newer manual choice');
 await p.ev("window.holdSavedRead='sodegaura/F.nmea';window.resumeSavedRead=null;window.__laploupe.go('library')");
 await p.waitFor("[...document.querySelectorAll('[data-testid=library-session-row]')].some(x=>x.innerText.includes('Interrupted restore'))");
 await p.ev("[...document.querySelectorAll('[data-testid=library-session-row]')].find(x=>x.innerText.includes('Interrupted restore')).querySelector('button').click()");
 await p.waitFor('window.resumeSavedRead',15000,'second restore held on later run');
 const carsAtRootChange=(await p.state()).cars, notesAtRootChange=p.notes.length;
 await p.ev("(async()=>{window.__laploupe.go('settings');await(await import('/src/services/storageRevision.ts')).trackStorageSelection(()=>{window.folderRoot='/synthetic/restore-new';return '/synthetic/restore-new'});window.resumeSavedRead();})()");
 await p.waitFor('!window.__laploupe.openingSaved()',10000,'obsolete restore ends');
 assert.equal((await p.state()).screen,'settings');assert.deepEqual((await p.state()).cars,carsAtRootChange);
 assert.deepEqual(p.notes.slice(notesAtRootChange),[],'root change is not reported as missing runs');
 // 定義・計算式も保存先に属する。旧編集は閉じ、新保存先の確認前には保存しない。
 await p.ev(`(async()=>{
  window.csvStore=await import('/src/services/csvFormatStore.ts');
  window.csvPayload=name=>({version:1,id:'user:sample',name,kind:'sensor',sensorKey:'sample',header:['v'],headerRow:0,delimiter:',',time:null,columns:{v:{target:'throttle'}}});
  window.setCsvRoot=name=>{storeFiles.set('formats/sample.csvformat.json',new TextEncoder().encode(JSON.stringify(csvPayload(name))));storeFiles.set('formats/calc.json',new TextEncoder().encode(JSON.stringify({version:1,channels:[{key:'test_value',label:name,expr:'speed'}]})))};
  setCsvRoot('A formats');await csvStore.loadCsvFormats(1);window.__laploupe.go('settings');
 })()`);
 await p.waitFor("document.querySelector('[data-testid=calc-open]') && !document.querySelector('[data-testid=calc-open]').disabled");
 await p.click('calc-open');await p.waitFor("document.querySelector('[data-testid=calc-editor]')");
 await p.ev(`(async()=>{
  const storage=await import('/src/services/storageRevision.ts');window.csvOldRoot=storage.getStorageRevision();
  setCsvRoot('B formats');window.holdTextRead='formats/sample.csvformat.json';window.textWaiters=[];
  await storage.trackStorageSelection(()=>{window.folderRoot='/synthetic/B';return '/synthetic/B'});
  window.csvStorageChange=(await import('/src/services/storageCourses.ts')).storageFolderChanged();
 })()`);
 await p.waitFor("!document.querySelector('[data-testid=calc-editor]') && document.querySelector('[data-testid=calc-open]').disabled && window.textWaiters.length>0",10000,'old editor closed and new definitions pending');
 assert.equal(await p.ev("csvStore.saveCalcChannels([{key:'old_value',label:'old',expr:'speed'}],csvOldRoot).then(()=>false,()=>true)"),true,'old editor context cannot write to new root');
 assert.ok(await p.ev("new TextDecoder().decode(storeFiles.get('formats/calc.json')).includes('B formats')"));
 await p.ev('window.holdTextRead=null;window.textWaiters.splice(0).forEach(resolve=>resolve());window.csvStorageChange');
 await p.waitFor("!document.querySelector('[data-testid=calc-open]').disabled && document.querySelector('[data-testid=csv-format-row]').innerText.includes('B formats')",15000,'new root definitions recovered');
 await p.waitFor("document.querySelector('[data-testid=storage-settings]').innerText.includes('/synthetic/B')",10000,'storage label follows current root');
 await p.click('calc-open');
 assert.ok(await p.ev("[...document.querySelectorAll('[data-testid=calc-editor] input')].some(e=>e.value==='B formats')"),'editor uses new root formula');
 await p.ev("document.querySelector('[data-testid=calc-editor] button').click()");
 // 古いLibrary読込みが、新しい明示のCar選択を上書きしない。
 for(const compare of [false,true]){
  await p.ev(`(async()=>{
   const store=await(await import('/src/services/runStore.ts')).getRunStore();
   storeFiles.set('sodegaura/legacy-slow.nmea',storeFiles.get('sodegaura/demo.nmea'));
   const rows=await(await import('/src/services/runOpener.ts')).listRuns(store);
   window.legacyItem=rows.find(r=>r.file==='legacy-slow.nmea');window.holdLegacyRead='sodegaura/legacy-slow.nmea';window.resumeLegacyRead=null;
   window.__laploupe.go('library');void window.__laploupe.openStoredRun(window.legacyItem,${compare});
  })()`);
  await p.waitFor('window.resumeLegacyRead',15000,'held legacy load');
  await p.ev(`(async()=>{window.__laploupe.go('analysis');const s=window.__laploupe.analysisSnapshot().sessions.find(s=>s.laps.length);await window.__laploupe.selectCar(${compare?1:0},s.id,s.laps[0].lapNumber);})()`);
  const manual=await p.ev('JSON.stringify(window.__laploupe.cars)');
  await p.ev('window.holdLegacyRead=null;window.resumeLegacyRead()');await p.waitFor('!window.__laploupe.runBusy');
  assert.equal(await p.ev('JSON.stringify(window.__laploupe.cars)'),manual,'new manual choice wins over late Library read');assert.equal(await p.ev('window.__laploupe.screen'),'analysis');
 }
 // 採用自身がCarを替えても、後続の動画処理の失敗を古い要求と誤認しない。
 const errorNotes=p.notes.length;
 await p.ev(`(async()=>{
  storeFiles.set('sodegaura/post-adopt.nmea',storeFiles.get('sodegaura/demo.nmea'));
  const store=await(await import('/src/services/runStore.ts')).getRunStore();
  const row=(await testRunOpener.listRuns(store)).find(r=>r.file==='post-adopt.nmea');
  row.videos=['missing.mp4'];row.folderVideos=[{path:'sodegaura/missing.mp4',size:8,mtimeMs:0,local:false}];
  window.electronAPI.laps.startDownload=async()=>{throw Error('synthetic post-adoption download failure')};
  void window.__laploupe.openStoredRun(row,false);
 })()`);
 await p.waitFor("[...document.querySelectorAll('[role=dialog] button')].some(b=>!b.disabled&&b.innerText.trim()==='Download')",15000,'post-adoption download choice');
 await p.ev("[...document.querySelectorAll('[role=dialog] button')].find(b=>!b.disabled&&b.innerText.trim()==='Download').click()");await p.waitFor('!window.__laploupe.runBusy');
 assert.ok(p.notes.slice(errorNotes).some(note=>note.includes('Could not open the run: synthetic post-adoption')),'current request reports its post-adoption failure');
 // フォルダの動画ボタンも、保存先選択の取消しで失効したmetadataを公開しない。
 await p.ev(`(async()=>{
  const m=(await import('/src/services/videoSyncManager.ts')).videoSyncManager;for(const t of [...m.getTracks()])m.removeTrack(t.id);
  const owner=testRunOpener.getOpenRun(),bytes=Uint8Array.from(atob(${JSON.stringify(video)}),x=>x.charCodeAt(0));
  window.folderVideoPath=owner.item.folder+'/folder-late.mp4';window.folderVideoUrl=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
  const s=window.__laploupe.analysisSnapshot().sessions.find(s=>s.sourceFile?.file===owner.item.file),mtimeMs=Date.parse(s.points[0].timestamp);
  owner.item.folderVideos=[{path:folderVideoPath,size:bytes.length,mtimeMs,local:true}];owner.store.videoUrl=()=>folderVideoUrl;
  const original=window.fetch.bind(window),Changed=(await import('/src/services/storageRevision.ts')).StorageChangedError;
  window.restoreFolderFetch=()=>window.fetch=original;window.holdFolderVideo=true;
  window.fetch=async(input,options)=>{if(String(input)===folderVideoUrl&&window.holdFolderVideo){window.holdFolderVideo=false;await new Promise(resolve=>window.releaseFolderVideoRead=resolve);throw new Changed();}return original(input,options);};
  window.__laploupe.go('video');
 })()`);
 const folderButton="[...document.querySelectorAll('[data-testid=run-folder-videos] button')].find(b=>b.getClientRects().length>0)";
 await p.waitFor(folderButton,10000,'folder video button');await p.ev(`${folderButton}.click()`);
 await p.waitFor('window.releaseFolderVideoRead',10000,'held folder metadata');
 await p.ev("import('/src/services/storageRevision.ts').then(m=>m.trackStorageSelection(()=>null))");
 await p.ev('window.releaseFolderVideoRead()');await p.waitFor(`!${folderButton}.disabled`,10000,'cancelled folder button becomes available');
 assert.equal(await p.ev("import('/src/services/videoSyncManager.ts').then(({videoSyncManager:m})=>m.getTracks().some(t=>t.remote?.path===folderVideoPath))"),false,'cancelled metadata is not published');
 await p.ev(`${folderButton}.click()`);
 await p.waitFor('window.__laploupe.videos.length>0',10000,'folder video retry');
 const duration=await p.ev("import('/src/services/videoSyncManager.ts').then(({videoSyncManager:m})=>m.getTracks().find(t=>t.remote?.path===folderVideoPath)?.durationSec)");
 assert.ok(duration>3.5&&duration<4.5,'retry reads the real duration');await p.ev('window.restoreFolderFetch()');
 // 解析準備後の再検査を待つ間に設定を変え、旧Gを公開しない。
 for(const compare of [false,true]){
  await p.ev(`(async()=>{
   const physics=await import('/src/services/physics.ts');physics.setGFilterLevel('strong');
   const name=${JSON.stringify('prepared-physics-')}+${compare}+'.nmea';storeFiles.set('sodegaura/'+name,storeFiles.get('sodegaura/demo.nmea'));
   const store=await(await import('/src/services/runStore.ts')).getRunStore();
   const row=(await testRunOpener.listRuns(store)).find(r=>r.file===name);
   const list=window.electronAPI.laps.list;let calls=0;
   window.restorePhysicsList=()=>window.electronAPI.laps.list=list;window.finishPhysicsList=null;
   window.electronAPI.laps.list=async()=>{if(window.__laploupe.openingRun()&&++calls===3)await new Promise(resolve=>window.finishPhysicsList=resolve);return list();};
   window.physicsRunName=name;window.openPhysicsRun=window.__laploupe.openStoredRun(row,${compare});
  })()`);
  await p.waitFor('window.finishPhysicsList',15000,'prepared log awaiting final source validation');
  await p.ev("import('/src/services/physics.ts').then(m=>m.setGFilterLevel('weak'))");
  await p.ev('window.finishPhysicsList();window.openPhysicsRun');
  const physics=await p.ev(`import('/src/services/physics.ts').then(({applyGFilter})=>{
   const pts=window.__laploupe.analysisSnapshot().sessions.find(s=>s.fileName===window.physicsRunName).points,values=p=>p.map(q=>[q.accelG,q.corneringG]);
   return {actual:values(pts),expected:values(applyGFilter(pts.map(p=>({...p})),'weak'))};
  })`);
  assert.deepEqual(physics.actual,physics.expected,'staged adoption uses latest G settings');
  const lapPhysics=await p.ev(`import('/src/engine/lapCalculator.ts').then(({extractLaps})=>{
   const s=window.__laploupe.analysisSnapshot().sessions.find(s=>s.fileName===window.physicsRunName),expected=extractLaps(s.points,s.controlLine,s.sectors,s.finishLine).laps;
   return {actual:s.laps.map(l=>l.points.map(p=>[p.accelG,p.corneringG])),expected:expected.map(l=>l.points.map(p=>[p.accelG,p.corneringG]))};
  })`);
  assert.deepEqual(lapPhysics.actual,lapPhysics.expected,'lap consumers receive the updated physics too');
  await p.ev('window.restorePhysicsList()');
 }
 // Carが同じでも、File入力とElectronメニューの両方を古い復元で落とさない。
 for(const source of ['local','menu']){
 await p.ev(`(async()=>{
  const state=window.__laploupe.analysisSnapshot();if(state.selectedCars.length<2)throw Error('requires two selected cars');
  const cars=state.selectedCars.slice(0,2).map(c=>{const s=state.sessions.find(s=>s.id===c.sessionId),f=s.sourceFile;return {slot:c.slot,run:f.folder+'/'+f.file,part:f.part,lap:c.lapNumber};});
  storeFiles.set('sessions/input-race.lapsession.json',new TextEncoder().encode(JSON.stringify({version:1,name:'Input race',createdAt:'2025-01-01T00:00:00Z',cars})));
  window.__laploupe.go('library');
 })()`);
 await p.waitFor("[...document.querySelectorAll('[data-testid=library-session-row] button')].some(b=>b.innerText.includes('Input race'))",15000,'saved input comparison');
 await p.ev(`(()=>{const list=window.electronAPI.laps.list;let calls=0;window.finishInputValidation=null;window.restoreInputList=()=>window.electronAPI.laps.list=list;
  window.electronAPI.laps.list=async()=>{if(window.__laploupe.openingSaved()&&++calls===6)await new Promise(resolve=>window.finishInputValidation=resolve);return list();};
  [...document.querySelectorAll('[data-testid=library-session-row] button')].find(b=>b.innerText.includes('Input race')).click();
 })()`);
 await p.waitFor('window.finishInputValidation',15000,'final two-car comparison validation');
 const carsBeforeInput=await p.ev('JSON.stringify(window.__laploupe.cars)');
 const inputName=source==='local'?'new-local-input.nmea':'new-menu-input.nmea';
 if(source==='local'){
  await p.ev("window.newLocalInput=window.__laploupe.loadFiles([new File([storeFiles.get('sodegaura/demo.nmea')],'new-local-input.nmea')]);void 0");
  await p.waitFor("window.__laploupe.sessions.some(s=>s.fileName==='new-local-input.nmea')||document.querySelector('[data-testid=import-open-only]')",15000,'new local input');
  if(await p.ev("!!document.querySelector('[data-testid=import-open-only]')"))await p.click('import-open-only');
 }else await p.ev("window.menuOpenFiles(['/synthetic/new-menu-input.nmea'])");
 await p.waitFor(`window.__laploupe.sessions.some(s=>s.fileName===${JSON.stringify(inputName)})`);
 assert.equal(await p.ev('JSON.stringify(window.__laploupe.cars)'),carsBeforeInput,'new unassigned log leaves existing cars unchanged');
 await p.ev('window.finishInputValidation()');await p.waitFor('!window.__laploupe.openingSaved()');
 assert.equal(await p.ev(`window.__laploupe.sessions.some(s=>s.fileName===${JSON.stringify(inputName)})`),true,'old comparison cannot discard newer accepted input');
 await p.ev('window.restoreInputList()');
 }
 // 保存した比較の最終検査中に手動補正しても、古い控えへ戻さない。
 await p.ev(`(async()=>{
  const state=window.__laploupe.analysisSnapshot(),s=state.sessions.find(s=>s.id===state.selectedCars.find(c=>c.slot===0).sessionId),f=s.sourceFile;
  window.clockRestoreId=s.id;window.clockBeforeRestore=s.clockOffsetSec??0;
  const saved={version:1,name:'Clock race',createdAt:'2025-01-01T00:00:00Z',cars:[{slot:0,run:f.folder+'/'+f.file,part:f.part,lap:s.laps[0].lapNumber}]};
  storeFiles.set('sessions/clock-race.lapsession.json',new TextEncoder().encode(JSON.stringify(saved)));
  window.__laploupe.go('library');
 })()`);
 await p.waitFor("[...document.querySelectorAll('[data-testid=library-session-row] button')].some(b=>b.innerText.includes('Clock race'))",15000,'saved clock comparison');
 await p.ev(`(()=>{const list=window.electronAPI.laps.list;let calls=0;window.finishClockValidation=null;window.restoreClockList=()=>window.electronAPI.laps.list=list;
  window.electronAPI.laps.list=async()=>{if(window.__laploupe.openingSaved()&&++calls===4)await new Promise(resolve=>window.finishClockValidation=resolve);return list();};
  const button=[...document.querySelectorAll('[data-testid=library-session-row] button')].find(b=>b.innerText.includes('Clock race'));button.click();button.click();
 })()`);
 await p.waitFor('window.finishClockValidation',15000,'final saved comparison validation');
 await p.ev("window.__laploupe.go('analysis')");
 await p.waitFor("document.querySelector('[data-testid=toggle-data-drawer]')",10000,'analysis drawer toggle');
 if(!await p.ev("!!document.querySelector('[data-testid=data-drawer]')?.getClientRects().length"))await p.click('toggle-data-drawer');
 await p.waitFor("document.querySelector('[data-testid=data-drawer]')",10000,'clock edit drawer');
 await p.ev(`(()=>{const i=window.__laploupe.sessions.findIndex(s=>s.id===window.clockRestoreId),card=document.querySelectorAll('[data-testid=session-card]')[i],e=card.querySelector('input[type=number][step="0.01"]');
  window.expectedRestoredClock=window.clockBeforeRestore+2.125;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,String(window.expectedRestoredClock));e.dispatchEvent(new Event('input',{bubbles:true}));
 })()`);
 await p.waitFor('window.__laploupe.analysisSnapshot().sessions.find(s=>s.id===window.clockRestoreId)?.clockOffsetSec===window.expectedRestoredClock');
 await p.ev('window.finishClockValidation()');await p.waitFor('!window.__laploupe.openingSaved()');
 assert.equal(await p.ev('window.__laploupe.analysisSnapshot().sessions.find(s=>s.id===window.clockRestoreId).clockOffsetSec'),await p.ev('window.expectedRestoredClock'),'late comparison cannot revert a newer clock edit');
 assert.equal(await p.ev('window.__laploupe.sessions.length'),1,'ignored duplicate click still completes the first comparison');
 await p.ev('window.restoreClockList()');
 // 公開の差し込み口に小さなボタンを置き、両方開くの実コールバックを通す。
 await p.ev(`(async()=>{
  await testRunOpener.flushOpenRunsStrict();
  const {addons}=await import('/src/addons/index.ts'),React=(await import('/node_modules/.vite/deps/react.js')).default;
  addons.sameRunViews=[{id:'fixture',label:['確認','Inspect'],Component:({onOpenBoth})=>React.createElement('button',{'data-testid':'fixture-open-both',onClick:()=>{window.openBothPromise=onOpenBoth();}},'Open both')}];
  storeFiles.set('sodegaura/20260815/20260815092455.nmea',storeFiles.get('sodegaura/demo.nmea'));
  window.bothFileInput=window.__laploupe.loadFiles([new File([storeFiles.get('sodegaura/demo.nmea')],'open-both-input.nmea')]);
 })()`);
 await p.waitFor("document.querySelector('[data-testid=import-view-fixture]')",15000,'input comparison fixture');
 await p.click('import-view-fixture');await p.waitFor("document.querySelector('[data-testid=fixture-open-both]')");
 await p.ev("window.folderWaiters=[];window.holdFolder=true;document.querySelector('[data-testid=fixture-open-both]').click()");
 await p.waitFor('window.folderWaiters.length>0',10000,'open both before stored selection');
 await p.click('open-lap-picker');
 await p.waitFor("document.querySelector('[data-testid=lap-picker-row] [data-slot=\"0\"]')");
 await p.ev("[...document.querySelectorAll('[data-testid=lap-picker-row] [data-slot=\"0\"]')].find(b=>!b.className.includes('border-cyan')).click()");
 await assigned(0);await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 const pickedAfterBoth=await p.ev('JSON.stringify(window.__laploupe.cars)');
 await p.ev('window.holdFolder=false;window.folderWaiters.splice(0).forEach(resolve=>resolve());window.openBothPromise');
 assert.equal(await p.ev('JSON.stringify(window.__laploupe.cars)'),pickedAfterBoth,'old OpenBoth cannot replace a newer Picker selection');
 assert.equal(await p.ev("window.__laploupe.sessions.some(s=>s.fileName==='open-both-input.nmea')"),false);
 // 一覧のmetadata I/O失敗がcoldな走行の同期時計を消すことはない。
 await p.ev(`(async()=>{
  await testRunOpener.flushOpenRunsStrict();
  storeFiles.set('sodegaura/cold-metadata.nmea',storeFiles.get('sodegaura/demo.nmea'));
  const path='sodegaura/runs.json',saved=JSON.parse(new TextDecoder().decode(storeFiles.get(path)));
  saved.runs['cold-metadata']={updatedAt:'',parts:{'1':{clockOffsetSec:6.25}}};storeFiles.set(path,new TextEncoder().encode(JSON.stringify(saved)));
  window.coldMetadataOriginal=new TextDecoder().decode(storeFiles.get(path));window.failListedRunsMetadata=true;
  const store=await(await import('/src/services/runStore.ts')).getRunStore();
  window.coldMetadataRow=(await testRunOpener.listRuns(store)).find(row=>row.file==='cold-metadata.nmea');
 })()`);
 assert.equal(await p.ev('window.coldMetadataRow.entry'),null,'tolerant listing could not read the row');
 await p.ev('window.__laploupe.openStoredRun(window.coldMetadataRow,false)');
 assert.equal(await p.ev("window.__laploupe.sessions.some(s=>s.fileName==='cold-metadata.nmea')"),false,'unread metadata cannot acquire a save owner');
 assert.equal(await p.ev("new TextDecoder().decode(storeFiles.get('sodegaura/runs.json'))"),await p.ev('window.coldMetadataOriginal'));
 await p.ev('window.failListedRunsMetadata=false;window.__laploupe.openStoredRun(window.coldMetadataRow,false)');
 await p.waitFor("window.__laploupe.sessions.some(s=>s.fileName==='cold-metadata.nmea')");
 assert.equal(await p.ev("window.__laploupe.analysisSnapshot().sessions.find(s=>s.fileName==='cold-metadata.nmea').clockOffsetSec"),6.25,'retry restores the saved log correction');
 await p.ev('testRunOpener.flushOpenRunsStrict()');
 assert.equal(await p.ev("JSON.parse(new TextDecoder().decode(storeFiles.get('sodegaura/runs.json'))).runs['cold-metadata'].parts['1'].clockOffsetSec"),6.25);
 // 履歴のクリック順と、閉じた履歴からの遅い応答を通す。
 await p.ev("for(const name of ['history-a.nmea','history-b.nmea'])storeFiles.set('sodegaura/'+name,storeFiles.get('sodegaura/demo.nmea'))");
 const historyButton=name=>`[...document.querySelectorAll('[data-testid=lap-history-open]')].find(button=>[...button.parentElement.querySelectorAll('span')].some(span=>span.textContent===${JSON.stringify(name)}))`;
 const openHistory=async()=>{
  await p.ev("window.__laploupe.go('analysis')");await p.waitFor("document.querySelector('[data-testid=toggle-data-drawer]')");
  if(!await p.ev("!!document.querySelector('[data-testid=data-drawer]')?.getClientRects().length"))await p.click('toggle-data-drawer');
  await p.click('open-lap-history');await p.waitFor(historyButton('history-b.nmea'),15000,'two readable history runs');
 };
 await openHistory();
 await p.ev(`window.holdHistoryRead='sodegaura/history-a.nmea';window.resumeHistoryRead=null;${historyButton('history-a.nmea')}.click()`);
 await p.waitFor('window.resumeHistoryRead');await p.ev(`${historyButton('history-b.nmea')}.click()`);
 await p.waitFor("!window.__laploupe.openingRun()&&window.__laploupe.sessions.some(s=>s.fileName==='history-b.nmea')",15000,'newer history B accepted');
 const historyB=await p.ev('JSON.stringify(window.__laploupe.analysisSnapshot())');
 await p.ev('window.holdHistoryRead=null;window.resumeHistoryRead();new Promise(resolve=>setTimeout(resolve,0))');
 assert.equal(await p.ev('JSON.stringify(window.__laploupe.analysisSnapshot())'),historyB,'late A cannot replace B');
 await openHistory();
 await p.ev(`window.holdHistoryRead='sodegaura/history-a.nmea';window.resumeHistoryRead=null;${historyButton('history-a.nmea')}.click()`);
 await p.waitFor('window.resumeHistoryRead');
 await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 const closedHistory=await p.ev('JSON.stringify(window.__laploupe.analysisSnapshot())');
 await p.ev('window.holdHistoryRead=null;window.resumeHistoryRead();new Promise(resolve=>setTimeout(resolve,0))');
 assert.equal(await p.ev('JSON.stringify(window.__laploupe.analysisSnapshot())'),closedHistory,'closed history cannot reopen its late read');
 assert.deepEqual(p.errors,[]);
 await p.shot('preserved');console.log(JSON.stringify({result:'PASS interrupted run-list and legacy history scans; repeated stored picks and pending attachment; valid IMU fixture; cancel retains ownership; failed save blocks folder switch; non-best saved lap; failed-save companion promotion; pending metadata, overlapping saved restore, same-source delayed earlier-lap first renders',writes:await p.ev('window.storeWrites.length'),errors:p.errors}));
}catch(error){console.log(await p.ev("({body:document.body.innerText,reads:storeReads.slice(-12),indexes:window.indexWrites?.map(x=>Object.keys(x.files))})"),p.errors);throw error;}finally{await p.close();fs.rmSync(fixtureDir,{recursive:true,force:true});}
