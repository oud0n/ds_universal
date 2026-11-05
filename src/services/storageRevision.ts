import { createStorageContext } from '../engine/storageContext';
export { StorageChangedError } from '../engine/storageContext';
const context = createStorageContext();
export const { getStorageRevision, getStorageReadRevision, isStorageSelectionPending, subscribeStorageRevision, subscribeBeforeStorageSelection, invalidateStorageReads, invalidateStorageRevision, trackStorageSelection, pickDesktopStorage, revisionBoundStore } = context;
export const storageContext = context;
