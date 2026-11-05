import { parseLogBuffer as parse } from '../engine/logLoader';
import { currentCsvFormats } from './csvFormatStore';
import { applyGFilter, getGFilterLevel } from './physics';
import { localizeEngineError } from '../adapters/web/engineErrors';
export * from '../engine/logLoader';
export async function parseLogBuffer(fileName: string, buffer: ArrayBuffer, tr: (ja: string, en: string) => string) {
  const level = getGFilterLevel(), formats = currentCsvFormats();
  try { const log = await parse(fileName, buffer, tr, formats);for (const part of log.parts) applyGFilter(part.points, level);return log; }
  catch (error) { throw localizeEngineError(error); }
}
