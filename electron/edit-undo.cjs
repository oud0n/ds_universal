// 入力欄の標準Undoを保ち、配置エディタだけは画面の履歴へ渡す。
async function undoFocusedContents(getFocusedContents, nativeUndo = contents => contents?.undo()) {
  const contents = getFocusedContents();
  if (!contents) { nativeUndo(null); return; }
  if (contents.isDestroyed()) return;
  let allowNative = true;
  try {
    allowNative = await contents.executeJavaScript("window.dispatchEvent(new Event('laploupe-layout-undo', { cancelable: true }))");
  } catch { /* ページ切替中などは、同じ入力先にだけ標準のUndoを試す */ }
  if (allowNative && !contents.isDestroyed() && getFocusedContents() === contents) nativeUndo(contents);
}
function isUndoInput(input) {
  return input.type === 'keyDown' && input.key?.toLowerCase() === 'z' && !!(input.control || input.meta) && !input.alt && !input.shift;
}
module.exports = { undoFocusedContents, isUndoInput };
