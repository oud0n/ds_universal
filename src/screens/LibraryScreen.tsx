import React from 'react';
import { RunsBrowser } from '../components/RecentRuns';
import type { RunItem } from '../services/runOpener';

/**
 * 走行 (保管場所の一覧)。2026-10-21 (PLAN-24 の 2) は、今の「走行を開く」の中身をそのまま画面にしたもの。
 * 作る順番の 3 で、日付のまとまり・走行の詳細・ラップタイムの記録・保管場所の指定に作り替える
 */
export const LibraryScreen: React.FC<{ active: boolean; onOpen: (r: RunItem) => void; onPickFiles: () => void; busy: boolean }> = ({ active, onOpen, onPickFiles, busy }) => {
  if (!active) return null;
  return (
    <div className="h-full max-w-2xl mx-auto flex flex-col" data-testid="library-screen">
      <RunsBrowser onOpen={onOpen} onPickFiles={onPickFiles} busy={busy} />
    </div>
  );
};
