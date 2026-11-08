import type { LapFileRecord, LapIndex } from './lapIndex';
import { findRunRow, type RunsFile } from './runsFile';

/** 物理ファイルの版ごとの、ライブラリへ追加するかの選択。元ログは変更しない。 */
export interface LibraryDecision {
  file: string;
  size: number;
  mtimeMs: number;
  include: boolean;
}
export interface LibraryOverlap {
  file: string;
  startMs: number;
  endMs: number;
  overlapSec: number;
}
export interface LibraryAdmission {
  status: 'included' | 'pending' | 'excluded';
  size: number;
  mtimeMs: number;
  overlaps: LibraryOverlap[];
}

type Range = { startMs: number; endMs: number };
const MIN_OVERLAP_MS = 60_000;

/** UTCのある完走ラップの範囲。複数枠の間の空きは、重なりに数えない。 */
function rangesOf(record: LapFileRecord): Range[] {
  if (record.startMs === null || !Number.isFinite(record.startMs) || record.needsRecompute) return [];
  const parts = new Map<number, Range>();
  for (const lap of record.laps) {
    if (!Number.isFinite(lap.startMs) || !Number.isFinite(lap.time) || lap.time <= 0) continue;
    const endMs = lap.startMs + lap.time * 1000, key = lap.part ?? 1;
    const range = parts.get(key);
    if (range) {
      range.startMs = Math.min(range.startMs, lap.startMs);
      range.endMs = Math.max(range.endMs, endMs);
    } else parts.set(key, { startMs: lap.startMs, endMs });
  }
  return [...parts.values()].sort((a, b) => a.startMs - b.startMs);
}

/** 壊れた選択や、更新されたファイルに対する古い選択を採用しない。 */
export function libraryDecision(file: string, record: Pick<LapFileRecord, 'size' | 'mtimeMs'>, value: unknown): boolean | undefined {
  if (!value || typeof value !== 'object') return;
  const decision = value as Partial<LibraryDecision>;
  if (decision.file === file && decision.size === record.size && decision.mtimeMs === record.mtimeMs && typeof decision.include === 'boolean') return decision.include;
}

/** 一覧へ自動追加する前に、同じフォルダ内で時間の重なるログを確認候補にする。 */
export function libraryAdmissions(index: LapIndex, runs: RunsFile | null, currentFiles?: ReadonlyMap<string, Pick<LapFileRecord, 'size' | 'mtimeMs'>>): Record<string, LibraryAdmission> {
  const sources = Object.entries(index.files).filter(([file]) => !currentFiles || currentFiles.has(file)).map(([file, record]) => {
    const current = currentFiles?.get(file) ?? record;
    const same = current.size === record.size && current.mtimeMs === record.mtimeMs;
    return { file, record: current, ranges: same ? rangesOf(record) : [],
      decision: libraryDecision(file, current, runs ? findRunRow(runs, file)?.libraryDecision : undefined) };
  });
  const overlaps = new Map<string, Map<string, LibraryOverlap>>();
  const spans = sources.flatMap(source => source.ranges.map(range => ({ file: source.file, ...range }))).sort((a, b) => a.startMs - b.startMs);
  let active: typeof spans = [];
  for (const span of spans) {
    active = active.filter(other => other.endMs >= span.startMs + MIN_OVERLAP_MS);
    for (const other of active) {
      if (other.file === span.file) continue;
      const startMs = Math.max(span.startMs, other.startMs), endMs = Math.min(span.endMs, other.endMs);
      if (endMs - startMs < MIN_OVERLAP_MS) continue;
      for (const [a, b] of [[span.file, other.file], [other.file, span.file]]) {
        let related = overlaps.get(a);
        if (!related) overlaps.set(a, related = new Map());
        const old = related.get(b);
        related.set(b, { file: b, startMs: Math.min(old?.startMs ?? startMs, startMs), endMs: Math.max(old?.endMs ?? endMs, endMs), overlapSec: (old?.overlapSec ?? 0) + (endMs - startMs) / 1000 });
      }
    }
    active.push(span);
  }
  // 枠別NMEA/BON4を先にする。追加の承認で、元の走行を確認待ちへ戻さない。
  const priority = (source: typeof sources[number]) => /\.nmea$/i.test(source.file) ? 0 : /\.bon4$/i.test(source.file) ? 1 : 2;
  sources.sort((a, b) => priority(a) - priority(b) || a.file.localeCompare(b.file));
  // 選択結果によって後続ログの扱いを変えない。確認待ち・除外も元ファイルは存在する。
  const earlier = new Set<string>();
  const out: Record<string, LibraryAdmission> = {};
  for (const source of sources) {
    const related = [...(overlaps.get(source.file)?.values() ?? [])].filter(other => earlier.has(other.file));
    const status = source.decision === false ? 'excluded' : source.decision === true || !related.length ? 'included' : 'pending';
    out[source.file] = { status, size: source.record.size, mtimeMs: source.record.mtimeMs, overlaps: related.sort((a, b) => b.overlapSec - a.overlapSec || a.file.localeCompare(b.file)) };
    earlier.add(source.file);
  }
  return out;
}
