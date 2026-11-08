// 入力欄の標準Undoを保ち、配置エディタだけは画面の履歴へ渡す。
async function undoFocusedContents(getFocusedContents) {
  const contents = getFocusedContents();
  if (!contents || contents.isDestroyed()) return;
  let nativeUndo = true;
  try {
    nativeUndo = await contents.executeJavaScript("window.dispatchEvent(new Event('laploupe-layout-undo', { cancelable: true }))");
  } catch { /* ページ切替中などは、同じ入力先にだけ標準のUndoを試す */ }
  if (nativeUndo && !contents.isDestroyed() && getFocusedContents() === contents) contents.undo();
}
module.exports = { undoFocusedContents };
