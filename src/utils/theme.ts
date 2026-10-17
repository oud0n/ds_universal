import { useSyncExternalStore } from 'react';

// 画面のテーマ。system は OS の設定 (ライト / ダーク) に合わせる
export type ThemeSetting = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

// 選んだテーマはこの端末のブラウザに保存する (index.html の最初のスクリプトも同じキーを読む)
const STORAGE_KEY = 'ds_theme';

// OS がライトを指定しているときだけライトにする (指定がなければダーク。index.html の最初のスクリプトと同じ)
const lightQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function loadSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // 保存先が使えない (プライベートウインドウなど) ときは既定のまま
  }
  return 'system';
}

let setting: ThemeSetting = loadSetting();
let resolved: ResolvedTheme = resolve(setting);
const listeners = new Set<() => void>();

function resolve(s: ThemeSetting): ResolvedTheme {
  if (s === 'system') return lightQuery?.matches ? 'light' : 'dark';
  return s;
}

function apply() {
  resolved = resolve(setting);
  const root = document.documentElement;
  root.classList.toggle('light', resolved === 'light');
  root.classList.toggle('dark', resolved === 'dark');
  listeners.forEach(l => l());
}

apply();
// システムに合わせるときは、OS の設定が変わったらすぐ切り替える
lightQuery?.addEventListener('change', () => {
  if (setting === 'system') apply();
});

export function setThemeSetting(s: ThemeSetting) {
  setting = s;
  try {
    localStorage.setItem(STORAGE_KEY, s);
  } catch {
    // 保存できなくても、この画面では切り替える
  }
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** 選んでいるテーマ (light / dark / system) */
export function useThemeSetting(): ThemeSetting {
  return useSyncExternalStore(subscribe, () => setting);
}

/** 実際に表示しているテーマ (light / dark)。canvas を描き直すきっかけに使う */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => resolved);
}


/** canvas に描く色 (src/index.css の --ds-canvas-*)。描くたびに読むので、テーマを切り替えたら描き直すだけで変わる */
export function canvasColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(`--ds-canvas-${name}`).trim();
  return {
    bg: v('bg'),
    panel: v('panel'),
    grid: v('grid'),
    gridStrong: v('grid-strong'),
    axis: v('axis'),
    label: v('label'),
    strong: v('strong'),
    soft: v('soft'),
    track: v('track'),
    trackEdge: v('track-edge'),
    sector: v('sector'),
    sectorLine: v('sector-line')
  };
}
