import { parseLogBuffer as parse } from '../engine/logLoader';
import { currentCsvFormats } from './csvFormatStore';
import { getGFilterLevel } from './physics';
import { localizeEngineError } from '../adapters/web/engineErrors';
export * from '../engine/logLoader';
export async function parseLogBuffer(fileName: string, buffer: ArrayBuffer, tr: (ja: string, en: string) => string) {
  const level = getGFilterLevel(), formats = currentCsvFormats();
  try { return await parse(fileName, buffer, tr, formats, level); }
  catch (error) { throw localizeEngineError(error); }
}
