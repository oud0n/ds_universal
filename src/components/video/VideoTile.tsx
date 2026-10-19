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

export const VideoTile: React.FC<VideoTileProps> = ({
  tileKey, controller, position, muted, onSeeked, overlay, avoidRef, badge, accent, onClick, className = '', emptyText, useProxy = false, active = true, children
}) => {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
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
      setAvoidW(ow > 0 && oh > 0 ? Math.round((ow * 1280) / w) : 0);
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    overlay?.draw(ctx, canvas.width, canvas.height, avoidW);
  }, [overlay?.tick, overlay?.draw, avoidW]);

  return (
    <div
      ref={hostRef}
      onClick={onClick}
      className={`relative flex items-center justify-center bg-black overflow-hidden ${onClick ? 'cursor-pointer' : ''} ${className}`}
      style={accent ? { boxShadow: `inset 0 0 0 2px ${accent}` } : undefined}
    >
      {src ? (
        <video
          ref={setVideo}
          onSeeked={onSeeked}
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
          width={1280}
          height={720}
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
