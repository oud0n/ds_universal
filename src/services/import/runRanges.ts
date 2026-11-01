/**
 * 保管場所の走行の始め・終わりを、ファイルを読んで出す (PLAN-43: 開いたログと時間の重なる走行を見つけるため)。
 * 読むのは、開いたログと同じサーキットのフォルダで、名前の時刻が近い走行だけ (1 日に数本なので重くない)
 */
import type { ParsedLog } from '../logLoader';
import { pointMs, stemMs, type ImportPart, type RunRange } from './importPlan';
import type { TelemetryPoint } from '../../types/telemetry';

const HOUR = 3_600_000;
const topFolder = (p: string) => p.slice(0, p.indexOf('/') + 1);

/** 走行のファイル (.nmea を先に。無ければ .bon4) を、拡張子なしの道ごとに 1 つ */
export function runFilesByBase(paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    const m = /^(.*)\.(nmea|bon4)$/i.exec(p);
    if (!m) continue;
    const prev = out.get(m[1]);
    if (!prev || (/\.bon4$/i.test(prev) && /\.nmea$/i.test(p))) out.set(m[1], p);
  }
  return out;
}

/** 読む候補: 部分と同じサーキットのフォルダで、名前の時刻が部分の前 12 時間〜終わりの 1 時間あとのもの */
export function rangeCandidates(parts: ReadonlyArray<Pick<ImportPart, 'base' | 'startMs' | 'endMs'>>, files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [base, path] of files) {
    if (base.includes('取り込み元/')) continue;
    const t = stemMs(base.slice(base.lastIndexOf('/') + 1));
    if (t === null) continue;
    if (parts.some(p => topFolder(p.base) === topFolder(base) && t >= p.startMs - 12 * HOUR && t <= p.endMs + HOUR)) out.push(path);
  }
  return out;
}

/** 読んだログの始め・終わり (点が無ければ null) */
export function rangeOfLog(base: string, log: ParsedLog): RunRange | null {
  let startMs = Infinity, endMs = -Infinity;
  for (const part of log.parts) {
    const pts = part.points as TelemetryPoint[];
    if (!pts.length) continue;
    const a = pointMs(pts[0], part.startDate), b = pointMs(pts[pts.length - 1], part.startDate);
    if (Number.isFinite(a)) startMs = Math.min(startMs, a);
    if (Number.isFinite(b)) endMs = Math.max(endMs, b);
  }
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? { base, startMs, endMs } : null;
}

/** 候補を読んで始め・終わりを出す。読めない (iCloud にだけある など) ものは飛ばす */
export async function readRunRanges(
  candidates: readonly string[],
  read: (path: string) => Promise<Uint8Array>,
  parse: (name: string, buffer: ArrayBuffer) => Promise<ParsedLog>
): Promise<RunRange[]> {
  const out: RunRange[] = [];
  for (const path of candidates) {
    try {
      const bytes = await read(path);
      const name = path.slice(path.lastIndexOf('/') + 1);
      const r = rangeOfLog(path.replace(/\.[^./]+$/, ''), await parse(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
      if (r) out.push(r);
    } catch {
      // 読めない走行は比べない
    }
  }
  return out;
}
