const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { UsbHostBroker, OPTIONS } = require('./usb-host.cjs');
const fixture = path.join(__dirname, '../scripts/usb-host/fake-host.cjs');
function broker(mode, events = []) {
  return new UsbHostBroker({ executable: process.execPath, args: [fixture, mode], onEvent: e => events.push(e),
    readyMs: 1000, requestMs: 2000, closeMs: 30 });
}
const open = (b, session = 'test') => b.request('serial.open', { session, options: OPTIONS });
const code = expected => error => error?.code === expected;

test('実プロセスの部分write/通知を渡し、closeはprocess終了まで待つ', async () => {
  const events = [], b = broker('normal', events);
  try {
    await open(b); const child = b.active.child;
    assert.deepEqual(await b.request('serial.write', { session:'test', bytes:[1,2,3] }), { written:2 });
    const first = b.close('test'), second = b.close('test');
    await Promise.all([first, second]);
    assert.equal(b.active, null); assert.notEqual(child.exitCode, null);
    assert.equal(events.filter(e => e.type === 'serial.lost').length, 0);
  } finally { await b.dispose(); }
});
test('openとcloseが応答しなくても、子を停止して全保留を中止する', async () => {
  const b = broker('block');
  const opening = assert.rejects(open(b), code('cancelled'));
  await new Promise(r => setTimeout(r, 80));
  const child = b.active.child;
  await b.close('test'); await opening;
  assert.equal(b.active, null); assert.ok(child.signalCode || child.exitCode !== null);
});
test('open前のcloseを記憶し、後から同じsessionで開かない', async () => {
  const b = broker('normal');
  await b.close('test'); await assert.rejects(open(b), code('cancelled'));
  assert.equal(b.active, null); await b.dispose();
});
test('別sessionのcloseは接続中の機器を閉じない', async () => {
  const b = broker('normal');
  try { await open(b); const child = b.active.child; await b.close('other'); assert.equal(b.active.child, child); }
  finally { await b.dispose(); }
});
for (const mode of ['version', 'oversize']) test(`不正な子の${mode}を受理しない`, async () => {
  const b = broker(mode);
  await assert.rejects(open(b), code('invalid-data'));
  assert.equal(b.active, null); await b.dispose();
});
test('不正なwrite結果を成功にせず子を終了する', async () => {
  const b = broker('invalid-write');
  try { await open(b); await assert.rejects(b.request('serial.write', {session:'test',bytes:[1]}), code('invalid-data')); }
  finally { await b.dispose(); }
  assert.equal(b.active, null);
});
test('子の異常終了で保留writeを失敗させ、lostを一度通知する', async () => {
  const events = [], b = broker('exit', events);
  try { await open(b); await assert.rejects(b.request('serial.write', {session:'test',bytes:[1]}), code('io')); }
  finally { await b.dispose(); }
  assert.equal(events.filter(e => e.type === 'serial.lost').length,1);
});
test('実行ファイル/port名や無効なデータを画面から指定できない', async () => {
  const b = broker('normal');
  await assert.rejects(b.request('serial.open', {session:'test',options:OPTIONS,executable:'/tmp/bad'}), code('invalid-data'));
  await assert.rejects(b.request('serial.open', {session:'test',options:{...OPTIONS,port:'/dev/anything'}}), code('invalid-data'));
  for (const bytes of [[256],[-1],[1.5],[],Array(2)]) await assert.rejects(b.request('serial.write', {session:'test',bytes}), code('invalid-data'));
  await assert.rejects(b.request('ble.connect',{session:'test'}), code('not-supported'));
  assert.equal(b.active,null); await b.dispose();
});
test('存在しない子バイナリは失敗し、pendingを残さない', async () => {
  const b = new UsbHostBroker({ executable:path.join(__dirname,'absent-usb-host'),onEvent(){} });
  await assert.rejects(open(b),code('io')); assert.equal(b.active,null); await b.dispose();
});
