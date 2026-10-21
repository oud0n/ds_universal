/**
 * まだ何も読み込んでいない画面の案内 (グラフ・動画・変換で同じ形。2026-10-20)。
 * 枠は付けず、題・説明・赤いボタンを真ん中に出す。狭い画面ではみ出したらスクロールする
 * (真ん中に寄せるのは m-auto で行う。justify-center だと、収まらないときに上が切れるため)
 */
import React from 'react';
import { FolderOpen } from 'lucide-react';

export const EmptyLoadPrompt: React.FC<{
  title: string;
  text: string;
  buttonLabel: string;
  onClick: () => void;
  testId?: string;
  /** ボタンの下に出すもの (最近の走行など) */
  children?: React.ReactNode;
}> = ({ title, text, buttonLabel, onClick, testId, children }) => (
  <div className="flex flex-col w-full h-full p-4 overflow-y-auto">
    <div className="m-auto flex flex-col items-center text-center gap-2">
      <h2 className="text-sm font-bold text-slate-100">{title}</h2>
      <p className="text-xs text-slate-400 max-w-sm leading-relaxed">{text}</p>
      <button
        onClick={onClick}
        data-testid={testId}
        className="mt-1 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-xs text-white font-bold cursor-pointer"
      >
        <FolderOpen size={14} />
        {buttonLabel}
      </button>
      {children}
    </div>
  </div>
);
