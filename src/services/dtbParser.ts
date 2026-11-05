export * from '../engine/dtbParser';
import * as core from '../engine/dtbParser';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const decodeExtendedFloat: typeof core.decodeExtendedFloat = withEngineErrors(core.decodeExtendedFloat);
export const encodeExtendedFloat: typeof core.encodeExtendedFloat = withEngineErrors(core.encodeExtendedFloat);
export const oleDateToDate: typeof core.oleDateToDate = withEngineErrors(core.oleDateToDate);
export const dateToOleDate: typeof core.dateToOleDate = withEngineErrors(core.dateToOleDate);
export const parseDtb: typeof core.parseDtb = withEngineErrors(withLogPreferences(core.parseDtb));
export const exportDtb: typeof core.exportDtb = withEngineErrors(core.exportDtb);

import {withLogPreferences} from '../adapters/web/logPreferences';
