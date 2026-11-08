import { describe, expect, it } from 'vitest';
import { libraryAdmissions, libraryDecision } from './libraryAdmission';
import type { LapFileRecord, LapIndex } from './lapIndex';
import type { RunsFile } from './runsFile';

const t = 1_800_000_000_000;
const rec = (...ranges: [number, number][]): LapFileRecord => ({ size: 100, mtimeMs: 1, startMs: t,
  laps: ranges.map(([start, time], i) => ({ n: 1, part: i + 1, startMs: t + start * 1000, time, sectors: [], topSpeed: 100 })) });
const index = (files: LapIndex['files']): LapIndex => ({ version: 1, courseHash: 'x', courseName: 'c', files, hidden: [] });
const files = { '20261101/first.nmea': rec([0, 900]), '20261101/second.nmea': rec([3600, 900]), '20261101/day.bnx4': rec([-60, 1020], [3540, 1020]) };
const choices = (include: boolean): RunsFile => ({ version: 2, runs: { '20261101/day.bnx4': { updatedAt: '', libraryDecision: { file: '20261101/day.bnx4', size: 100, mtimeMs: 1, include } } } });

describe('ライブラリへの追加確認', () => {
  it('枠別ログを残し、両方を含む全体ログの追加を確認する', () => {
    const a = libraryAdmissions(index(files), null);
    expect(a['20261101/first.nmea'].status).toBe('included');
    expect(a['20261101/second.nmea'].status).toBe('included');
    expect(a['20261101/day.bnx4'].status).toBe('pending');
    expect(a['20261101/day.bnx4'].overlaps.map(o => o.file).sort()).toEqual(['20261101/first.nmea', '20261101/second.nmea']);
  });
  it('追加する選択で、既存ログを新たな確認待ちにしない', () => {
    expect(Object.values(libraryAdmissions(index(files), choices(true))).map(a => a.status)).toEqual(['included', 'included', 'included']);
  });
  it('追加しない選択はファイルが同じ版の間だけ有効', () => {
    expect(libraryAdmissions(index(files), choices(false))['20261101/day.bnx4'].status).toBe('excluded');
    const changed = { ...files, '20261101/day.bnx4': { ...files['20261101/day.bnx4'], mtimeMs: 2 } };
    expect(libraryAdmissions(index(changed), choices(false))['20261101/day.bnx4'].status).toBe('pending');
    for (const value of [null, true, { file: 'other', size: 100, mtimeMs: 1, include: false }, { file: 'a', size: 100, mtimeMs: 1, include: 'false' }]) expect(libraryDecision('a', rec([0, 90]), value)).toBeUndefined();
  });
  it('枠間の空きやUTC不明・再計算待ち・60秒未満を重複と判定しない', () => {
    const a = libraryAdmissions(index({ 'a.nmea': rec([0, 90], [3600, 90]), 'gap.bnx4': rec([900, 90]), 'short.bnx4': rec([60, 90]), 'unknown.bnx4': { ...rec([0, 90]), startMs: null }, 'retry.bnx4': { ...rec([0, 90]), needsRecompute: true } }), null);
    expect(Object.values(a).every(a => a.status === 'included')).toBe(true);
  });
  it('同形式・部分重複も確認し、ちょうど60秒の重複を含める', () => {
    const a = libraryAdmissions(index({ 'a.gpx': rec([0, 90]), 'b.gpx': rec([30, 90]) }), null);
    expect(a['b.gpx'].status).toBe('pending');
    expect(a['b.gpx'].overlaps[0].overlapSec).toBe(60);
  });
  it('同名の別日ファイルへ選択を流用しない', () => {
    const a = libraryAdmissions(index({ '20261102/day.bnx4': rec([0, 90]) }), choices(false));
    expect(a['20261102/day.bnx4'].status).toBe('included');
  });
});
