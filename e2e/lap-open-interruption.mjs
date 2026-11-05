import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Page} from './cdp.mjs';
// 合成 Native と同梱ログだけ。動画窓口の応答を止め、保存先選択の取消と交差させる。
const url=new URL(process.env.E2E_URL ?? 'http://127.0.0.1:5173/');
assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
url.searchParams.set('native','mock');
url.searchParams.set('mockVideoBase',`http://localhost:${url.port}/`);
const port=Number(process.env.E2E_CDP_PORT);assert.ok(port>0);
const outDir=fileURLToPath(new URL('./out/lap-open-interruption/',import.meta.url));fs.mkdirSync(outDir,{recursive:true});
const p=await Page.connect(port,{newTab:true,label:'open-interruption',outDir});
try {
 await p.viewport(1280,800,false);
 await p.send('Page.addScriptToEvaluateOnNewDocument',{source:`
 let webkit;
 window.rootReplies=[];
 Object.defineProperty(window,'webkit',{configurable:true,get:()=>webkit,set:value=>{
   webkit=value;
   const sink=value?.messageHandlers?.dsNative;if(!sink)return;
   const post=sink.postMessage.bind(sink);
   sink.postMessage=message=>{if(JSON.parse(message).method==='system.runRoot')rootReplies.push(()=>post(message));else post(message);};
 }});
 `});
 for(const cancelFirst of [false,true]) {
  await p.goto(url.href);await p.waitFor('window.__laploupe && window.__dsMockNative');
  await p.ev(`(async()=>{
   const bridge=await import('/src/native/bridge.ts');window.testBridge=bridge;
   // 既存 Native mock の一覧は base64 文字数を返すので、実際のバイト数へ合わせる。
   const receive=window.dsNative.receive;
   window.dsNative.receive=message=>{const r=JSON.parse(message);if(r.result?.files)for(const f of r.result.files)if(f.path==='sodegaura/demo.nmea')f.size=window.fixtureSize;receive(JSON.stringify(r));};
   window.testStorage=await import('/src/services/storageRevision.ts');
   window.testRunOpener=await import('/src/services/runOpener.ts');
   (await import('/src/utils/i18n.ts')).setLang('en');
   const b=new Uint8Array(await(await fetch('/demo/sodegaura_20260815.nmea')).arrayBuffer());
   window.fixtureSize=b.byteLength;await bridge.callNative('system.writeRunFile',{path:'sodegaura/demo.nmea',b64:bridge.toBase64(b)});
   window.__laploupe.go('library');(await import('/src/services/runsChanged.ts')).notifyRunsChanged();
  })()`);
  await p.waitFor("document.querySelector('[data-testid=run-row]')",15000,'synthetic run');
  await p.click('run-row');await p.waitFor("document.querySelector('[data-testid=run-open-analysis]')");await p.click('run-open-analysis');
  await p.waitFor('window.__laploupe.cars.length===1 && window.rootReplies.length>0',15000,'logs ready before video owner');
  assert.equal(await p.ev('!!window.testRunOpener.getOpenRun()'),false);
  const revision=await p.ev('window.testStorage.getStorageRevision()');
  await p.ev('window.selection=window.testStorage.trackStorageSelection(()=>new Promise(resolve=>window.cancelSelection=()=>resolve(null)));void 0');
  await p.waitFor('window.testStorage.isStorageSelectionPending()');
  if(cancelFirst)await p.ev('window.cancelSelection();window.selection');
  await p.ev('window.rootReplies.splice(0).forEach(reply=>reply())');
  // 呼出し元の finally が終わってから、保管場所の取消を完了する順序も確認する。
  await p.waitFor('!window.__laploupe.runBusy',5000,'open completion');
  if(!cancelFirst)await p.ev('window.cancelSelection();window.selection');
  await p.waitFor("window.testRunOpener.getOpenRun()?.item.file==='demo.nmea'",6000,'reattached save owner after cancel');
  assert.equal(await p.ev('window.testStorage.getStorageRevision()'),revision);
  assert.equal(await p.ev('window.__laploupe.cars.length'),1);
  // 復帰した担当が、後から行ったログ時計の編集を実際に保存できる。
  await p.click('toggle-data-drawer');
  await p.ev(`(()=>{const e=document.querySelector('[data-testid=data-drawer] input[type=number][step="0.01"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'3.25');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await p.ev('window.testRunOpener.flushOpenRunsStrict()');
  const saved=await p.ev("testBridge.callNative('system.readRunFile',{path:'sodegaura/runs.json'}).then(r=>new TextDecoder().decode(testBridge.fromBase64(r.b64)))");
  assert.ok(saved.includes('3.25'),'resumed owner persists clock edit');
  assert.deepEqual(p.errors,[]);
 }
 console.log(JSON.stringify({result:'PASS interrupted legacy open retries owner after cancel before/after video reply; later clock edit persisted',errors:p.errors}));
} catch(error) { console.log(p.notes,p.errors,await p.state());console.log(await p.ev('({body:document.body.innerText,requests:window.__dsMockNative.requests.map(r=>r.method)})'));throw error; } finally {await p.close();}
