// ローカルの合成ログ/動画と専用Chromeだけを使用。実際の保管場所には接続しない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Page} from './cdp.mjs';
const url=new URL(process.env.E2E_URL??'http://127.0.0.1:5173/'),port=Number(process.env.E2E_CDP_PORT);
assert(['localhost','127.0.0.1'].includes(url.hostname)&&port>0);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'laploupe-origin-'));
const log=path.join(dir,'origin.gpx'),video=path.join(dir,'origin.mp4');
const points=Array.from({length:120},(_,sec)=>`<trkpt lat="${35.39486+0.0005*Math.sin(sec*Math.PI/20)}" lon="${140.08803+0.0005*Math.cos(sec*Math.PI/20)}"><time>${new Date(Date.UTC(2025,0,1)+sec*1000).toISOString()}</time></trkpt>`);
fs.writeFileSync(log,`<gpx><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`);
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=10','-t','20','-c:v','libx264','-pix_fmt','yuv420p','-metadata','creation_time=2025-01-01T00:00:10Z',video]);
const outDir=fileURLToPath(new URL('./out/lap-video-origin/',import.meta.url));fs.mkdirSync(outDir,{recursive:true});
const p=await Page.connect(port,{newTab:true,label:'origin',outDir});
try{
 await p.goto(url.href);await p.waitFor('window.__laploupe');
 await p.ev("import('/src/utils/i18n.ts').then(m=>m.setLang('en'))");
 await p.setFiles('[data-testid=log-file-input]',[log]);await p.waitFor('window.__laploupe.sessions.length===1 && window.__laploupe.cars.length===1');
 await p.ev("window.__laploupe.go('video')");await p.waitFor("[...document.querySelectorAll('[data-testid=video-window]')].some(e=>e.offsetParent!==null)");
 await p.ev("[...document.querySelectorAll('[data-testid=video-window]')].find(e=>e.offsetParent!==null).setAttribute('data-origin-test','true')");
 await p.setFiles('[data-origin-test] input[type=file][accept*="video/mp4"]',[video]);await p.waitFor('window.__laploupe.videos.length===1');
 await p.ev('window.__laploupe.clearCar(0)');await p.waitFor('window.__laploupe.cars.length===0 && window.__laploupe.sessions.length===1');
 assert.equal((await p.state()).videos[0].syncOffsetSec,0);
 await p.waitFor("document.querySelector('[data-origin-test] video')?.readyState>=2",10000,'synthetic video is decoded');
 assert.equal(await p.ev("document.querySelector('[data-origin-test]').innerText.includes('No footage at this time')"),false);
 await p.ev("document.activeElement?.blur();document.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}))");
 await p.waitFor('window.__laploupe.sessionTimeSec>1',5000,'video-only origin advances');
 const state=await p.ev("({app:window.__laploupe.sessionTimeSec,video:document.querySelector('[data-origin-test] video').currentTime,range:Number(document.querySelector('[data-origin-test] input[type=range]').max),noFootage:document.querySelector('[data-origin-test]').innerText.includes('No footage at this time')})");
 assert(Math.abs(state.app-state.video)<0.7,JSON.stringify(state));assert(Math.abs(state.range-20)<0.2,JSON.stringify(state));assert.equal(state.noFootage,false);assert.deepEqual(p.errors,[]);
 await p.shot('video-only');console.log('PASS cleared final Car: App and local video share the video-only origin');
}finally{await p.close();fs.rmSync(dir,{recursive:true,force:true});}
