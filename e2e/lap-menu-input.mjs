// Electronのメニューイベントだけを模擬し、公開ログと専用Chromeを使う。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Page} from './cdp.mjs';

const url=new URL(process.env.E2E_URL??'http://127.0.0.1:5173/');
const port=Number(process.env.E2E_CDP_PORT);
assert(['localhost','127.0.0.1'].includes(url.hostname)&&port>0);
const outDir=fileURLToPath(new URL('./out/lap-menu-input/',import.meta.url));
fs.mkdirSync(outDir,{recursive:true});
const page=await Page.connect(port,{newTab:true,label:'menu-input',outDir});
try{
 await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`
  window.electronAPI={
   laps:{getFolder:async()=>null,pickFolder:async()=>null},
   onOpenFiles:callback=>{window.openMenuFiles=callback;return()=>{window.openMenuFiles=null;}},
   readFileBuffer:async path=>{
    if(path.endsWith('older.nmea'))await new Promise(resolve=>window.finishOlderMenu=resolve);
    return {success:true,name:path.slice(path.lastIndexOf('/')+1),dataArray:window.menuFixture};
   }
  };
 `});
 await page.goto(url.href);
 await page.waitFor('window.__laploupe&&window.openMenuFiles');
 await page.ev(`(async()=>{
  window.menuFixture=new Uint8Array(await(await fetch('/demo/sodegaura_20260815.nmea')).arrayBuffer());
  await window.openMenuFiles(['/synthetic/a.nmea','/synthetic/b.nmea']);
 })()`);
 await page.waitFor('window.__laploupe.sessions.length===2&&window.__laploupe.cars.length===2');
 const cars=await page.ev('JSON.stringify(window.__laploupe.cars)');
 await page.ev("window.olderMenu=window.openMenuFiles(['/synthetic/older.nmea']);void 0");
 await page.waitFor('window.finishOlderMenu');
 await page.ev("window.__laploupe.loadFiles([new File([window.menuFixture],'newer.nmea')])");
 await page.waitFor("window.__laploupe.sessions.some(s=>s.fileName==='newer.nmea')");
 await page.ev('window.finishOlderMenu();window.olderMenu');
 assert.equal(await page.ev('JSON.stringify(window.__laploupe.cars)'),cars);
 assert.equal(await page.ev("window.__laploupe.sessions.some(s=>s.fileName==='older.nmea')"),false);
 assert.equal(await page.ev('window.__laploupe.sessions.length'),3);
 assert.deepEqual(page.errors,[]);
 console.log('PASS menu input starts before IO; newer local input wins with unchanged Cars');
}finally{await page.close();}
