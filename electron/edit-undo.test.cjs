const { test } = require('node:test');
const assert = require('node:assert/strict');
const { undoFocusedContents, isUndoInput } = require('./edit-undo.cjs');

test('配置エディタが処理したUndoは標準Undoへ重ねて渡さない', async () => {
  let undos = 0;
  const target = { isDestroyed: () => false, executeJavaScript: async () => false, undo: () => undos++ };
  await undoFocusedContents(() => target);
  assert.equal(undos, 0);
});
test('入力欄のUndoは標準処理へ渡す', async () => {
  let undos = 0;
  const target = { isDestroyed: () => false, executeJavaScript: async () => true, undo: () => undos++ };
  await undoFocusedContents(() => target);
  assert.equal(undos, 1);
});
test('応答を待つ間に入力先が変わったら標準Undoを実行しない', async () => {
  let finish, undos = 0;
  const target = { isDestroyed: () => false, executeJavaScript: () => new Promise(resolve => { finish = resolve; }), undo: () => undos++ };
  let current = target;
  const operation = undoFocusedContents(() => current);
  current = null;
  finish(true);
  await operation;
  assert.equal(undos, 0);
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
test('主プロセスが処理するUndoキーだけを選び、Redoと通常文字入力は通す', () => {
  assert.equal(isUndoInput({ type: 'keyDown', key: 'z', control: true }), true);
  assert.equal(isUndoInput({ type: 'keyDown', key: 'Z', meta: true }), true);
  for (const extra of [{ shift: true }, { alt: true }, { type: 'keyUp' }, { key: 'x' }]) {
    assert.equal(isUndoInput({ type: 'keyDown', key: 'z', control: true, ...extra }), false);
  }
  assert.equal(isUndoInput({ type: 'keyDown', key: 'z' }), false);
});
