export * from '../engine/lapAssignmentState';
import * as core from '../engine/lapAssignmentState';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const createAnalysisStore: typeof core.createAnalysisStore = withEngineErrors(core.createAnalysisStore);
export const assignLap: typeof core.assignLap = withEngineErrors(core.assignLap);
export const reuseStoredSessions: typeof core.reuseStoredSessions = withEngineErrors(core.reuseStoredSessions);
export const applyRunMetadata: typeof core.applyRunMetadata = withEngineErrors(core.applyRunMetadata);
export const selectAvailableCars: typeof core.selectAvailableCars = withEngineErrors(core.selectAvailableCars);
