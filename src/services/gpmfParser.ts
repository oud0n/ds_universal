export * from '../engine/gpmfParser';
import * as core from '../engine/gpmfParser';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const blobByteSource: typeof core.blobByteSource = withEngineErrors(core.blobByteSource);
export const parseGoproGps: typeof core.parseGoproGps = withEngineErrors(withLogPreferences(core.parseGoproGps, 1));
export const goproRecording: typeof core.goproRecording = withEngineErrors(core.goproRecording);

import {withLogPreferences} from '../adapters/web/logPreferences';
