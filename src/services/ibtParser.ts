export * from '../engine/ibtParser';
import * as core from '../engine/ibtParser';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const isIbt: typeof core.isIbt = withEngineErrors(core.isIbt);
export const parseIbtSessionInfo: typeof core.parseIbtSessionInfo = withEngineErrors(core.parseIbtSessionInfo);
export const parseIbt: typeof core.parseIbt = withEngineErrors(withLogPreferences(core.parseIbt));

import {withLogPreferences} from '../adapters/web/logPreferences';
