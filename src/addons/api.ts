import type { ComponentType } from 'react';
import type { TelemetryPoint } from '../types/telemetry';
import type { RunItem } from '../services/runOpener';
import type { LapRow } from '../services/lapIndex';
import type { LapReferenceSource } from '../services/timer/lapReferences';

export type { IndexedLap, LapReferenceChoice, LapReferenceContext, LapReferenceSource } from '../services/timer/lapReferences';

export const ADDON_API_VERSION = 3;

export interface LapListViewProps {
  laps: RunItem['laps'];
  order: 'run' | 'time';
}

export interface LapListView {
  id: string;
  label: [string, string];
  Component: ComponentType<LapListViewProps>;
}

export interface LapTableViewProps {
  rows: readonly LapRow[];
  order: 'time' | 'date';
  assign(row: LapRow, slot: 1 | 2 | 3 | 4): void;
}

export interface LapTableView {
  id: string;
  label: [string, string];
  Component: ComponentType<LapTableViewProps>;
}

export interface SettingsSection {
  id: string;
  label: [string, string];
  Component: ComponentType;
}

/** 点の列 (時刻は timestamp か、startDate からの time) */
export interface RunPoints {
  points: TelemetryPoint[];
  startDate?: Date;
}

export interface SameRunViewProps {
  /** 開いたログの部分 */
  incoming: RunPoints & { name: string; kind: string; startMs: number; endMs: number };
  /** 保管場所の、時間の重なる走行 */
  stored: { base: string; startMs: number; endMs: number; load: () => Promise<RunPoints[]> };
  /** 2 つを解析で並べて開く */
  onOpenBoth?: () => void;
}

export interface SameRunView {
  id: string;
  label: [string, string];
  Component: ComponentType<SameRunViewProps>;
}

export interface AddonModule {
  apiVersion: number;
  name: string;
  lapListViews?: LapListView[];
  lapTableViews?: LapTableView[];
  settingsSections?: SettingsSection[];
  lapReferences?: LapReferenceSource[];
  sameRunViews?: SameRunView[];
}
