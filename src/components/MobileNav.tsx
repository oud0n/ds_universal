import React from 'react';
import { useLandscape } from '../hooks/useCompactLayout';
import { useT } from '../utils/i18n';
import type { Screen } from '../app/navPlan';
import { SCREEN_META, screenLabel } from '../app/screenMeta';

/** スマートフォン用の画面下のタブバー (親指で届く位置に置く)。並べる画面は組み方 (app/navPlan.ts) で決める */
export const BottomTabBar: React.FC<{
  items: Screen[];
  current: Screen;
  onSelect: (s: Screen) => void;
  /** 画面の印に出す数 (データ管理: 読み込んだログの数) */
  badges?: Partial<Record<Screen, number>>;
  /** テーマにかかわらず黒にする (ラップタイマーを出しているとき。タイマーは走りながら見やすいよう、いつも黒) */
  dark?: boolean;
}> = ({ items, current, onSelect, badges, dark = false }) => {
  // 横向きでは高さを取らないよう、アイコンと名前を横に並べて薄くする
  const landscape = useLandscape();
  const t = useT();
  return (
    <nav className={`shrink-0 flex border-t pb-[env(safe-area-inset-bottom)] ${dark ? 'bg-black border-white/15' : 'bg-surface-1 border-line-1'}`} data-testid="bottom-tabs">
      {items.map(id => {
        const { Icon } = SCREEN_META[id];
        const short = screenLabel(id, true);
        const badge = badges?.[id];
        return (
          <button
            key={id}
            onClick={() => onSelect(id)}
            aria-current={current === id ? 'page' : undefined}
            className={`flex-1 flex items-center justify-center font-bold transition-colors ${
              landscape ? 'flex-row gap-2 py-1.5 text-xs' : 'flex-col gap-0.5 py-2 text-[11px]'
            } ${current === id ? 'text-red-500' : dark ? 'text-white/50' : 'text-slate-400'}`}
            data-testid={`nav-${id}`}
          >
            <span className="relative">
              <Icon size={landscape ? 16 : 22} />
              {!!badge && (
                <span className="absolute -top-1 -right-3 bg-surface-5 text-slate-200 text-[9px] font-mono px-1 rounded-full">{badge}</span>
              )}
            </span>
            {t(...short)}
          </button>
        );
      })}
    </nav>
  );
};
