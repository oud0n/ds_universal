import { BarChart2, FolderOpen, List, Repeat, Settings, SlidersHorizontal, Timer, Video, type LucideIcon } from 'lucide-react';
import type { Screen } from './navPlan';

/** 画面の名前とアイコン (タブ・サイドバー・⚙ の一覧で共通) */
export const SCREEN_META: Record<Screen, { label: [string, string]; short: [string, string]; Icon: LucideIcon }> = {
  timer: { label: ['ラップタイマー', 'Lap timer'], short: ['タイマー', 'Timer'], Icon: Timer },
  library: { label: ['走行', 'Runs'], short: ['走行', 'Runs'], Icon: FolderOpen },
  analysis: { label: ['グラフ解析', 'Graph'], short: ['解析', 'Graph'], Icon: BarChart2 },
  video: { label: ['動画同期', 'Video'], short: ['動画', 'Video'], Icon: Video },
  data: { label: ['データ管理', 'Data'], short: ['データ', 'Data'], Icon: List },
  convert: { label: ['ログ変換', 'Convert'], short: ['変換', 'Convert'], Icon: Repeat },
  logger: { label: ['ロガー設定', 'Logger'], short: ['ロガー', 'Logger'], Icon: Settings },
  settings: { label: ['設定', 'Settings'], short: ['設定', 'Settings'], Icon: SlidersHorizontal }
};
