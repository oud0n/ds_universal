export * from '../engine/videoMetadataParser';
import * as core from '../engine/videoMetadataParser';
import {withEngineErrors} from '../adapters/web/engineErrors';
export const parseVideoMetadata:typeof core.parseVideoMetadata=withEngineErrors(core.parseVideoMetadata);
