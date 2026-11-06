export * from '../engine/nmeaParser';

import {withLogPreferences} from '../adapters/web/logPreferences';
import * as core from '../engine/nmeaParser';
export const parseNmea: typeof core.parseNmea = withLogPreferences(core.parseNmea, 2);
