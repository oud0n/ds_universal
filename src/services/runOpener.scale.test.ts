import { describe, expect, it } from 'vitest';
import { listRuns } from './runOpener';
import { courseHash, LAP_INDEX_FILE, type LapIndex } from './lapIndex';
import { courseForFolder } from './lapHistory';
import type { RunFileInfo, RunStore } from './runStore';

/** 走行が数千件あっても、一覧が (控えだけで) すぐ出ること */
describe('listRuns の件数への強さ', () => {
  it('3000 本の走行と 6000 本の動画でも 1 秒以内に並べる', async () => {
    const folder = 'sodegaura';
    const course = await courseForFolder(folder);
    expect(course).not.toBeNull();
    const files: RunFileInfo[] = [];
    const index: LapIndex = { version: 1, courseHash: courseHash(course!), courseName: course!.name, files: {}, hidden: [] };
    for (let i = 0; i < 3000; i++) {
      const day = `2026${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}`;
      const name = `${day}/${day}${String(100000 + i)}.bon4`;
      files.push({ path: `${folder}/${name}`, size: 1000, mtimeMs: 1, local: true });
      files.push({ path: `${folder}/${day}/GX${String(i).padStart(6, '0')}.MP4`, size: 1e9, mtimeMs: 1, local: true });
      files.push({ path: `${folder}/${day}/GX${String(i).padStart(6, '0')}.LRV`, size: 1e8, mtimeMs: 1, local: true });
      index.files[name] = { size: 1000, mtimeMs: 1, startMs: i * 1000, laps: [{ n: 1, time: 80 + (i % 10) }] } as LapIndex['files'][string];
    }
    let reads = 0;
    const store = {
      list: async () => files,
      listAll: async () => files,
      read: async () => { reads++; return new Uint8Array(); },
      readText: async (p: string) => (p === `${folder}/${LAP_INDEX_FILE}` ? JSON.stringify(index) : null),
      readTextStrict: async () => null,
      writeText: async () => {},
      videoUrl: (p: string) => p,
      startDownload: async () => {},
      fileStatus: async () => ({ local: true, downloading: false }),
      supportsVideos: async () => true
    } as unknown as RunStore;
    const t0 = performance.now();
    const runs = await listRuns(store);
    const ms = performance.now() - t0;
    expect(runs).toHaveLength(3000);
    expect(reads).toBe(0);
    expect(ms).toBeLessThan(1000);
  });
});
