// 入力欄の標準Undoを保ち、配置エディタだけは画面の履歴へ渡す。
async function undoFocusedContents(getFocusedContents, nativeUndo = contents => contents?.undo()) {
  const contents = getFocusedContents();
  if (!contents) { nativeUndo(null); return; }
  if (contents.isDestroyed()) return;
  try {
    // レンダラーの1タスクで完結し、後続の文字入力を挟んでからUndoしない。
    await contents.executeJavaScript(`(() => {
      if (!document.hasFocus()) return;
      if (window.dispatchEvent(new Event('laploupe-layout-undo', { cancelable: true }))) document.execCommand('undo');
    })()`, true);
  } catch { // ページ切替中などは、同じ入力先にだけ標準のUndoを試す
    if (!contents.isDestroyed() && getFocusedContents() === contents) nativeUndo(contents);
  }
}
module.exports = { undoFocusedContents };
