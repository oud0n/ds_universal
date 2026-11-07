export * from '../engine/runSync';
import * as core from '../engine/runSync';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const syncVideoFromRow: typeof core.syncVideoFromRow = withEngineErrors(core.syncVideoFromRow);
export const syncPinsFromRow: typeof core.syncPinsFromRow = withEngineErrors(core.syncPinsFromRow);
export const rowVideoFromTrack: typeof core.rowVideoFromTrack = withEngineErrors(core.rowVideoFromTrack);
export const rowParts: typeof core.rowParts = withEngineErrors(core.rowParts);
