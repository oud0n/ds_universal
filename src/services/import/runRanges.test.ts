import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { rangeCandidates, readRunRanges, runFilesByBase } from './runRanges';
import { applyOverlaps, planImport } from './importPlan';
import { parseLogBuffer } from '../logLoader';

const tr = (ja: string) => ja;

describe('保管場所の走行の始め・終わり (PLAN-43)', () => {
  it('走行のファイルは .nmea を先に、拡張子なしの道ごとに 1 つ', () => {
    const m = runFilesByBase(['a/1/x.bon4', 'a/1/x.nmea', 'a/1/y.bon4', 'a/1/z.mov', 'a/1/x.iphone_imu.csv']);
    expect([...m]).toEqual([['a/1/x', 'a/1/x.nmea'], ['a/1/y', 'a/1/y.bon4']]);
  });

  it('読む候補は、同じサーキットのフォルダで名前の時刻が近いものだけ (取り込み元/ は外す)', () => {
    const t = new Date(2026, 9, 30, 12, 0).getTime();
    const files = runFilesByBase(['sodegaura/20261030/20261030115900.nmea', 'sodegaura/20261029/20261029120000.nmea', 'tsukuba/20261030/20261030120000.nmea', 'sodegaura/取り込み元/20261030120000.nmea']);
    expect(rangeCandidates([{ base: 'sodegaura/20261030/20261030120000', startMs: t, endMs: t + 1800_000 }], files)).toEqual(['sodegaura/20261030/20261030115900.nmea']);
  });
});

// 2026-10-30 の袖ヶ浦: 本体から吸い出した .bnx4 (アプリより 1 分ほど早く記録を始めた) と、アプリで受けた 2 走行 (../private にあるときだけ)
const DIR = `${process.cwd()}/../private/samples/pro_compare_sodegaura_20261030`;
describe.skipIf(!existsSync(`${DIR}/DS4_202610311011.bnx4`))('実際のログ (袖ヶ浦 10/30)', () => {
  it('始まりが 10 秒以上違っても、時間の重なる走行として見つける', async () => {
    const b = readFileSync(`${DIR}/DS4_202610311011.bnx4`);
    const plan = planImport(await parseLogBuffer('DS4_202610311011.bnx4', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), tr), 'DS4_202610311011.bnx4', new Set());
    const stored = ['20261030125425', '20261030135721'].map(s => `sodegaura/20261030/${s}.nmea`);
    const files = runFilesByBase(stored);
    const cands = rangeCandidates(plan.parts, files);
    expect(cands.sort()).toEqual(stored);
    const ranges = await readRunRanges(cands, async p => new Uint8Array(readFileSync(`${DIR}/${p.slice(p.lastIndexOf('/') + 1)}`)), (n, buf) => parseLogBuffer(n, buf, tr));
    const out = applyOverlaps(plan, ranges);
    const laps = out.parts.filter(p => p.kind === 'laps');
    expect(laps.map(p => p.overlaps?.[0]?.base)).toEqual(['sodegaura/20261030/20261030125425', 'sodegaura/20261030/20261030135721']);
    expect(laps.every(p => !p.checked && (p.overlaps?.[0]?.overlapSec ?? 0) > 20 * 60)).toBe(true);
  });
});
