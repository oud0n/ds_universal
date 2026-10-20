import React, { useState } from 'react';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useT } from '../../utils/i18n';
import type { Screen } from '../../app/navPlan';
import { SCREEN_META } from '../../app/screenMeta';

const COLLAPSED_KEY = 'ds_sidebar_collapsed';

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** デスクトップ版・iPad の左のサイドバー。たたむとアイコンだけ (たたんだかは覚えておく) */
export const Sidebar: React.FC<{
  items: Screen[];
  bottom: Screen[];
  current: Screen;
  onSelect: (s: Screen) => void;
  badges?: Partial<Record<Screen, number>>;
}> = ({ items, bottom, current, onSelect, badges }) => {
  const t = useT();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = () => {
    setCollapsed(c => {
      try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1'); } catch { /* 覚えられなくても今は使える */ }
      return !c;
    });
  };
  const item = (id: Screen) => {
    const { label, Icon } = SCREEN_META[id];
    const badge = badges?.[id];
    const on = current === id;
    return (
      <button
        key={id}
        onClick={() => onSelect(id)}
        title={t(...label)}
        aria-label={t(...label)}
        aria-current={on ? 'page' : undefined}
        className={`h-10 rounded-lg flex items-center gap-2.5 text-sm transition-colors cursor-pointer ${collapsed ? 'justify-center px-0' : 'px-3'} ${
          on ? 'bg-red-600/15 text-red-400 font-bold' : 'text-slate-400 hover:text-slate-200 hover:bg-surface-3'
        }`}
        data-testid={`nav-${id}`}
      >
        <Icon size={18} className="shrink-0" />
        {!collapsed && <span className="truncate flex-1 text-left">{t(...label)}</span>}
        {!collapsed && !!badge && <span className="px-1.5 text-[10px] rounded bg-slate-700 text-slate-300 font-mono">{badge}</span>}
      </button>
    );
  };
  return (
    <nav
      className={`shrink-0 flex flex-col gap-1 p-2 bg-surface-1 border-r border-line-1 select-none pt-[max(0.5rem,env(safe-area-inset-top))] ${collapsed ? 'w-14' : 'w-48'}`}
      data-testid="sidebar"
    >
      {items.map(item)}
      <div className="flex-1" />
      {bottom.map(item)}
      <button
        onClick={toggle}
        title={collapsed ? t('サイドバーを広げる', 'Expand sidebar') : t('サイドバーをたたむ', 'Collapse sidebar')}
        aria-label={collapsed ? t('サイドバーを広げる', 'Expand sidebar') : t('サイドバーをたたむ', 'Collapse sidebar')}
        className={`h-9 rounded-lg flex items-center text-slate-500 hover:text-slate-300 hover:bg-surface-3 cursor-pointer ${collapsed ? 'justify-center' : 'px-3'}`}
      >
        {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
      </button>
    </nav>
  );
};
