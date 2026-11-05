export * from '../engine/rawBinaryParser';
import * as core from '../engine/rawBinaryParser';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const parseDigispiceRawBinary: typeof core.parseDigispiceRawBinary = withEngineErrors(withLogPreferences(core.parseDigispiceRawBinary));
export const keepRunParts: typeof core.keepRunParts = withEngineErrors(core.keepRunParts);

import {withLogPreferences} from '../adapters/web/logPreferences';
