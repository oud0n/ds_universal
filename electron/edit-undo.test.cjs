const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { undoFocusedContents } = require('./edit-undo.cjs');

function renderer({ focused = true, layout = false } = {}) {
  const calls = [];
  return { calls, isDestroyed: () => false, executeJavaScript: async source => vm.runInNewContext(source, {
    document: { hasFocus: () => focused, execCommand: command => calls.push(command) },
    window: { dispatchEvent: () => !layout }, Event: class {}
  }) };
}
test('配置エディタが処理したUndoは標準Undoへ重ねて渡さない', async () => {
  const target = renderer({ layout: true });
  await undoFocusedContents(() => target, () => assert.fail('unexpected native fallback'));
  assert.deepEqual(target.calls, []);
});
test('入力欄のUndoは同じレンダラータスクで標準処理へ渡す', async () => {
  const target = renderer();
  await undoFocusedContents(() => target, () => assert.fail('unexpected second task'));
  assert.deepEqual(target.calls, ['undo']);
});
test('応答を待つ間に入力先が変わったらUndoしない', async () => {
  const target = renderer({ focused: false });
  await undoFocusedContents(() => target, () => assert.fail('unexpected fallback'));
  assert.deepEqual(target.calls, []);
});
test('ページ切替で実行に失敗しても別の入力先へ標準Undoを送らない', async () => {
  let reject;
  const target = { isDestroyed: () => false, executeJavaScript: () => new Promise((_, no) => { reject = no; }) };
  let current = target;
  const operation = undoFocusedContents(() => current, () => assert.fail('wrong focus'));
  current = null; reject(new Error('navigation')); await operation;
});
test('閉じたページや入力先なしでは処理しない', async () => {
  await undoFocusedContents(() => null);
  await undoFocusedContents(() => ({ isDestroyed: () => true }));
});
test('ネイティブダイアログが入力先のときはOSの標準Undoへ渡す', async () => {
  let native = 0;
  await undoFocusedContents(() => null, () => native++);
  assert.equal(native, 1);
});
