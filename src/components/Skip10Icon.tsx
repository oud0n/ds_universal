import { RotateCcw, RotateCw } from 'lucide-react';
import React from 'react';

/** 少し戻す / 進めるの印 (まるい矢印だけ。数字は入れない) */
export const Skip10Icon: React.FC<{ dir: 'back' | 'forward'; size: number }> = ({ dir, size }) => {
  const Arrow = dir === 'back' ? RotateCcw : RotateCw;
  return <Arrow size={size} />;
};

/** 戻す・進める秒数 (2026-10-20 に 10 秒から 5 秒へ) */
export const SKIP_SEC = 5;
