export * from '../engine/gpmfParser';
import * as core from '../engine/gpmfParser';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const blobByteSource: typeof core.blobByteSource = withEngineErrors(core.blobByteSource);
const readGps=withEngineErrors(core.parseGoproGps);
export async function parseGoproGps(sources:core.ByteSource[],physicsLevel=getGFilterLevel()) {
 return {...await readGps(sources,physicsLevel),physicsLevel};
}
export const goproRecording: typeof core.goproRecording = withEngineErrors(core.goproRecording);

import {getGFilterLevel} from './physics';
