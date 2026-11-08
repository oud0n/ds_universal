import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { CIRCUIT_PRESETS } from './circuitDatabase';
import { SPLIT_RULE, courseHash, lapsFromNmea, setHidden, type LapIndex } from './lapIndex';
import { loadLapHistory } from './lapHistory';
import * as courses from './storageCourses';
import { userCircuitStorage } from './userCircuitStorage';

it('新保存先のコースが準備できるまで索引を書かず、隠した周を維持する', async () => {
  await userCircuitStorage.ready;
  const preset = CIRCUIT_PRESETS.find(c => c.id === 'sodegaura')!;
  const course = { name: preset.name, controlLine: preset.controlLine!, sectors: preset.sectors };
  const bytes = new Uint8Array(readFileSync(new URL('../../public/demo/sodegaura_20260815.nmea', import.meta.url)));
  const measured = lapsFromNmea('demo.nmea', bytes, course);
  let index: LapIndex = { version: 1, courseName: course.name, courseHash: courseHash(course), files: { 'demo.nmea': { size: bytes.length, mtimeMs: 1, ...measured, split: SPLIT_RULE } }, hidden: [] };
  index = setHidden(index, 'demo.nmea', undefined, measured.laps[0].n, true);
  const hidden = index.hidden;
  let fresh = false, release!: () => void;
  const gate = new Promise<number>(resolve => { release = () => { fresh = true; resolve(1); }; });
  vi.spyOn(courses, 'loadStorageCourses').mockReturnValue(gate);
  vi.spyOn(userCircuitStorage, 'getEditedCircuits').mockImplementation(() => fresh ? [] : [{ id: 'old-root', name: preset.name, folder: 'sodegaura', controlLine: { ...preset.controlLine!, latA: 0, latB: 0 }, sectors: [], sources: { cln: 'old-root.cln' } }]);
  const write = vi.fn(async (_path: string, text: string) => { index = JSON.parse(text); });
  try {
    const scan = loadLapHistory({ list: async () => [{ path: 'sodegaura/demo.nmea', size: bytes.length, mtimeMs: 1 }], read: async () => bytes, readText: async path => path.endsWith('laptimes.json') ? JSON.stringify(index) : null, writeText: write });
    await Promise.resolve(); await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    release();
    const folders = await scan;
    expect(write).not.toHaveBeenCalled();
    expect(folders[0].index!.courseHash).toBe(courseHash(course));
    expect(folders[0].index!.hidden).toEqual(hidden);
    expect(index.hidden).toEqual(hidden);
    expect(folders[0].rows.filter(r => r.hidden)).toHaveLength(1);
  } finally { vi.restoreAllMocks(); }
});
