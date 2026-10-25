import React, { useEffect, useRef, useState } from 'react';
import { Square, Play, RotateCw, Smartphone } from 'lucide-react';
import { useT } from '../utils/i18n';

/** 終了の確認を出したまま何もしなければ、この秒数で「続ける」に戻る */
export const STOP_CONFIRM_SEC = 10;

/**
 * 測定終了の確認 (全画面)。ヘルメットとグローブで押す前提で、ボタンを大きくする。
 * 走りながら誤って押したときのために、「いいえ (続ける)」を下 (測定終了のボタンと同じ場所) に置き、
 * 何もしなければ 10 秒で閉じる。出している間も周は数え続ける (閉じるだけで、測るのは止めない)
 */
export const StopConfirm: React.FC<{ lapCount: number; onYes: () => void; onNo: () => void; nothingToSave?: boolean }> = ({ lapCount, onYes, onNo, nothingToSave = false }) => {
  const t = useT();
  const [left, setLeft] = useState(STOP_CONFIRM_SEC);
  // 親が描き直しても 10 秒を数え直さないよう、閉じる処理は ref で持つ
  const onNoRef = useRef(onNo);
  onNoRef.current = onNo;
  useEffect(() => {
    const started = performance.now();
    const id = window.setInterval(() => {
      const rest = STOP_CONFIRM_SEC - Math.floor((performance.now() - started) / 1000);
      if (rest <= 0) {
        window.clearInterval(id);
        onNoRef.current();
      } else setLeft(rest);
    }, 250);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div
      className="absolute inset-0 z-30 bg-surface-0 flex flex-col landscape:flex-row items-stretch gap-4 p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      role="alertdialog"
      aria-modal="true"
      aria-label={t('測定を終了しますか？', 'Stop timing?')}
      data-testid="lap-timer-stop-confirm"
    >
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-2 landscape:basis-1/3">
        <div className="font-bold" style={{ fontSize: 'min(8vw, 9vh)' }}>{t('測定を終了しますか？', 'Stop timing?')}</div>
        <div className="text-slate-400 text-lg">{nothingToSave
          ? t('まだ測位が届いていないので、保存する走行はありません', 'No position received yet, so there is no run to save')
          : t(`ここまでの ${lapCount} 周を保存します`, `${lapCount} laps so far will be saved`)}</div>
        <div className="text-slate-500 text-base">{t(`${left} 秒で「続ける」に戻ります`, `Back to timing in ${left} s`)}</div>
      </div>
      <div className="flex flex-col landscape:flex-row landscape:basis-2/3 gap-4">
        <button
          onClick={onYes}
          className="min-h-[120px] landscape:min-h-0 landscape:flex-1 rounded-3xl border-4 border-red-500 text-red-500 font-bold text-3xl flex items-center justify-center gap-3 active:bg-red-900/40"
          data-testid="lap-timer-stop-yes"
        >
          <Square size={28} fill="currentColor" />{t('はい、終了', 'Yes, stop')}
        </button>
        <button
          onClick={onNo}
          className="min-h-[140px] landscape:min-h-0 landscape:flex-1 rounded-3xl bg-emerald-600 active:bg-emerald-700 text-white font-bold text-3xl flex items-center justify-center gap-3"
          data-testid="lap-timer-stop-no"
        >
          <Play size={28} fill="currentColor" />{t('いいえ、続ける', 'No, keep timing')}
        </button>
      </div>
    </div>
  );
};

/** ラップタイマーの画面の向き。auto = 傾きで決める (画面の向きのロックが入っていても) */
export type TimerOrientation = 'auto' | 'portrait' | 'landscape';

const ORIENTATION_KEY = 'lapTimer.orientation';

export function loadTimerOrientation(): TimerOrientation {
  try {
    const v = localStorage.getItem(ORIENTATION_KEY);
    if (v === 'auto' || v === 'portrait' || v === 'landscape') return v;
  } catch {
    // 読めないときは既定
  }
  return 'auto';
}

export function saveTimerOrientation(v: TimerOrientation): void {
  try {
    localStorage.setItem(ORIENTATION_KEY, v);
  } catch {
    // 覚えられなくても、今は使える
  }
}

/** 画面の向きの切り替え (測る前だけ出す。大きく押しやすく) */
export const OrientationToggle: React.FC<{ value: TimerOrientation; onChange: (v: TimerOrientation) => void }> = ({ value, onChange }) => {
  const t = useT();
  const items: { v: TimerOrientation; label: string; icon: React.ReactNode }[] = [
    { v: 'auto', label: t('自動', 'Auto'), icon: <RotateCw size={18} /> },
    { v: 'portrait', label: t('縦', 'Portrait'), icon: <Smartphone size={18} /> },
    { v: 'landscape', label: t('横', 'Landscape'), icon: <Smartphone size={18} className="rotate-90" /> },
  ];
  return (
    <div className="flex items-center gap-2" data-testid="lap-timer-orientation">
      <span className="text-slate-400 text-sm whitespace-nowrap">{t('画面の向き', 'Screen')}</span>
      <div className="flex-1 flex rounded-2xl border border-line-3 overflow-hidden" role="radiogroup" aria-label={t('画面の向き', 'Screen orientation')}>
        {items.map((it, i) => (
          <button
            key={it.v}
            role="radio"
            aria-checked={value === it.v}
            onClick={() => onChange(it.v)}
            className={`flex-1 h-14 flex items-center justify-center gap-1.5 font-bold text-base ${i > 0 ? 'border-l border-line-3' : ''} ${value === it.v ? 'bg-sky-600 text-white' : 'text-slate-300 active:bg-surface-3'}`}
            data-testid={`lap-timer-orientation-${it.v}`}
          >
            {it.icon}{it.label}
          </button>
        ))}
      </div>
    </div>
  );
};
