import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadLapHistory, toggleLapHidden, updateLapHidden, type LapFolder } from './lapHistory';
import { setRunLapHidden, type RunItem } from './runOpener';
import { courseHash, lapsFromNmea, SPLIT_RULE, type LapIndex } from './lapIndex';
import { CIRCUIT_PRESETS } from './circuitDatabase';
import * as courses from './storageCourses';
import { invalidateStorageReads } from './storageRevision';
import type { RunStore } from './runStore';
const lap = (n: number) => ({ n, startMs: n * 1000, time: 90, sectors: [], topSpeed: 100 });
const index = (): LapIndex => ({ version: 1, courseHash: 'x', courseName: 'x', hidden: [], files: { 'a.nmea': { size: 1, mtimeMs: 1, startMs: 1000, laps: [lap(1), lap(2)] } } });
function memory(initial: LapIndex) {
  let disk = initial;
  const store = { readText: vi.fn(async () => JSON.stringify(disk)), writeText: vi.fn(async (_p: string, text: string) => { disk = JSON.parse(text); }) };
  return { store, disk: () => disk };
}
it('旧ラップ履歴と走行詳細の別々の古い表示から隠しても、両方の印を保持する', async () => {
  const original = index(), m = memory(original);
  const item = { folder: 'course', index: original } as LapFolder;
  await Promise.all([
    toggleLapHidden(m.store as unknown as RunStore, item, 'a.nmea', undefined, 1, true),
    setRunLapHidden(m.store as unknown as RunStore, { folder: 'course', file: 'a.nmea' } as RunItem, lap(2), true)
  ]);
  expect(m.disk().hidden.map(h => h.n)).toEqual([1, 2]);
});
it('表示した周と最新の開始時刻が違うと保存しない', async () => {
  const current = index();current.files['a.nmea'].laps[0].startMs++;
  const m = memory(current);
  await expect(updateLapHidden(m.store as unknown as RunStore, 'course', 'a.nmea', lap(1), true)).rejects.toThrow();
  expect(m.store.writeText).not.toHaveBeenCalled();
});
it('読込み中の取消で、非表示の更新を採用・保存しない', async () => {
  const m = memory(index());
  let finish!: () => void;
  m.store.readText.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(JSON.stringify(index())); }));
  const pending = updateLapHidden(m.store as unknown as RunStore, 'course', 'a.nmea', lap(1), true);
  await vi.waitFor(() => expect(m.store.readText).toHaveBeenCalled());
  invalidateStorageReads();finish();
  await expect(pending).rejects.toThrow();expect(m.store.writeText).not.toHaveBeenCalled();
});
it('再計算中に旧番号の周を隠しても、開始時刻で新番号へ引き継ぐ', async () => {
  const preset = CIRCUIT_PRESETS.find(c => c.id === 'sodegaura')!;
  const course = { name: preset.name, controlLine: preset.controlLine!, sectors: preset.sectors };
  const bytes = new Uint8Array(readFileSync(new URL('../../public/demo/sodegaura_20260815.nmea', import.meta.url)));
  const measured = lapsFromNmea('a.nmea', bytes, course);
  const old = { ...measured.laps[0], n: 77 };
  let disk: LapIndex = { version: 1, courseHash: courseHash(course), courseName: course.name, hidden: [], files: { 'a.nmea': { size: bytes.length, mtimeMs: 1, ...measured, laps: [old], split: SPLIT_RULE } } };
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(r => { start = r; });
  const held = new Promise<Uint8Array>(r => { release = () => r(bytes); });
  const store = { list: async () => [{ path: 'sodegaura/a.nmea', size: bytes.length, mtimeMs: 2 }], read: async () => { start();return held; }, readText: async (p: string) => p.endsWith('laptimes.json') ? JSON.stringify(disk) : null, writeText: async (_p: string, text: string) => { disk = JSON.parse(text); } };
  const spy = vi.spyOn(courses, 'loadStorageCourses').mockResolvedValue(0);
  try {
    const scan = loadLapHistory(store);await started;
    await updateLapHidden(store, 'sodegaura', 'a.nmea', old, true);
    release();await scan;
    expect(disk.hidden).toEqual([{ file: 'a.nmea', ...(measured.laps[0].part ? { part: measured.laps[0].part } : {}), n: measured.laps[0].n, startMs: measured.laps[0].startMs }]);
  } finally { spy.mockRestore(); }
});

it('再計算の書込み直前に strict 読込みが失敗しても、直前に保存した印を古い値で戻さない', async () => {
  const preset = CIRCUIT_PRESETS.find(c => c.id === 'sodegaura')!;
  const course = { name: preset.name, controlLine: preset.controlLine!, sectors: preset.sectors };
  const bytes = new Uint8Array(readFileSync(new URL('../../public/demo/sodegaura_20260815.nmea', import.meta.url)));
  const measured = lapsFromNmea('a.nmea', bytes, course);
  let disk: LapIndex = { version: 1, courseHash: courseHash(course), courseName: course.name, hidden: [], files: { 'a.nmea': { size: bytes.length, mtimeMs: 1, ...measured, split: SPLIT_RULE } } };
  let release!: () => void, start!: () => void, fail = false;
  const started = new Promise<void>(r => { start = r; });
  const held = new Promise<Uint8Array>(r => { release = () => r(bytes); });
  const write = vi.fn(async (_p: string, text: string) => { disk = JSON.parse(text); });
  const store = { list: async () => [{ path: 'sodegaura/a.nmea', size: bytes.length, mtimeMs: 2 }], read: async () => { start();return held; }, readText: async (p: string) => p.endsWith('laptimes.json') ? JSON.stringify(disk) : null, readTextStrict: async () => { if (fail) throw Error('temporary IO');return JSON.stringify(disk); }, writeText: write };
  const spy = vi.spyOn(courses, 'loadStorageCourses').mockResolvedValue(0);
  try {
    const scan = loadLapHistory(store);await started;
    await updateLapHidden(store, 'sodegaura', 'a.nmea', measured.laps[0], true);
    const saved = structuredClone(disk.hidden);fail = true;release();await scan;
    expect(disk.hidden).toEqual(saved);expect(write).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});
