import type { ComponentType } from 'react';
import type { RunItem } from '../services/runOpener';

export const ADDON_API_VERSION = 1;

export interface LapListViewProps {
  laps: RunItem['laps'];
  order: 'run' | 'time';
}

export interface LapListView {
  id: string;
  label: [string, string];
  Component: ComponentType<LapListViewProps>;
}

export interface AddonModule {
  apiVersion: number;
  name: string;
  lapListViews?: LapListView[];
}
