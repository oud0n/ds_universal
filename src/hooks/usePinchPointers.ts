import { useRef } from 'react';

// タッチの 1 本目を、指を動かしたとみなす距離 (px)。置いただけの指の揺れでシークなどが始まらないように
const TOUCH_SLOP_PX = 8;

type PointerHandler = (e: React.PointerEvent<HTMLCanvasElement>) => void;

/**
 * canvas のポインター操作 (マウス・タッチ・ペン) を、1 本指のドラッグと 2 本指のピンチに分ける。
 * 1 本指 (マウス) は onDown / onMove / onUp に渡し、2 本目の指が触れたらドラッグを終えてピンチにする。
 * onPinch の scale は前回からの指の間隔の比 (1 より大きければ広げた)。centerX / centerY は 2 本の指の中点 (画面座標)
 */
export function usePinchPointers(opts: {
  onDown: PointerHandler;
  onMove: PointerHandler;
  onUp: () => void;
  onPinch: (scale: number, centerX: number, centerY: number) => void;
}) {
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // タッチの 1 本目は、すぐには onDown に渡さない (ピンチのつもりで置いた指で、シークなどが起きないように)。
  // 指を一定以上動かすか離したときに渡し、その前に 2 本目の指が触れたら (またはタッチが取り消されたら) 捨てる
  const pendingDown = useRef<React.PointerEvent<HTMLCanvasElement> | null>(null);
  const flushPending = () => {
    const e = pendingDown.current;
    pendingDown.current = null;
    if (e) latest.current.onDown(e);
  };
  const lastDistance = useRef<number | null>(null);
  // 呼ぶたびに最新の処理を使う (state を読む処理が古くならないように)
  const latest = useRef(opts);
  latest.current = opts;

  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };

  // 指・マウスを離したとき。動かさずに離したタッチ (タップ) も、onDown を渡してから終える
  const end = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    flushPending();
    release(e);
  };
  // 取り消されたとき (ブラウザがジェスチャーとして引き取った・ポインターのキャプチャが外れたなど)。
  // まだ始めていない操作は捨てる。キャプチャが外れたまま残ると、次の操作がピンチと誤るので必ず消す
  const cancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    if (pointers.current.size === 1) pendingDown.current = null;
    release(e);
  };
  const release = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) lastDistance.current = null;
    if (pointers.current.size === 0) latest.current.onUp();
  };

  return {
    onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 1) {
        if (e.pointerType === 'touch') {
          e.persist?.();
          pendingDown.current = e;
        } else {
          latest.current.onDown(e);
        }
      } else if (pointers.current.size === 2) {
        // 2 本目の指: ドラッグをやめてピンチを始める (1 本目の指の操作はまだ始めていなければ捨てる)
        pendingDown.current = null;
        latest.current.onUp();
        lastDistance.current = pinchState().distance;
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size >= 2) {
        const { distance, cx, cy } = pinchState();
        if (lastDistance.current && distance > 0) latest.current.onPinch(distance / lastDistance.current, cx, cy);
        lastDistance.current = distance;
      } else if (lastDistance.current === null) {
        const pending = pendingDown.current;
        if (pending && Math.hypot(e.clientX - pending.clientX, e.clientY - pending.clientY) < TOUCH_SLOP_PX) return;
        flushPending();
        latest.current.onMove(e);
      }
    },
    onPointerUp: end,
    onPointerCancel: cancel,
    onLostPointerCapture: cancel
  };
}
