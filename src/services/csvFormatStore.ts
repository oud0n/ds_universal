import {useSyncExternalStore} from 'react';
import {createCsvFormatStore} from '../engine/csvFormatStore';
import {storageContext} from './storageRevision';
import {canUseRunStore,getRunStore} from './runStore';
import {setCustomChannels} from './overlayLayout';
import {webScheduler,webPreferences} from '../adapters/web/runtime';
import {withEngineErrors} from '../adapters/web/engineErrors';
export {FORMATS_DIR,CALC_FILE,safeName} from '../engine/csvFormatStore';
export const csvFormatStore=createCsvFormatStore({storage:storageContext,repository:()=>canUseRunStore()?getRunStore():Promise.resolve(null),preferences:webPreferences,scheduler:webScheduler,channelsChanged:specs=>setCustomChannels(specs)});
export const currentCsvFormats: typeof csvFormatStore.currentCsvFormats=withEngineErrors(csvFormatStore.currentCsvFormats);
export const csvFormatsReady: typeof csvFormatStore.csvFormatsReady=withEngineErrors(csvFormatStore.csvFormatsReady);
export const loadCsvFormats: typeof csvFormatStore.loadCsvFormats=withEngineErrors(csvFormatStore.loadCsvFormats);
export const saveCsvFormat: typeof csvFormatStore.saveCsvFormat=withEngineErrors(csvFormatStore.saveCsvFormat);
export const deleteCsvFormat: typeof csvFormatStore.deleteCsvFormat=withEngineErrors(csvFormatStore.deleteCsvFormat);
export const saveCalcChannels: typeof csvFormatStore.saveCalcChannels=withEngineErrors(csvFormatStore.saveCalcChannels);
export function useCsvFormats(){return useSyncExternalStore(csvFormatStore.subscribe,csvFormatStore.getSnapshot);}
