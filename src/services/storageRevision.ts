import {createStorageContext} from '../engine/storageContext';
import {withEngineErrors} from '../adapters/web/engineErrors';
export {StorageChangedError} from '../engine/storageContext';
const context=createStorageContext();
export const storageContext={...context,
 trackStorageSelection:withEngineErrors(context.trackStorageSelection),
 pickDesktopStorage:withEngineErrors(context.pickDesktopStorage),
 revisionBoundStore:(...args:Parameters<typeof context.revisionBoundStore>)=>{
  const store=context.revisionBoundStore(...args);
  for(const key of Object.keys(store) as Array<keyof typeof store>){const value=store[key];if(typeof value==='function')Object.assign(store,{[key]:withEngineErrors(value as (...args:any[])=>any)});}
  if(store.trash)for(const key of Object.keys(store.trash) as Array<keyof typeof store.trash>)store.trash[key]=withEngineErrors(store.trash[key]) as any;
  return store;
 }
};
export const {getStorageRevision,getStorageReadRevision,isStorageSelectionPending,subscribeStorageRevision,subscribeBeforeStorageSelection,invalidateStorageReads,invalidateStorageRevision,trackStorageSelection,pickDesktopStorage,revisionBoundStore}=storageContext;
