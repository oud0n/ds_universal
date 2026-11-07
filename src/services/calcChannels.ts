export * from '../engine/calcChannels';
import * as core from '../engine/calcChannels';
import { withEngineErrors } from '../adapters/web/engineErrors';
export const parseExpr: typeof core.parseExpr = withEngineErrors(core.parseExpr);
export const exprVars: typeof core.exprVars = withEngineErrors(core.exprVars);
export const compileExpr: typeof core.compileExpr = withEngineErrors(core.compileExpr);
export const parseCalcFile: typeof core.parseCalcFile = withEngineErrors(core.parseCalcFile);
