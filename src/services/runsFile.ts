export * from '../engine/runsFile';
import {createRunsFileStore} from '../engine/runsFile';
import {withEngineErrors} from '../adapters/web/engineErrors';
export const runsFileStore=createRunsFileStore();
export const isRunsConflictCopy=runsFileStore.isRunsConflictCopy;
export const noteRunsConflictCopies=runsFileStore.noteRunsConflictCopies;
export const readRunsFile=withEngineErrors(runsFileStore.readRunsFile);
export const updateRun=withEngineErrors(runsFileStore.updateRun);
export const removeRunRow=withEngineErrors(runsFileStore.removeRunRow);

import {parseRunsFileStrict as strictParse} from '../engine/runsFile';
export const parseRunsFileStrict=withEngineErrors(strictParse);
