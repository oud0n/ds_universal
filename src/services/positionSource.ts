import {useSyncExternalStore} from 'react';
import {createPositionSource} from '../engine/positionSource';
import {webPreferences} from '../adapters/web/runtime';
export type {PositionSource} from '../engine/positionSource';
export const positionSource=createPositionSource(webPreferences);
export const {getPositionSource,setPositionSource}=positionSource;
export function usePositionSource(){return useSyncExternalStore(positionSource.subscribe,positionSource.getPositionSource);}
