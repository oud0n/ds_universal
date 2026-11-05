export * from '../engine/aimFormats';
import * as core from '../engine/aimFormats';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const isAimCsv: typeof core.isAimCsv = withEngineErrors(core.isAimCsv);
export const parseAimCsv: typeof core.parseAimCsv = withEngineErrors(withLogPreferences(core.parseAimCsv));
export const inflateXrz: typeof core.inflateXrz = withEngineErrors(core.inflateXrz);
export const isXrk: typeof core.isXrk = withEngineErrors(core.isXrk);
export const parseXrk: typeof core.parseXrk = withEngineErrors(withLogPreferences(core.parseXrk));

import {withLogPreferences} from '../adapters/web/logPreferences';
