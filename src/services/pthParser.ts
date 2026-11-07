import { createCourseParsers } from '../engine/courseFiles';
import { tr } from '../utils/i18n';

export const { parsePth, exportPth, parseCln, exportCln, parseSci } = createCourseParsers(tr);
