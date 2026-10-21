/**
 * 取り込みの案を、保管場所に書く (2026-10-21、取り込みの画面)。書き方 (ファイルを作る口) は ImportWriter で受け取る (デスクトップ版・アプリで別々)。
 * - .nmea: 元が NMEA なら、その時間の元の文をそのまま写す (作り直さない)。ほかの形式なら点から作る
 * - .bon4: 元がデジスパイスの記録で、設定で書くことにしているときだけ (ほかの形式からは作らない)
 * - 元のファイル: 取り込み元/<名前> に、手を加えずに 1 回だけ残す
 * - もうあるファイルは書かない (上書きしない)
 */

import type { TelemetryPoint } from '../../types/telemetry';
import { fixesToBon4, fixesToNmea } from '../runFiles';
import type { LiveFix } from '../liveLapTimer';
import type { ImportPart, ImportPlan } from './importPlan';

export const IMPORT_SOURCE_FOLDER = '取り込み元';

export interface ImportWriter {
  /** 新しいファイルを書く。同じ道のファイルがもうあれば書かずに 'exists' */
  writeNew(path: string, bytes: Uint8Array): Promise<'ok' | 'exists'>;
}

export interface ImportSource {
  name: string;
  bytes: Uint8Array;
}

export interface PartResult {
  id: string;
  base: string;
  written: string[];
  skipped: string[];
  error?: string;
}

const DIGSPICE_KINDS = new Set(['bnx4', 'bon4', 'binx', 'bon']);

function toFixes(points: TelemetryPoint[], startDate?: Date): LiveFix[] {
  return points.map(p => {
    const t = p.timestamp ? Date.parse(p.timestamp) : NaN;
    return {
      tMs: Number.isFinite(t) ? t : (startDate?.getTime() ?? 0) + p.time * 1000,
      latitude: p.latitude,
      longitude: p.longitude,
      speedKmh: p.speed ?? 0,
      altitude: p.altitude,
      valid: true
    };
  });
}

/** RMC の時刻と日付 (hhmmss.ss・ddmmyy) を UTC ミリ秒に */
function rmcMs(line: string): number | null {
  const f = line.split(',');
  const tod = f[1], date = f[9];
  if (!tod || !date || date.length < 6) return null;
  const ms = Date.UTC(2000 + Number(date.slice(4, 6)), Number(date.slice(2, 4)) - 1, Number(date.slice(0, 2)),
    Number(tod.slice(0, 2)), Number(tod.slice(2, 4)), 0) + Math.round(parseFloat(tod.slice(4)) * 1000);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * NMEA の文のうち、fromMs〜toMs の間のものをそのまま返す (時刻は RMC の文で見る。RMC の間にある GGA などの文も一緒に)。
 * 境目はゆるめにとる (前後 1 秒)
 */
export function nmeaSlice(text: string | string[], fromMs: number, toMs: number): string {
  const out: string[] = [];
  let inside = false;
  // 大きなファイルでは、行に分けるのは 1 回だけにする (applyPlan が分けたものを渡す)
  for (const line of typeof text === 'string' ? text.split(/\r?\n/) : text) {
    // 衛星の種類の印は GP・GN・GL・GA・GB・BD・QZ など
    if (/^\$[A-Z]{2}RMC,/.test(line)) {
      const t = rmcMs(line);
      if (t !== null) inside = t >= fromMs - 1000 && t <= toMs + 1000;
    }
    if (inside && line.startsWith('$')) out.push(line);
  }
  return out.length ? out.join('\r\n') + '\r\n' : '';
}

/** 取り込む (印の付いた走行だけ)。onProgress は 1 本終わるごとに */
export async function applyPlan(
  plan: ImportPlan,
  source: ImportSource,
  writer: ImportWriter,
  opts: { writeBon4: boolean; startDate?: Date },
  onProgress?: (done: number, total: number) => void
): Promise<{ results: PartResult[]; sourceWritten: boolean }> {
  const parts = plan.parts.filter(p => p.checked);
  const results: PartResult[] = [];
  const isNmea = plan.sourceKind === 'nmea';
  const lines = isNmea ? new TextDecoder().decode(source.bytes).split(/\r?\n/) : [];
  const enc = new TextEncoder();
  for (const [k, part] of parts.entries()) {
    const r: PartResult = { id: part.id, base: part.base, written: [], skipped: [] };
    try {
      const startDate = part.startDate ?? opts.startDate;
      // 元の文を写せない (日付のある RMC がない など) ときは、点から作る (空のファイルを書かない)
      let nmea = isNmea ? nmeaSlice(lines, part.startMs, part.endMs) : '';
      if (!nmea) nmea = fixesToNmea(toFixes(part.points, startDate));
      if (!nmea) throw new Error('no positions');
      await put(writer, `${part.base}.nmea`, enc.encode(nmea), r);
      if (opts.writeBon4 && DIGSPICE_KINDS.has(plan.sourceKind)) {
        await put(writer, `${part.base}.bon4`, fixesToBon4(toFixes(part.points, startDate)), r);
      }
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
    }
    results.push(r);
    onProgress?.(k + 1, parts.length);
  }
  // 元のファイルを、手を加えずに残す (取り込んだものが 1 つでもあれば。前に書いた走行が残っていて、今回は書かなかったときも
  // (やり直したとき)、元のファイルがまだなければ残す)。名前に道の区切りがあれば外す (取り込み元/ の外へ出ないように)
  let sourceWritten = false;
  if (results.some(r => !r.error && (r.written.length || r.skipped.length))) {
    const safe = source.name.replace(/[\\/]/g, '_').replace(/^\.+/, '_') || 'log';
    sourceWritten = (await writer.writeNew(`${IMPORT_SOURCE_FOLDER}/${safe}`, source.bytes)) === 'ok';
  }
  return { results, sourceWritten };
}

async function put(writer: ImportWriter, path: string, bytes: Uint8Array, r: PartResult) {
  if ((await writer.writeNew(path, bytes)) === 'ok') r.written.push(path);
  else r.skipped.push(path);
}

/** 試験用: 書いた中身をためておく書き方 */
export function memoryWriter(existing: Iterable<string> = []): ImportWriter & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const present = new Set(existing);
  return {
    files,
    async writeNew(path, bytes) {
      if (present.has(path) || files.has(path)) return 'exists';
      files.set(path, bytes);
      return 'ok';
    }
  };
}

export type { ImportPart };
