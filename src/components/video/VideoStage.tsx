import React, { useRef } from 'react';
import type { PipPosition } from '../../services/videoViewStore';

/**
 * 枠の並べ方 (docs/video_sets_design.md の 5)。
 * - single: 1 枠目だけ
 * - grid: 2 枠なら左右、3〜4 枠なら 2×2
 * - pip: 1 枠目の上に、2 枠目を小窓で重ねる
 * focus があれば (枠を押したとき)、その枠を大きく出し、ほかの枠を横に小さく並べる。
 * スマートフォン (compact): 走行比較の縦向きは、メインと比較の 1 台を縦に積む (同じ瞬間を見比べるため)。
 * それ以外は 1 枠だけを出し、左右のスワイプで枠を切り替える
 */
export type StageLayout = 'single' | 'grid' | 'pip';

export type TileSize = 'full' | 'thumb' | 'pip';

interface VideoStageProps {
  count: number;
  layout: StageLayout;
  focus: number | null;
  pipPosition: PipPosition;
  pipRef: React.RefObject<HTMLDivElement | null>;
  renderTile: (index: number, size: TileSize) => React.ReactNode;
  compact?: { stackTwo: boolean };
  /** 大きく出す枠を変える (スマートフォンのスワイプ) */
  onFocus?: (index: number) => void;
}

const PIP_POS: Record<PipPosition, string> = {
  'bottom-right': 'bottom-4 right-4',
  'bottom-left': 'bottom-4 left-4',
  'top-right': 'top-4 right-4',
  'top-left': 'top-4 left-4'
};

export const VideoStage: React.FC<VideoStageProps> = ({ count, layout, focus, pipPosition, pipRef, renderTile, compact, onFocus }) => {
  const touchX = useRef<number | null>(null);
  if (count === 0) return null;

  if (compact) {
    const current = focus !== null && focus < count ? focus : 0;
    if (compact.stackTwo && count > 1) {
      const other = current > 0 ? current : 1;
      return (
        <div className="w-full h-full grid grid-cols-1 grid-rows-2 gap-px bg-line-1">
          <div className="min-h-0 min-w-0 flex">{renderTile(0, 'full')}</div>
          <div className="min-h-0 min-w-0 flex">{renderTile(other, 'full')}</div>
        </div>
      );
    }
    const swipe = (dx: number) => {
      if (Math.abs(dx) < 40 || count < 2) return;
      onFocus?.((current + (dx < 0 ? 1 : count - 1)) % count);
    };
    return (
      <div
        className="w-full h-full relative flex"
        onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
        onTouchEnd={e => { if (touchX.current !== null) swipe(e.changedTouches[0].clientX - touchX.current); touchX.current = null; }}
      >
        {renderTile(current, 'full')}
        {count > 1 && (
          <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 z-20 flex gap-1.5">
            {Array.from({ length: count }, (_, i) => (
              <button key={i} onClick={() => onFocus?.(i)} className={`w-2 h-2 rounded-full ${i === current ? 'bg-white' : 'bg-white/40'}`} aria-label={`${i + 1}`} />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (count === 1 || layout === 'single') return <div className="w-full h-full flex">{renderTile(0, 'full')}</div>;

  if (layout === 'pip') {
    return (
      <div className="w-full h-full relative flex">
        {renderTile(0, 'full')}
        <div ref={pipRef} className={`absolute z-20 w-1/4 min-w-[220px] max-w-[340px] aspect-video border border-blue-500/80 bg-black rounded overflow-hidden flex ${PIP_POS[pipPosition]}`}>
          {renderTile(1, 'pip')}
        </div>
      </div>
    );
  }

  if (focus !== null && focus < count) {
    const others = Array.from({ length: count }, (_, i) => i).filter(i => i !== focus);
    return (
      <div className="w-full h-full flex flex-col sm:flex-row gap-px bg-line-1">
        <div className="flex-[3] min-h-0 min-w-0 flex">{renderTile(focus, 'full')}</div>
        <div className="flex-1 min-h-0 min-w-0 flex flex-row sm:flex-col gap-px">
          {others.map(i => <div key={i} className="flex-1 min-h-0 min-w-0 flex">{renderTile(i, 'thumb')}</div>)}
        </div>
      </div>
    );
  }

  const cols = count === 2 ? 'grid-cols-2 grid-rows-1' : 'grid-cols-2 grid-rows-2';
  return (
    <div className={`w-full h-full grid ${cols} gap-px bg-line-1`}>
      {Array.from({ length: count }, (_, i) => <div key={i} className="min-h-0 min-w-0 flex">{renderTile(i, 'full')}</div>)}
    </div>
  );
};
