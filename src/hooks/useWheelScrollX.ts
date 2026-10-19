import { useCallback, useRef } from 'react';

/**
 * 横にスクロールする段 (ボタンやタブが入りきらない段) を、マウスのホイール (縦の回転) でも横に動かせるようにする。
 * マウスでは、細いスクロールバーをつかむしか横に動かせず、隠れたボタンに気づきにくいため。
 * 横に動かせないとき・トラックパッドの横の動き (deltaX) のときは、ふだんどおり (ページの縦のスクロール) にする。
 * 返す関数を、段の要素の ref に渡す
 */
export function useWheelScrollX<T extends HTMLElement>(): (el: T | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      // 端まで来ていて、その先へ回したときは、ページのスクロールに任せる
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      // 行単位 (Firefox) のときは、1 行を 16px として扱う
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const before = el.scrollLeft;
      el.scrollLeft += step;
      // 動かなかったとき (小数の端数で端と判定できなかったときなど) は、ページのスクロールを止めない
      if (el.scrollLeft !== before) e.preventDefault();
    };
    // preventDefault するので passive にしない (React の onWheel は passive で止められない)
    el.addEventListener('wheel', onWheel, { passive: false });
    cleanup.current = () => el.removeEventListener('wheel', onWheel);
  }, []);
}
