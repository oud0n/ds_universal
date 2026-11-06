import { createVideoSyncManager, overlappingSessions as overlaps } from '../engine/videoSyncManager';
import type { VideoTrack as CoreVideoTrack, PlacedTrack as CorePlacedTrack } from '../engine/videoTypes';
import { parseVideoMetadata } from './videoMetadataParser';
import { blobByteSource, parseGoproGps } from './gpmfParser';
import { isRemoteVideo, remoteByteSource, remoteFileLike } from './remoteVideo';
import { localizeEngineError } from '../adapters/web/engineErrors';
import type { Session } from '../types/telemetry';
export * from '../engine/videoSyncManager';
export { placeTrack, placeTracks, isClockManual, isLoadedLocalVideo } from '../engine/videoTypes';
export type { SyncProjectData } from '../engine/videoTypes';
export type VideoTrack = CoreVideoTrack<File>;
export type PlacedTrack = CorePlacedTrack<File>;
const model = createVideoSyncManager<File>({
 remoteFile: remote => remoteFileLike(remote), metadata: file => parseVideoMetadata(file),
 gps: (file, remote) => parseGoproGps([remote ? remoteByteSource(remote) : blobByteSource(file)]),
 open: file => URL.createObjectURL(file as Blob), release: handle => URL.revokeObjectURL(handle),
 nowMs: () => Date.now(), random: () => Math.random()
});
const importProject = model.importProjectJson.bind(model);
model.importProjectJson = (...args) => { try { return importProject(...args); } catch (error) { throw localizeEngineError(error); } };
export const videoSyncManager = model;
export function overlappingSessions(track: VideoTrack, sessions: Session[], manager = videoSyncManager): Session[] { return overlaps(track, sessions, manager); }
