/**
 * 組み方ごとに、どの画面があり、どこに出すか (下のタブ・サイドバー・上のタブ・⚙ の中)。2026-10-21 (PLAN-24 の 2)。
 * 「データ」は解析の引き出し (作る順番の 6) ができるまでの仮の置き場
 */

import type { AppProfile } from './appProfile';

export type Screen =
  | 'timer' | 'library' | 'analysis' | 'video'
  | 'data' | 'convert' | 'logger' | 'settings';

export interface NavPlan {
  /** 画面の切り替えをどこに出すか */
  chrome: 'bottom' | 'sidebar' | 'top';
  /** タブ・サイドバーに並べる画面 */
  primary: Screen[];
  /** ⚙ (スマートフォン) かサイドバーの下から行く画面 */
  more: Screen[];
  /** 最初に開く画面 */
  home: Screen;
  available: ReadonlySet<Screen>;
}

/** 一覧から外す (その環境でできないもの) */
const only = (list: (Screen | false)[]): Screen[] => list.filter((s): s is Screen => s !== false);

export function navPlan(p: AppProfile): NavPlan {
  let chrome: NavPlan['chrome'];
  let primary: Screen[];
  let more: Screen[];
  let home: Screen;
  switch (p.kind) {
    case 'app-phone':
      chrome = 'bottom';
      primary = only([p.hasLapTimer && 'timer', p.hasLibrary && 'library', 'analysis', 'video']);
      more = only(['data', 'convert', p.hasLogger && 'logger', 'settings']);
      home = p.hasLibrary ? 'library' : 'analysis';
      break;
    case 'app-tablet':
      chrome = 'sidebar';
      primary = only([p.hasLibrary && 'library', 'analysis', 'data', 'video', p.hasLapTimer && 'timer', p.hasLogger && 'logger', 'convert']);
      more = ['settings'];
      home = p.hasLibrary ? 'library' : 'analysis';
      break;
    case 'desktop':
      chrome = 'sidebar';
      primary = only([p.hasLibrary && 'library', 'analysis', 'data', 'video', p.hasLogger && 'logger', 'convert']);
      more = only([p.hasLapTimer && 'timer', 'settings']);
      home = p.hasLibrary ? 'library' : 'analysis';
      break;
    case 'browser-phone':
      chrome = 'bottom';
      // 下のタブは 3 つに絞り、データ・ロガーは ⚙ から (アプリのスマートフォンと同じ。導線のレビューの P2)
      primary = only(['analysis', 'video', 'convert']);
      more = only(['data', p.hasLogger && 'logger', p.hasLibrary && 'library', p.hasLapTimer && 'timer', 'settings']);
      home = 'analysis';
      break;
    default:
      chrome = 'top';
      primary = only(['analysis', 'video', 'data', 'convert', p.hasLogger && 'logger']);
      more = only([p.hasLapTimer && 'timer', 'settings']);
      home = 'analysis';
  }
  return { chrome, primary, more, home, available: new Set([...primary, ...more]) };
}
