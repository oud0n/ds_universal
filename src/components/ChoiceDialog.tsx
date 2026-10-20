/**
 * ボタンの文言を選べる確認の画面 (2026-10-20)。
 * window.confirm はボタンが「キャンセル / OK」に決まっていて分かりにくいので、「取り込む / 取り込まない」のように出す。
 * askChoice() で開き、押したボタンの値で解ける。Esc・外側を押したときは cancelValue で解ける
 */
import React, { useEffect, useState } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';

export interface ChoiceButton<T> {
  label: string;
  value: T;
  /** 目立たせる (おすすめ) */
  primary?: boolean;
}

interface Request {
  title: string;
  message: string;
  buttons: ChoiceButton<unknown>[];
  cancelValue: unknown;
  resolve: (v: unknown) => void;
}

let show: ((r: Request) => void) | null = null;
const queue: Request[] = [];

export function askChoice<T>(title: string, message: string, buttons: ChoiceButton<T>[], cancelValue: T): Promise<T> {
  return new Promise<T>(resolve => {
    const r: Request = { title, message, buttons, cancelValue, resolve: v => resolve(v as T) };
    if (show) show(r);
    else queue.push(r);
  });
}

/** App に 1 つだけ置く */
export const ChoiceDialogHost: React.FC = () => {
  const [list, setList] = useState<Request[]>([]);
  useEffect(() => {
    show = r => setList(l => [...l, r]);
    if (queue.length) setList(l => [...l, ...queue.splice(0)]);
    return () => { show = null; };
  }, []);
  const cur = list[0];
  const answer = (v: unknown) => {
    if (!cur) return;
    cur.resolve(v);
    setList(l => l.slice(1));
  };
  useEscapeKey(!!cur, () => answer(cur?.cancelValue));
  if (!cur) return null;
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) answer(cur.cancelValue); }}
      role="dialog"
      aria-modal="true"
      data-testid="choice-dialog"
    >
      <div className="bg-surface-2 border border-line-2 rounded-2xl w-full max-w-sm shadow-2xl text-slate-200 p-5">
        <h2 className="text-base font-bold text-slate-100 mb-2">{cur.title}</h2>
        <p className="text-sm text-slate-300 whitespace-pre-line mb-5">{cur.message}</p>
        <div className="flex gap-2">
          {cur.buttons.map(b => (
            <button
              key={b.label}
              onClick={() => answer(b.value)}
              className={`flex-1 py-2.5 rounded-lg text-sm font-bold border ${b.primary ? 'bg-red-600 border-red-500 text-white' : 'bg-surface-3 border-line-2 text-slate-200'}`}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
