import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaPosition } from '../../services/playableMedia';
import type { PlaybackController } from '../../services/playbackController';
import { useT } from '../../utils/i18n';

/**
 * 動画の枠 1 つ: <video> と、その上に描くメーター (canvas)。再生の位置は PlaybackController が合わせる。
 * メーターは、動画が実際に映っている部分 (黒い帯を除く) に重ねる。avoidRef の要素 (PinP の小窓) が重なる幅を測り、
 * メーターを描く関数に渡す (その隅のメーターを小窓の横へずらすため、BUG-23)
 */
export interface TileOverlay {
  /** 描き直すきっかけ (時刻など)。変わったら描き直す */
  tick: unknown;
  /** canvas は 1280 × 720。avoidW は、小窓が映像に重なる幅 (canvas の座標) */
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, avoidW: number) => void;
}

interface VideoTileProps {
  tileKey: string;
  controller: PlaybackController;
  position: MediaPosition | null;
  muted: boolean;
  onSeeked: () => void;
  overlay?: TileOverlay | null;
  avoidRef?: React.RefObject<HTMLElement | null>;
  /** 左上の札 (カメラの名前・Car など) */
  badge?: React.ReactNode;
  /** 枠の縁の色 (Car の色) */
  accent?: string;
  onClick?: () => void;
  className?: string;
  /** 動画がないときの案内 */
  emptyText?: string;
  /** GoPro の低画質のファイル (.LRV) があれば、それを出す (小さな枠・下書きの書き出し) */
  useProxy?: boolean;
  /** 見えているか。見えなくなって 10 秒たったら、動画を手放す (デコーダーとメモリを空ける。戻るときに読み直す) */
  active?: boolean;
  /** 映像の外に重ねるもの (PinP の小窓など) */
  children?: React.ReactNode;
}

/** メーターを描く板の幅 (映っている動画の幅の 2 倍、800〜1280。スマートフォンではメーターを動画に対して約 1.5 倍に出す) */
export function overlayLogicalWidth(displayWidth: number): number {
  return Math.round(Math.min(1280, Math.max(800, displayWidth * 2)));
}

export const VideoTile: React.FC<VideoTileProps> = ({
  tileKey, controller, position, muted, onSeeked, overlay, avoidRef, badge, accent, onClick, className = '', emptyText, useProxy = false, active = true, children
}) => {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // メーターを描く板の大きさ。動画が小さく映っているときは板を小さくして、メーターを動画に対して大きく出す
  // (1280 × 720 のまま縮めると、スマートフォンでは文字が 4〜12 px になる。2026-10-20)
  const logical = box ? { w: overlayLogicalWidth(box.width), h: Math.round(overlayLogicalWidth(box.width) * box.height / box.width) } : { w: 1280, h: 720 };
  const dpr = typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 1;
  const canvasPx = box ? { w: Math.max(1, Math.round(box.width * dpr)), h: Math.max(1, Math.round(box.height * dpr)) } : { w: 1280, h: 720 };
  const [avoidW, setAvoidW] = useState(0);
  const [released, setReleased] = useState(false);
  useEffect(() => {
    if (active) { setReleased(false); return; }
    const timer = setTimeout(() => setReleased(true), 10000);
    return () => clearTimeout(timer);
  }, [active]);
  const track = position?.track;
  const src = released ? undefined : (useProxy && track?.proxyUrl) || track?.objectUrl;
  const isReleased = released && !!track?.objectUrl;
  // 同じ関数を渡し続ける (描くたびに付け外しすると、出たコマの見張りが切れるため)
  const setVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    controller.attach(tileKey, el);
  }, [controller, tileKey]);

  // iPhone の Safari で、再生を断られて音を消した動画 (PlaybackController)。音を出す枠なら、次に画面に触れたときに音を戻す
  // (画面に触れた操作の中なら、音を戻しても再生が止まらない)
  useEffect(() => {
    if (muted) return;
    // 最初のコマを出すために音を消して一瞬だけ再生している間 (PlaybackController が dsPriming の印を付ける) は戻さない
    // (動画のタブを押した指を離したときに戻すと、止めるまでの間、一瞬音が鳴る)
    const restore = () => { const el = videoRef.current; if (el && el.muted && !el.dataset.dsPriming) el.muted = false; };
    document.addEventListener('pointerup', restore);
    document.addEventListener('touchend', restore);
    return () => { document.removeEventListener('pointerup', restore); document.removeEventListener('touchend', restore); };
  }, [muted]);

  // メーターを重ねる四角と、小窓が映像に重なる幅を測る
  useEffect(() => {
    const video = videoRef.current, host = hostRef.current;
    if (!video || !host) return;
    const update = () => {
      const vr = video.getBoundingClientRect(), hr = host.getBoundingClientRect();
      if (vr.width === 0 || vr.height === 0) return;
      const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
      const scale = Math.min(vr.width / vw, vr.height / vh);
      const w = vw * scale, h = vh * scale;
      const next = { left: Math.round(vr.left - hr.left + (vr.width - w) / 2), top: Math.round(vr.top - hr.top + (vr.height - h) / 2), width: Math.round(w), height: Math.round(h) };
      setBox(prev => (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height ? prev : next));
      const pr = avoidRef?.current?.getBoundingClientRect();
      const bl = vr.left + (vr.width - w) / 2, bt = vr.top + (vr.height - h) / 2;
      const ow = pr ? Math.max(0, Math.min(pr.right, bl + w) - Math.max(pr.left, bl)) : 0;
      const oh = pr ? Math.max(0, Math.min(pr.bottom, bt + h) - Math.max(pr.top, bt)) : 0;
      setAvoidW(ow > 0 && oh > 0 ? Math.round((ow * overlayLogicalWidth(w)) / w) : 0);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(video);
    ro.observe(host);
    if (avoidRef?.current) ro.observe(avoidRef.current);
    video.addEventListener('loadedmetadata', update);
    return () => { ro.disconnect(); video.removeEventListener('loadedmetadata', update); };
  }, [src, avoidRef?.current]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // メーターは「描く板」の座標で描く。板の画素は画面の細かさに合わせて増やす (にじまないように)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width / logical.w, 0, 0, canvas.height / logical.h, 0, 0);
    overlay?.draw(ctx, logical.w, logical.h, avoidW);
  }, [overlay?.tick, overlay?.draw, avoidW, logical.w, logical.h, canvasPx.w, canvasPx.h]);

  return (
    <div
      ref={hostRef}
      onClick={onClick}
      // 色の枠は内側に描くので、その幅 (2px) だけ内側に余白を取り、動画が枠に重ならないようにする
      className={`relative flex items-center justify-center bg-black overflow-hidden ${accent ? 'p-0.5' : ''} ${onClick ? 'cursor-pointer' : ''} ${className}`}
      style={accent ? { boxShadow: `inset 0 0 0 2px ${accent}` } : undefined}
    >
      {src ? (
        <video
          ref={setVideo}
          onSeeked={onSeeked}
          // 動画を読み込めたら、もう一度位置を合わせる (止めているときは、App の時刻が変わらず合わせ直されないため)。
          // iPhone の Safari は再生するまで中身を読まず loadeddata が来ないので、長さが分かったとき (loadedmetadata) にも合わせる。
          // そこで、止めたままでも最初のコマを出すための一度だけの再生をする (Car を替えて動画が替わったときも。2026-10-22)
          onLoadedData={onSeeked}
          onLoadedMetadata={onSeeked}
          src={src}
          muted={muted}
          playsInline
          className="max-h-full max-w-full object-contain"
        />
      ) : (
        <div className="text-slate-500 text-xs text-center p-4">{isReleased ? '' : emptyText ?? t('動画がありません', 'No video')}</div>
      )}
      {overlay && (
        <canvas
          ref={canvasRef}
          width={canvasPx.w}
          height={canvasPx.h}
          style={box ? { left: box.left, top: box.top, width: box.width, height: box.height } : undefined}
          className={`absolute ${box ? '' : 'inset-0 w-full h-full'} pointer-events-none z-[15]`}
        />
      )}
      {src && position?.outOfRange && (
        <div className="absolute inset-0 z-[5] flex items-center justify-center bg-black/80 text-slate-400 text-[11px] text-center px-2 pointer-events-none">
          {t('この時刻の映像はありません', 'No footage at this time')}
        </div>
      )}
      {badge && (
        <div className="absolute top-2 left-2 z-20 text-[10px] font-mono font-bold bg-black/70 border border-slate-700 px-1.5 py-0.5 rounded text-slate-200 flex items-center gap-1 max-w-[90%]">
          {badge}
        </div>
      )}
      {children}
    </div>
  );
};
