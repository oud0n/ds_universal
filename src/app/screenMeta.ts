import { BarChart2, FolderOpen, List, Repeat, Settings, SlidersHorizontal, Timer, Video, type LucideIcon } from 'lucide-react';
import type { Screen } from './navPlan';
import { appHost } from './appProfile';

/** 画面の名前とアイコン (タブ・サイドバー・⚙ の一覧で共通) */
export const SCREEN_META: Record<Screen, { label: [string, string]; short: [string, string]; Icon: LucideIcon }> = {
  timer: { label: ['ラップタイマー', 'Lap timer'], short: ['タイマー', 'Timer'], Icon: Timer },
  library: { label: ['走行', 'Runs'], short: ['走行', 'Runs'], Icon: FolderOpen },
  analysis: { label: ['解析', 'Analysis'], short: ['解析', 'Analysis'], Icon: BarChart2 },
  video: { label: ['動画', 'Video'], short: ['動画', 'Video'], Icon: Video },
  data: { label: ['データ', 'Data'], short: ['データ', 'Data'], Icon: List },
  convert: { label: ['変換', 'Convert'], short: ['変換', 'Convert'], Icon: Repeat },
  // アプリ (iPhone・iPad) では中身が機器の登録なので「機器」(screenLabel で替える)
  logger: { label: ['ロガー', 'Logger'], short: ['ロガー', 'Logger'], Icon: Settings },
  settings: { label: ['設定', 'Settings'], short: ['設定', 'Settings'], Icon: SlidersHorizontal }
};

/** 画面の名前 (アプリではロガーの画面を「機器」と呼ぶ。中身が Bluetooth の機器の登録のため)。short: タブに出す短い名前 */
export function screenLabel(s: Screen, short = false): [string, string] {
  if (s === 'logger' && appHost() === 'native') return ['機器', 'Devices'];
  return short ? SCREEN_META[s].short : SCREEN_META[s].label;
}
