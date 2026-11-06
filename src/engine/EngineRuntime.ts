import { createEngineSession, bindStorageLifecycle } from './EngineSession';
import { createStorageContext } from './storageContext';
import { createRunsFileStore } from './runsFile';
import { createLapIndexQueue, type LapCourse } from './lapIndex';
import { createLapHistory } from './lapHistory';
import { createVideoSyncManager, type VideoSyncPorts } from './videoSyncManager';
import { createSyncPinStore } from './syncPinStore';
import { createRunController } from './runController';
import { createCsvFormatStore } from './csvFormatStore';
import { createPairAnalyser, type PairExecutionPort } from './pairAnalysis';
import { createPositionSource } from './positionSource';
import { createChannelRegistry } from './overlayLayout';
import type { BinaryFile, PreferencesPort, RunRepository, SchedulerPort } from './ports';
import type { SyncPin } from './videoSyncPinManager';
import type { RemoteVideo } from './videoTypes';
import type { VideoMetadata } from './videoMetadataParser';

export interface EngineRuntimePorts<TFile extends BinaryFile> {
  media: VideoSyncPorts<TFile>;
  preferences: PreferencesPort;
  scheduler: SchedulerPort;
  repository(): Promise<RunRepository | null>;
  courses: { prepare(): Promise<unknown>; find(folder: string): Promise<LapCourse | null> };
  remoteMetadata(remote: RemoteVideo): Promise<VideoMetadata>;
  pins: { load(key: string): SyncPin[]; save(key: string, pins: SyncPin[]): void };
  runsChanged(): void;
  pairs?: PairExecutionPort;
}

/** 一つのホスト／ウインドウに一つ。別インスタンスの保存先・時計・キューを共有しない。 */
export function createEngineRuntime<TFile extends BinaryFile>(ports: EngineRuntimePorts<TFile>) {
  const storage = createStorageContext();
  const runs = createRunsFileStore();
  const media = createVideoSyncManager(ports.media);
  const pins = createSyncPinStore(key=>ports.pins.load(key),(key,pins)=>ports.pins.save(key,pins));
  const channels = createChannelRegistry();
  const pairs = createPairAnalyser(ports.pairs);
  const positionSource = createPositionSource(ports.preferences);
  const history = createLapHistory(storage, folder => ports.courses.find(folder), () => ports.courses.prepare(), runs, createLapIndexQueue());
  const controller = createRunController({storage, runs, media, pins, history, metadata: remote => ports.remoteMetadata(remote), changed: () => ports.runsChanged(), scheduler: ports.scheduler, nowMs: () => ports.media.nowMs()});
  const formats = createCsvFormatStore({storage, repository: () => ports.repository(), preferences: ports.preferences, scheduler: ports.scheduler, channelsChanged: specs => channels.setCustomChannels(specs)});
  let unbind=()=>{};
  const session=createEngineSession({storage,flush:()=>controller.flushOpenRunsStrict(),onClosing:()=>media.cancelPending(),onClose:()=>{unbind();formats.dispose();controller.dispose();media.dispose();}});
  unbind=bindStorageLifecycle(session,controller);
  return {storage, runs, media, pins, channels, history, controller, formats, session, pairs, positionSource, close:()=>session.close()};
}
