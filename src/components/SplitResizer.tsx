import React from 'react';

interface SplitResizerProps {
  direction?: 'horizontal' | 'vertical'; // 'horizontal' = 左右分割の境界 (縦棒), 'vertical' = 上下分割の境界 (横棒)
  isDragging?: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  className?: string;
}

export const SplitResizer: React.FC<SplitResizerProps> = ({
  direction = 'horizontal',
  isDragging = false,
  onMouseDown,
  className = ''
}) => {
  const isHorizontal = direction === 'horizontal';

  return (
    <div
      onMouseDown={onMouseDown}
      className={`relative select-none flex-shrink-0 transition-colors z-20 group ${
        isHorizontal
          ? 'w-1.5 cursor-col-resize hover:bg-cyan-500/50 bg-[#1e2433]'
          : 'h-1.5 cursor-row-resize hover:bg-cyan-500/50 bg-[#1e2433]'
      } ${isDragging ? '!bg-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.8)]' : ''} ${className}`}
    >
      {/* ホバー & ドラッグ時のグリップインジケーター */}
      <div
        className={`absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 ${
          isDragging ? '!opacity-100' : ''
        } transition-opacity`}
      >
        {isHorizontal ? (
          <div className="flex flex-col gap-0.5">
            <span className="w-0.5 h-0.5 rounded-full bg-cyan-200" />
            <span className="w-0.5 h-0.5 rounded-full bg-cyan-200" />
            <span className="w-0.5 h-0.5 rounded-full bg-cyan-200" />
          </div>
        ) : (
          <div className="flex flex-row gap-0.5">
            <span className="w-0.5 h-0.5 rounded-full bg-cyan-200" />
            <span className="w-0.5 h-0.5 rounded-full bg-cyan-200" />
            <span className="w-0.5 h-0.5 rounded-full bg-cyan-200" />
          </div>
        )}
      </div>
    </div>
  );
};
