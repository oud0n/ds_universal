import React from 'react';
import { RotateCcw, RotateCw } from 'lucide-react';

/** 10 秒戻す / 進めるの印 (よくある、まるい矢印の中に 10) */
export const Skip10Icon: React.FC<{ dir: 'back' | 'forward'; size: number }> = ({ dir, size }) => {
  const Arrow = dir === 'back' ? RotateCcw : RotateCw;
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size + 4, height: size + 4 }}>
      <Arrow size={size + 4} strokeWidth={1.75} />
      <span className="absolute inset-0 flex items-center justify-center font-bold leading-none" style={{ fontSize: Math.round(size * 0.5), paddingTop: 1 }}>10</span>
    </span>
  );
};

/** 戻す・進める秒数 */
export const SKIP_SEC = 10;
