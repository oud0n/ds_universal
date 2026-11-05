export * from '../engine/fitParser';
import * as core from '../engine/fitParser';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const isFit: typeof core.isFit = withEngineErrors(core.isFit);
export const parseFit: typeof core.parseFit = withEngineErrors(withLogPreferences(core.parseFit));

import {withLogPreferences} from '../adapters/web/logPreferences';
