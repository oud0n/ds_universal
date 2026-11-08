const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installUsbHost } = require('./usb-ipc.cjs');
function deferred() { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; }
function setup(packaged=false) {
  const app=Object.assign(new EventEmitter(),{isPackaged:packaged}), handlers=new Map(), instances=[];
  const ipcMain={handle:(n,fn)=>handlers.set(n,fn),removeHandler:n=>handlers.delete(n)};
  class Broker {
    constructor(options) { this.options=options; this.closing=deferred(); instances.push(this); }
    async request() { return 'accepted'; }
    dispose() { this.disposed=true; return this.closing.promise; }
  }
  const frame={url:'file:///isolated/index.html',send(){}}, wc=Object.assign(new EventEmitter(),{mainFrame:frame});
  const window={webContents:wc,isDestroyed:()=>false};
  const controller=installUsbHost({app,ipcMain,executable:'/fixed/trusted/usb-host',enabled:true,Broker});
  controller.attachWindow(window,['file:///isolated/index.html']); wc.emit('dom-ready');
  const event={sender:wc,senderFrame:frame};
  return { app,controller,instances,wc,event, handlers,
    bind:()=>handlers.get('usb-host-bind')(event),
    request:(binding)=>handlers.get('usb-host-request')(event,binding,'serial.open',{session:'test'}) };
}
test('mainFrameだけに文書のbindingを発行し、他frameを拒否する',async()=>{
  const f=setup(); const info=await f.bind(); assert.equal(info.enabled,true);
  const bad=await f.handlers.get('usb-host-bind')({...f.event,senderFrame:{...f.event.senderFrame}});
  assert.equal(bad.error.code,'permission-denied');
  assert.equal((await f.request('forged')).error.code,'permission-denied');
  assert.equal(f.instances.length,0); await f.controller.dispose();
});
test('再読み込みで旧bindingを失効させ、旧process終了前に新brokerを作らない',async()=>{
  const f=setup(), first=await f.bind(); assert.equal((await f.request(first.binding)).ok,true);
  f.wc.emit('did-frame-navigate',{},'file:///isolated/index.html',200,'',true);
  assert.equal(f.instances[0].disposed,true); f.wc.emit('dom-ready');
  const next=await f.bind(); assert.notEqual(first.binding,next.binding);
  assert.equal((await f.request(first.binding)).error.code,'permission-denied');
  let finished=false; const opening=f.request(next.binding).then(v=>{finished=true;return v;});
  await new Promise(r=>setImmediate(r)); assert.equal(finished,false); assert.equal(f.instances.length,1);
  f.instances[0].closing.resolve(); assert.equal((await opening).ok,true); assert.equal(f.instances.length,2);
  f.instances[1].closing.resolve(); await f.controller.dispose();
});
test('配布版は環境指定があっても試験経路を有効にしない',async()=>{
  const f=setup(true); const info=await f.bind(); assert.equal(info.enabled,false);
  assert.equal((await f.request('anything')).error.code,'not-supported');
  assert.equal(f.instances.length,0); await f.controller.dispose();
});
test('許可していないURLの同じmainFrameを拒否する',async()=>{
  const f=setup(); f.event.senderFrame.url='https://example.com/';
  assert.equal((await f.bind()).error.code,'permission-denied'); await f.controller.dispose();
});
test('入れ替えた旧windowの遅いnavigationで新しい文書を取り消さない',async()=>{
  const f=setup(); const frame={url:'file:///next/index.html',send(){}},wc=Object.assign(new EventEmitter(),{mainFrame:frame});
  f.controller.attachWindow({webContents:wc,isDestroyed:()=>false},['file:///next/index.html']); wc.emit('dom-ready');
  const event={sender:wc,senderFrame:frame}; const info=await f.handlers.get('usb-host-bind')(event);
  await f.handlers.get('usb-host-request')(event,info.binding,'serial.open',{session:'next'});
  f.wc.emit('did-frame-navigate',{},'file:///isolated/index.html',200,'',true);
  assert.equal(f.instances[0].disposed,undefined);
  f.instances[0].closing.resolve(); await f.controller.dispose();
});
test('quitをbeforeunloadで取り消した文書の接続を失効させない',async()=>{
  const f=setup(), info=await f.bind(); await f.request(info.binding);
  // before-quitの後に利用者がStayを選んだ場合、will-quitには進まない。
  // setupのappイベントはcontrollerの実アプリ通知と同じEmitter。
  const app=f.app;
  app.emit('before-quit'); assert.equal(f.instances[0].disposed,undefined);
  assert.equal((await f.request(info.binding)).ok,true);
  f.instances[0].closing.resolve(); app.emit('will-quit');
  assert.equal(f.instances[0].disposed,true); await f.controller.dispose();
});
test('開始だけで取り消されたnavigationは元文書の権限を維持する',async()=>{
  const f=setup(), info=await f.bind(); await f.request(info.binding);
  f.wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});
  assert.equal((await f.request(info.binding)).ok,true); assert.equal(f.instances[0].disposed,undefined);
  f.instances[0].closing.resolve(); await f.controller.dispose();
});
