import { describe, expect, it, vi } from 'vitest';
import { type LapFolder } from '../services/lapHistory';
import type { LapRow } from '../services/lapIndex';
import { NO_FILTER } from '../services/runFilters';
import type { RunStore } from '../services/runStore';
import type { Lap, Session } from '../types/telemetry';
import { loadedPickerRows, pickerTable, readPickerHistory, storedPickerRows } from './lapPickerRows';

const store = {
  list: async () => [{ path: 'sodegaura/run.bon4', size: 4, mtimeMs: 10 }],
  readTextStrict: async () => null,
  writeText: vi.fn(async () => {})
} as unknown as RunStore;

describe('ラップの一覧を読む', () => {
  it('空の一覧と途中の読み取りエラーを区別し、壊れた控えを書かない', async () => {
    const signal = new AbortController().signal;
    await expect(readPickerHistory({ ...store, list: async () => [] }, signal)).resolves.toEqual([]);
    const unreadable = { ...store, read: async () => { throw new Error('offline'); } };
    await expect(readPickerHistory(unreadable, signal)).rejects.toThrow('offline');
    expect(store.writeText).not.toHaveBeenCalled();
  });

  it('保管場所を替えた後で前の読み取りが完了しても、その一覧を返さず控えも更新しない', async () => {
    const controller = new AbortController();
    let finish!: (bytes: Uint8Array) => void;
    const read = vi.fn(() => new Promise<Uint8Array>(resolve => { finish = resolve; }));
    const loading = readPickerHistory({ ...store, read }, controller.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    controller.abort();
    finish(new Uint8Array());
    await expect(loading).rejects.toThrow('Cancelled');
    expect(store.writeText).not.toHaveBeenCalled();
  });
});

describe('ラップの絞り込みと選択', () => {
  it('同じ開始時刻と周番号でも、元の走行・まとまり・ファイル情報を保持する', () => {
    const row = (file: string, part: number, time: number, hidden = false): LapRow => ({
      folder: 'course', file, n: 1, part, time, hidden, startMs: 100, runStartMs: 100, sectors: [], topSpeed: 0
    });
    const rows = [row('own', 1, 80), row('own', 2, 65, true), row('ref', 1, 70), row('other', 1, 75)];
    const rec = { size: 40, mtimeMs: 20, startMs: 100, laps: [] };
    const folder: LapFolder = { folder: 'course', courseName: 'Course', fileCount: 3, rows,
      index: { version: 1, courseHash: 'hash', courseName: 'Course', hidden: [], files: { own: rec, ref: rec, other: rec } },
      references: { ref: '' }, conditions: { own: { car: 'A' }, ref: { car: 'A' }, other: { car: 'B' } } };
    const items = storedPickerRows(folder, store, 13);
    expect(new Set(items.map(i => i.key)).size).toBe(4);
    expect(items[1].choice).toMatchObject({ kind: 'stored', store, storageRevision: 13, row: rows[1], courseHash: 'hash', size: 40, mtimeMs: 20 });
    const result = pickerTable(items, { ...NO_FILTER, car: 'A' }, false, 'time');
    expect(result.times).toEqual([80]);
    expect(result.visible.map(r => r.run)).toEqual(['ref', 'own']);
    expect(pickerTable(items, NO_FILTER, true, 'time').times).toEqual([75, 80]);
    expect(pickerTable(items, NO_FILTER, true, 'time').visible[0].choice).toBe(items[1].choice);
  });

  it('同名・同時刻の読み込み済みログにも別々のセッションと実際の周を渡す', () => {
    const lap = { lapNumber: 1, lapTime: 30, points: [] } as unknown as Lap;
    const a = { id: 'a', fileName: 'run', date: '2026-01-01', points: [], laps: [lap] } as unknown as Session;
    const b = { ...a, id: 'b', laps: [{ ...lap, points: [] }] };
    const [first, second] = loadedPickerRows([a, b]);
    expect(first.key).not.toBe(second.key);
    expect(first.choice.kind === 'loaded' && first.choice.session).toBe(a);
    expect(second.choice.kind === 'loaded' && second.choice.lap).toBe(b.laps[0]);
    expect(second.choice.kind === 'loaded' && second.choice.lap.points).not.toBe(lap.points);
  });
});
