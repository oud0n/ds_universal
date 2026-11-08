import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Page} from './cdp.mjs';
// 専用Chromeと開発サーバー。保管場所はメモリ内、ログは公開デモの複製だけ。
const url = new URL(process.env.E2E_URL ?? 'http://127.0.0.1:5382/');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
const port = Number(process.env.E2E_CDP_PORT); assert.ok(port > 0);
const outDir = fileURLToPath(new URL('./out/library-admission/', import.meta.url)); fs.mkdirSync(outDir, {recursive: true});
const p = await Page.connect(port, {newTab: true, label: 'admission', outDir});
const dialog = "document.querySelector('[data-testid=library-admission-dialog]')";
const choose = text => p.ev(`(()=>{const buttons=[...${dialog}.querySelectorAll('button')];buttons.find(b=>b.textContent===${JSON.stringify(text)}).click();})()`);
try {
 await p.send('Page.addScriptToEvaluateOnNewDocument', {source: `
 window.storeFiles=new Map();window.storeWrites=[];window.failWrites=false;
 window.electronAPI={laps:{remove:async()=>{throw Error('preview must not delete files')},getFolder:async()=>'/synthetic/admission',pickFolder:async()=>null,
 list:async()=>{if(window.holdListing)await new Promise(resolve=>(window.finishListing??=[]).push(resolve));return {success:true,files:[...storeFiles].map(([path,b])=>({path,size:b.length,mtimeMs:1,local:true}))}},
 read:async path=>({success:true,data:storeFiles.get(path)}),
 readText:async path=>({success:true,text:storeFiles.has(path)?new TextDecoder().decode(storeFiles.get(path)):null}),
 writeText:async(path,text)=>{if(window.failWrites)return {success:false,error:'synthetic write failure'};storeWrites.push(path);storeFiles.set(path,new TextEncoder().encode(text));if(window.holdReloadAfterWrite)window.holdListing=true;return {success:true}}
 }};
 `});
 await p.goto(url.href);
 await p.ev(`import('/src/utils/i18n.ts').then(m=>m.setLang('en'))`);
 await p.ev(`(async()=>{const b=new Uint8Array(await(await fetch('/demo/sodegaura_20260815.nmea')).arrayBuffer());storeFiles.set('sodegaura/a.nmea',b);storeFiles.set('sodegaura/z.nmea',b);window.__laploupe.go('library');(await import('/src/services/runsChanged.ts')).notifyRunsChanged();})()`);
 await p.waitFor(dialog);
 assert.equal(await p.ev("document.querySelectorAll('[data-testid=run-row]').length"),1);
 assert.equal(await p.ev(`document.activeElement.textContent`),'Later');
 await p.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape'});
 await p.waitFor(`!${dialog}`);
 assert.equal(await p.ev("storeWrites.some(path=>path.endsWith('runs.json'))"),false);
 await p.click('library-review-pending');
 await p.ev('window.failWrites=true'); await choose('Skip');
 await p.waitFor(`${dialog}?.querySelector('[role=alert]')`);
 assert.equal(await p.ev("storeWrites.some(path=>path.endsWith('runs.json'))"),false);
 await p.ev('window.failWrites=false'); await choose('Skip');
 await p.waitFor(`!${dialog}`); await p.waitFor("document.querySelector('[data-testid=library-review-excluded]')");
 await p.ev("window.__laploupe.go('analysis');window.__laploupe.go('library');import('/src/services/runsChanged.ts').then(m=>m.notifyRunsChanged())");
 await p.waitFor("document.querySelector('[data-testid=library-review-excluded]')");
 assert.equal(await p.ev(`!!${dialog}`),false);
 await p.click('library-review-excluded'); await p.clickText('Add');
 await p.waitFor(dialog); await p.ev('window.holdReloadAfterWrite=true'); await choose('Add');
 await p.waitFor(`!${dialog}`);
 await p.waitFor('window.finishListing?.length>0');
 await p.ev('window.holdReloadAfterWrite=false;window.holdListing=false;window.finishListing.splice(0).forEach(resolve=>resolve())');
 await p.waitFor("document.querySelectorAll('[data-testid=run-row]').length===2");
 await p.waitFor(`!${dialog}`);
 assert.ok(await p.ev("Object.values(JSON.parse(new TextDecoder().decode(storeFiles.get('sodegaura/runs.json'))).runs).some(r=>r.libraryDecision?.include===true)"));
 // 確認待ち・除外のログも、動画を消す判定では所有者として保護する。
 await p.ev(`(async()=>{
  const data=storeFiles.get('sodegaura/a.nmea');storeFiles.set('sodegaura/a_2.bnx4',data);
  storeFiles.set('sodegaura/a_2.mov',new Uint8Array(8));storeFiles.set('sodegaura/shared.mp4',new Uint8Array(8));
  const ix=JSON.parse(new TextDecoder().decode(storeFiles.get('sodegaura/laptimes.json')));ix.files['a_2.bnx4']={...ix.files['a.nmea']};storeFiles.set('sodegaura/laptimes.json',new TextEncoder().encode(JSON.stringify(ix)));
  const meta=JSON.parse(new TextDecoder().decode(storeFiles.get('sodegaura/runs.json')));
  meta.runs.a={updatedAt:'',name:'Delete target',videos:[{name:'shared.mp4'}]};
  meta.runs['a_2.bnx4']={updatedAt:'',videos:[{name:'shared.mp4'}],libraryDecision:{file:'a_2.bnx4',size:data.length,mtimeMs:1,include:false}};
  storeFiles.set('sodegaura/runs.json',new TextEncoder().encode(JSON.stringify(meta)));
  (await import('/src/services/runsChanged.ts')).notifyRunsChanged();
 })()`);
 await p.waitFor("[...document.querySelectorAll('[data-testid=run-row]')].some(r=>r.textContent.includes('Delete target'))");
 await p.ev("[...document.querySelectorAll('[data-testid=run-row]')].find(r=>r.textContent.includes('Delete target')).click()");
 await p.click('run-delete');
 await p.waitFor("document.querySelector('[data-testid=run-delete-keep]')?.textContent.includes('shared.mp4')");
 assert.ok(await p.ev("document.querySelector('[data-testid=run-delete-keep]').textContent.includes('a_2.mov')"));
 assert.ok(await p.ev("!document.querySelector('[data-testid=run-delete-remove]')?.textContent.includes('a_2.mov')"));
 await p.click('run-delete-cancel');
 assert.deepEqual(p.errors,[]);
 console.log('PASS synthetic library: overlap dialog, Escape, failed save, Skip, persisted exclusion, reconsider Add and skipped-run video protection');
} finally {await p.close();}
