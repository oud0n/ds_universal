import type { LapRecord } from './lapIndex';
import type { RunFileInfo } from './ports';
import type { RunRow } from './runsFile';
/** 一覧の 1 行 (1 つの走行) */
export interface RunItem {
  storageRevision?: number;
  folder: string;
  /** 走行のファイル名 (folder の中) */
  file: string;
  courseName: string | null;
  startMs: number | null;
  /** 周の数 (隠した周を除く) */
  lapCount: number;
  /** いちばん速い周 (秒。隠した周を除く) */
  best: number | null;
  /** runs.json に書いた動画 */
  videos: string[];
  /** 同期を覚えているか */
  synced: boolean;
  /** 同じフォルダの動画 */
  folderVideos: RunFileInfo[];
  /** 周の一覧 (走った順。hidden: 隠した周。一覧のベスト・周の数には数えない) */
  laps: Array<LapRecord & { hidden: boolean }>;
  /** 周をまだ数えていない (iCloud にだけあって、まだ落としていない)。コースの分からないフォルダ (unsorted) の走行は含めない */
  pending: boolean;
  /** runs.json の行 (無ければ null) */
  entry: RunRow | null;
}

