import { useEffect, useRef } from 'react';

/**
 * 開いているあいだ、Esc キーで閉じる (ダイアログ・パネル)。
 * 重なって開いているときに 1 回の Esc で全部閉じないよう、後から開いたものだけを閉じる
 */
const stack: Array<{ current: () => void }> = [];

export function useEscapeKey(active: boolean, onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    stack.push(ref);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || stack[stack.length - 1] !== ref) return;
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
