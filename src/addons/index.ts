import mod from 'virtual:laploupe-addons';
import none from './none';
import { ADDON_API_VERSION, type AddonModule } from './api';

export type { AddonModule, LapListView, LapListViewProps } from './api';

export const addons: AddonModule = mod.apiVersion === ADDON_API_VERSION ? mod : none;
