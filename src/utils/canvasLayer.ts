import { useEffect, useState } from 'react';

// 2 枚重ねの canvas の補助。
// 下の canvas には動かないもの (グラフの線・目盛り・走行ラインなど) を、データや表示が変わったときだけ描き、
// 上の canvas には再生中に動くもの (カーソル・車両など) だけを毎コマ描く。
// 毎コマ全部を描き直すと、点の多いログで重くなり、車載動画のコマも抜けるため (BUG-14・BUG-20)

/**
 * canvas の大きさを表示の大きさ (CSS px) と画面の解像度に合わせ、CSS px で描けるようにした context を返す。
 * 大きさが変わらなければ canvas を作り直さない (作り直すと重いため)。描く前に全体を消す
 */
export function prepareCanvas(canvas: HTMLCanvasElement | null, width: number, height: number): CanvasRenderingContext2D | null {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const cssW = `${width}px`;
  const cssH = `${height}px`;
  if (canvas.style.width !== cssW) canvas.style.width = cssW;
  if (canvas.style.height !== cssH) canvas.style.height = cssH;
  // 作り直さないときは前回の描き方の設定が残るので、作り直したときと同じ初めの状態に戻す
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/**
 * 画面の解像度 (devicePixelRatio)。ウインドウを解像度の違うディスプレイへ移したときに変わる。
 * 大きさは変わらないので ResizeObserver では気づけない。描き直しのきっかけに使う (ぼやけたままにならないように)
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList | null = null;
    const onChange = () => {
      setDpr(window.devicePixelRatio || 1);
      watch();
    };
    // 今の解像度から変わったときに 1 度だけ知らせる問い合わせを、変わるたびに作り直す
    const watch = () => {
      query?.removeEventListener('change', onChange);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', onChange);
    };
    watch();
    return () => query?.removeEventListener('change', onChange);
  }, []);
  return dpr;
}
