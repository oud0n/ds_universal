import { useEffect, useRef } from 'react';

/**
 * 開いているあいだ、Esc キーで閉じる (ダイアログ・パネル)。
 * 重なって開いているときに 1 回の Esc で全部閉じないよう、後から開いたものだけを閉じる
 */
const stack: Array<{ current: () => void }> = [];

/** Esc で閉じるダイアログ・パネルが開いているか (開いているあいだは、再生のキー操作を後ろの画面に効かせない) */
export function isDialogOpen(): boolean {
  return stack.length > 0;
}

export function useEscapeKey(active: boolean, onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    stack.push(ref);
    const onKeyDown = (e: KeyboardEvent) => {
      // 変換中の Esc (Safari は isComposing が付かず keyCode 229 になる)・プルダウンを閉じる Esc では閉じない
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229 || stack[stack.length - 1] !== ref) return;
      if ((e.target as HTMLElement | null)?.tagName === 'SELECT') return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
