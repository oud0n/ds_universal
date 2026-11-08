export * from '../engine/overlayLayout';
import {createChannelRegistry} from '../engine/overlayLayout';
export const channelRegistry=createChannelRegistry();
export const {setCustomChannels,channelDef,allChannels,availableChannels,partLabel,resolveLayout,visibleParts}=channelRegistry;
