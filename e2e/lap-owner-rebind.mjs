import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Page} from './cdp.mjs';
// 合成の分割ログとメモリ内の保存先だけ。一部を閉じて選び直した後も全パートの時計を保存する。
const url=new URL(process.env.E2E_URL ?? 'http://127.0.0.1:5173/');
assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
const port=Number(process.env.E2E_CDP_PORT);assert.ok(port>0);
const outDir=fileURLToPath(new URL('./out/lap-owner-rebind/',import.meta.url));fs.mkdirSync(outDir,{recursive:true});
const p=await Page.connect(port,{newTab:true,label:'owner-rebind',outDir});
try {
 await p.viewport(375,812,true);
 await p.send('Page.addScriptToEvaluateOnNewDocument',{source:`
 window.storeFiles=new Map();
 window.electronAPI={laps:{getFolder:async()=>'/synthetic/rebind',pickFolder:async()=>null,
 list:async()=>({success:true,files:[...storeFiles].map(([path,b])=>({path,size:b.byteLength,mtimeMs:123,local:true}))}),
 read:async path=>storeFiles.has(path)?{success:true,data:storeFiles.get(path)}:{success:false,error:'not found'},
 readText:async path=>window.failDefinitions&&path.startsWith('formats/')?{success:false,error:'synthetic definition read failure'}:{success:true,text:storeFiles.has(path)?new TextDecoder().decode(storeFiles.get(path)):null},
 writeText:async(path,text)=>{storeFiles.set(path,new TextEncoder().encode(text));return {success:true}}
 }};`});
 await p.goto(url.href);await p.waitFor('window.__laploupe');
 await p.ev(`(async()=>{
 (await import('/src/utils/i18n.ts')).setLang('en');
 window.testRunOpener=await import('/src/services/runOpener.ts');
 const text=await(await fetch('/demo/sodegaura_20260815.nmea')).text();
 const lines=text.trim().split(/\\r?\\n/).map(x=>x.split('*')[0]);
 const later=lines.map(line=>{const a=line.split(',');a[1]=String(Number(a[1].slice(0,2))+1).padStart(2,'0')+a[1].slice(2);return a.join(',')});
 storeFiles.set('sodegaura/split.nmea',new TextEncoder().encode([...lines,...later].join(String.fromCharCode(10))));
 storeFiles.set('sodegaura/runs.json',new TextEncoder().encode(JSON.stringify({version:2,runs:{'split':{updatedAt:'2026-01-01T00:00:00Z',parts:{'1':{clockOffsetSec:1.25},'2':{clockOffsetSec:2.5}},videos:[{name:'split.mp4'}]}}})));
 const definition={version:1,id:'user:sample',name:'sample',kind:'sensor',sensorKey:'sample',header:['time','v'],headerRow:0,delimiter:',',time:{column:'time',as:'seconds'},columns:{v:{target:'throttle'}}};
 storeFiles.set('formats/sample.csvformat.json',new TextEncoder().encode(JSON.stringify(definition)));
 storeFiles.set('sodegaura/split.sample.csv',new TextEncoder().encode(['time,v',...Array.from({length:2000},(_,i)=>i+',37')].join(String.fromCharCode(10))));
 window.failDefinitions=true;await(await import('/src/services/csvFormatStore.ts')).loadCsvFormats(1);
 window.__laploupe.go('analysis');
 })()`);
 const pick=async()=>{
  await p.click('open-lap-picker');
  if(await p.ev("[...document.querySelectorAll('button')].some(b=>b.textContent==='Stored runs')"))await p.clickText('Stored runs');
  await p.waitFor("document.querySelector('[data-testid=lap-picker-row] [data-slot=\"0\"]')",20000,'split lap');
  await p.ev("document.querySelector('[data-testid=lap-picker-row] [data-slot=\"0\"]').click()");
  await p.waitFor("document.querySelector('[role=status]')?.textContent.includes('Assigned ')",15000,'assigned split lap');
  await p.ev("document.querySelector('[role=dialog] button[aria-label=Close]').click()");
 };
 await pick();
 await p.waitFor("testRunOpener.getOpenRun()?.item.file==='split.nmea'",10000,'split owner');
 assert.equal(await p.ev('window.__laploupe.sessions.length'),2);
 await p.ev("window.failDefinitions=false;import('/src/services/csvFormatStore.ts').then(m=>m.loadCsvFormats(1))");
 if(!process.env.E2E_SKIP_SENSOR_RECOVERY) await p.waitFor('window.__laploupe.pointsOf(0).throttle.some(v=>v===37)',10000,'sidecar recovers after ordinary definition failure without reopening');
 await p.ev('window.oldIds=window.__laploupe.analysisSnapshot().sessions.map(s=>s.id)');
 await p.click('toggle-data-drawer');
 await p.ev("[...document.querySelectorAll('button[title=\"Delete session\"]')][1].click()");
 await p.waitFor('window.__laploupe.sessions.length===1');
 await p.click('data-drawer-close');
 await pick();
 await p.waitFor('window.__laploupe.sessions.length===2');
 assert.ok(await p.ev('window.__laploupe.analysisSnapshot().sessions[1].id!==oldIds[1]'),'reopened part receives a fresh ID');
 await p.waitFor("window.__laploupe.analysisSnapshot().sessions[1].clockOffsetSec===2.5",5000,'saved second-part clock restored');
 await p.click('toggle-data-drawer');
 await p.ev(`(()=>{const e=[...document.querySelectorAll('[data-testid=data-drawer] input[type=number][step="0.01"]')][1];if(!e)throw Error('part2 clock input missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'4.75');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await p.ev('testRunOpener.flushOpenRunsStrict()');
 assert.equal(await p.ev("JSON.parse(new TextDecoder().decode(storeFiles.get('sodegaura/runs.json'))).runs['split'].parts['2'].clockOffsetSec"),4.75,'rebound owner persists edits to the correct part');
 assert.equal(p.errors.length,0,p.errors.join('\n'));
 console.log('PASS split owner rebind: fresh ID, restored clock, second-part edit persisted');
} catch(error) {console.log(JSON.stringify(await p.ev(`({sessions:window.__laploupe.analysisSnapshot().sessions.map(s=>({id:s.id,part:s.sourceFile?.part,clock:s.clockOffsetSec})),owner:testRunOpener.getOpenRun()?.item.entry,ids:window.oldIds,matches:testRunOpener.currentRunMatches?.('sodegaura/split.nmea',window.__laploupe.analysisSnapshot().sessions.map(s=>s.id)),disk:JSON.parse(new TextDecoder().decode(storeFiles.get('sodegaura/runs.json')))})`),null,2));throw error;} finally {await p.close();}
