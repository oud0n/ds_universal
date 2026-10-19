/**
 * 走行 (docs/video_sets_design.md の 1): 同じ車の 1 回の走行。同じ走行と確かめられたログ (デジスパイスと GoPro の GPS など) と、
 * それらに出している動画をまとめたもの。保存はせず、ログの比べ (pairAnalysis) から組み立てる
 */
import type { Session } from '../types/telemetry';
import type { PairAnalysis } from './clockOffsetEstimator';

export interface RunLog {
  session: Session;
  /** 走行の中で最初のログ (記録のいちばん細かいもの) との比べ。最初のログ自身は null */
  analysis: PairAnalysis | null;
}

export interface Run {
  id: string;
  /** 記録の細かい順。1 つ目が主のログの既定 */
  logs: RunLog[];
}

/** ログの記録の時間 (ログの時刻のまま、ミリ秒) */
function range(s: Session): [number, number] | null {
  const a = s.points[0]?.timestamp;
  const ta = a ? Date.parse(a) : NaN;
  const last = s.points[s.points.length - 1];
  if (!Number.isFinite(ta) || !last) return null;
  return [ta, ta + last.time * 1000];
}

/**
 * ログを走行に分ける。時間が 60 秒以上重なるログの組を比べ、同じ走行と確かめられたものを 1 つの走行にまとめる。
 * analyse は比べる関数 (Web Worker で行い、組ごとに覚えている analyseSessions)
 */
export async function deriveRuns(sessions: Session[], analyse: (a: Session, b: Session) => Promise<PairAnalysis | null>): Promise<Run[]> {
  const sorted = [...sessions].sort((a, b) => (b.samplingRate || 0) - (a.samplingRate || 0));
  const parent = new Map(sorted.map(s => [s.id, s.id]));
  const find = (id: string): string => { const p = parent.get(id)!; return p === id ? id : find(p); };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = range(sorted[i]), b = range(sorted[j]);
      if (!a || !b || Math.min(a[1], b[1]) - Math.max(a[0], b[0]) < 60000) continue;
      if (find(sorted[i].id) === find(sorted[j].id)) continue;
      const r = await analyse(sorted[i], sorted[j]);
      if (r?.sameRun) parent.set(find(sorted[j].id), find(sorted[i].id));
    }
  }
  const groups = new Map<string, Session[]>();
  for (const s of sorted) {
    const root = find(s.id);
    groups.set(root, [...(groups.get(root) ?? []), s]);
  }
  const runs: Run[] = [];
  for (const [root, list] of groups) {
    const logs: RunLog[] = [];
    for (const s of list) logs.push({ session: s, analysis: s === list[0] ? null : await analyse(list[0], s) });
    runs.push({ id: root, logs });
  }
  // 記録の始めの順
  return runs.sort((x, y) => (range(x.logs[0].session)?.[0] ?? 0) - (range(y.logs[0].session)?.[0] ?? 0));
}

/** そのログを含む走行 */
export function runOfSession(runs: Run[], sessionId: string | null | undefined): Run | undefined {
  return sessionId ? runs.find(r => r.logs.some(l => l.session.id === sessionId)) : undefined;
}
