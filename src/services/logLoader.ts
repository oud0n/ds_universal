/**
 * ログのファイルを読み、走行ごとの点の並びにする (2026-10-21 に App.tsx の loadFileData から切り出した。取り込みの画面と共通にするため)。
 * 形式は拡張子と中身の先頭で判別する。1 つのファイルに走行が複数入っているとき (生ログ・iRacing・記録の空きのある NMEA) は、走行ごとに分ける。
 * 位置として正しい点が 2 点に満たない走行は捨てる
 */

import { parseDtb } from './dtbParser';
import { parseDigispiceRawBinary, SESSION_GAP_SEC } from './rawBinaryParser';
import { parseCsv } from './csvParser';
import { parseNmea } from './nmeaParser';
import { inflateXrz, isAimCsv, isXrk, parseAimCsv, parseXrk } from './aimFormats';
import { isIbt, parseIbt } from './ibtParser';
import { MOTEC_CSV_ENABLED, isGpx, isMotecCsv, isRaceChronoCsv, isTcx, isVbo, parseMotecCsv, parseGpx, parseRaceChronoCsv, parseTcx, parseVbo } from './externalFormats';
import { parseFit } from './fitParser';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ParsedPart {
  points: any[];
  samplingRate: number;
  startDate?: Date;
}

export interface ParsedLog {
  parts: ParsedPart[];
  /** ログに記録されている車両名・ドライバー名・コース名 (iRacing の .ibt) */
  meta: { vehicleName?: string; driverName?: string; trackName?: string };
  /** 読んだ形式 */
  kind: string;
}

type Tr = (ja: string, en: string) => string;

/** ログの拡張子 (取り込みの対象。動画・コースのファイルは含めない) */
export const LOG_EXTENSIONS = ['dtb', 'bnx4', 'bon4', 'binx', 'bon', 'xrk', 'xrz', 'fit', 'ibt', 'vbo', 'csv', 'txt', 'gpx', 'tcx', 'nmea', 'log'];

/** 点の並びを、記録の空き (SESSION_GAP_SEC 以上) で分ける (.bon4 の分け方・周の一覧の part の番号とそろえる) */
export function splitByGaps(points: any[]): any[][] {
  const out: any[][] = [];
  for (const p of points) {
    const cur = out[out.length - 1];
    if (cur && p.time - cur[cur.length - 1].time < SESSION_GAP_SEC) cur.push(p);
    else out.push([p]);
  }
  return out;
}

const validPos = (p: any) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180 && !(p.latitude === 0 && p.longitude === 0);

export async function parseLogBuffer(fileName: string, buffer: ArrayBuffer, tr: Tr): Promise<ParsedLog> {
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
  let parts: ParsedPart[] | null = null;
  let single: ParsedPart | null = null;
  let meta: ParsedLog['meta'] = {};
  let kind = ext || '';

  if (ext === 'dtb') {
    single = parseDtb(buffer);
  } else if (ext === 'bnx4' || ext === 'bon4' || ext === 'binx' || ext === 'bon') {
    parts = parseDigispiceRawBinary(fileName, buffer);
  } else if (ext === 'xrk' || ext === 'xrz') {
    // AiM のロガーのファイル (.xrz は圧縮したもの)
    const bytes = await inflateXrz(new Uint8Array(buffer));
    if (!isXrk(bytes)) throw new Error(tr('AiM の .xrk / .xrz として読めませんでした', 'Could not read this as an AiM .xrk / .xrz file'));
    single = parseXrk(bytes);
  } else if (ext === 'fit') {
    // Garmin などの FIT (腕時計・サイクルコンピューターの記録)
    single = parseFit(new Uint8Array(buffer));
  } else if (ext === 'ibt') {
    // iRacing のテレメトリ。コースに出ていた間ごとに分ける (ピットへの移動などで区切る)
    const bytes = new Uint8Array(buffer);
    if (!isIbt(bytes)) throw new Error(tr('iRacing の .ibt として読めませんでした', 'Could not read this as an iRacing .ibt file'));
    const parsed = parseIbt(bytes);
    parts = parsed.parts;
    meta = { vehicleName: parsed.vehicleName, driverName: parsed.driverName, trackName: parsed.trackName };
  } else if (['vbo', 'csv', 'txt', 'gpx', 'tcx', 'nmea', 'log'].includes(ext || '')) {
    // テキストの形式は拡張子で決めつけず、中身の先頭で判別する (.txt の NMEA・VBO、.log の CSV なども読めるように)。
    // 判別できないときは拡張子に従う
    const text = new TextDecoder('utf-8').decode(buffer);
    // NMEA は受信機の起動時の文などの後から始まることがあるので、先頭から広めに (64 KB) 探す
    const head = text.slice(0, 65536);
    // CSV の見出し行 (緯度・経度の列がある行) があるか
    const csvLike = isRaceChronoCsv(text) || isMotecCsv(text) || isAimCsv(text) ||
      /^(?=[^\n]*(lat|緯度))(?=[^\n]*(lon|lng|経度))[^\n]*,/im.test(text.slice(0, 4000));
    kind =
      isGpx(text) ? 'gpx'
      : isTcx(text) ? 'tcx'
      : isVbo(text) ? 'vbo'
      : /^\s*\$G[PNLAB][A-Z]{3},/m.test(head) ? 'nmea'
      : csvLike ? 'csv'
      : ext === 'vbo' || ext === 'gpx' || ext === 'tcx' || ext === 'nmea' ? ext
      : ext === 'log' ? 'nmea'
      : 'csv';
    if (kind === 'gpx') single = parseGpx(text);
    else if (kind === 'tcx') single = parseTcx(text);
    else if (kind === 'vbo') single = parseVbo(text);
    else if (kind === 'nmea') {
      // NMEA も、記録の空き (10 分以上) で走行を分ける (.bon4・周の一覧と同じ分け方。2026-10-21)
      const parsed = parseNmea(text, fileName);
      parts = splitByGaps(parsed.points).map(points => ({ points, samplingRate: parsed.samplingRate, startDate: parsed.startDate }));
    } else {
      // 他社形式の CSV は先頭の書式で判別する
      // MoTeC CSV は単位行などの構造が汎用 CSV と違うため、無効の間は汎用の読み込みに回さず断る
      if (isMotecCsv(text) && !MOTEC_CSV_ENABLED) {
        throw new Error(tr('MoTeC CSV の読み込みには現在対応していません', 'Loading MoTeC CSV is not supported at the moment'));
      }
      single = isRaceChronoCsv(text) ? parseRaceChronoCsv(text)
        : isAimCsv(text) ? parseAimCsv(text)
        : isMotecCsv(text) ? parseMotecCsv(text)
        : parseCsv(text);
    }
  } else {
    throw new Error(`${tr('未対応のファイル形式です', 'Unsupported file type')}: ${ext ? `.${ext}` : tr('(拡張子なし)', '(no extension)')}`);
  }

  if (!parts) parts = single ? [{ points: single.points, samplingRate: single.samplingRate, startDate: single.startDate }] : [];
  // 位置として正しい点が 2 点に満たない走行は捨てる (違う中身のファイルを生ログなどとして読むと、でたらめな 1 点ができることがあるため)
  parts = parts.filter(p => p.points.filter(validPos).length >= 2);
  if (parts.length === 0 || parts.every(p => p.points.length === 0)) {
    throw new Error(tr('有効なGPS位置データが見つかりませんでした', 'No valid GPS position data was found'));
  }
  return { parts, meta, kind };
}
