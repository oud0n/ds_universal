import { describe, expect, it, vi } from 'vitest';
import { listRuns, setLibraryDecision } from './runOpener';
import { loadLapHistory, courseForFolder } from './lapHistory';
import { courseHash, SPLIT_RULE, type LapIndex } from './lapIndex';
import { makeReferenceContext } from './timer/lapReferences';
import type { RunStore } from './runStore';
import type { RunsFile } from './runsFile';

async function fixture() {
  const folder = 'sodegaura', course = (await courseForFolder(folder))!;
  const startMs = 1_800_000_000_000;
  const record = { size: 100, mtimeMs: 1, split: SPLIT_RULE, startMs, laps: [{ n: 1, startMs, time: 90, sectors: [], topSpeed: 100 }] };
  const index: LapIndex = { version: 1, courseName: course.name, courseHash: courseHash(course), hidden: [], files: { 'frame.nmea': record, 'day.bnx4': { ...record } } };
  let metadata: string | null = null, failWrite = false, failRead = false;
  const files = Object.keys(index.files).map(file => ({ path: `${folder}/${file}`, size: 100, mtimeMs: 1, local: true }));
  const read = async (path: string) => {
    if (path.endsWith('laptimes.json')) return JSON.stringify(index);
    if (path.endsWith('runs.json')) { if (failRead) throw new Error('read failed'); return metadata; }
    return null;
  };
  const write = vi.fn(async (path: string, text: string) => { if (failWrite) throw new Error('write failed'); if (path.endsWith('runs.json')) metadata = text; });
  const store = { list: async () => files, listAll: async () => files, read: async () => { throw new Error('logs should not be read'); }, readText: read, readTextStrict: read, writeText: write } as unknown as RunStore;
  return { folder, course, index, files, store, write, metadata: () => JSON.parse(metadata!) as RunsFile, failWrite: (v: boolean) => { failWrite = v; }, failRead: () => { failRead = true; } };
}

describe('重複候補の一覧と保存', () => {
  it('確認待ちを一覧・ラップ履歴・タイマーから外し、承認後はすべて表示する', async () => {
    const f = await fixture();
    expect((await listRuns(f.store)).map(r => r.file)).toEqual(['frame.nmea']);
    const all = await listRuns(f.store, undefined, false, true);
    const raw = all.find(r => r.file === 'day.bnx4')!;
    expect(raw.libraryAdmission?.status).toBe('pending');
    expect((await loadLapHistory(f.store))[0].rows.map(r => r.file)).toEqual(['frame.nmea']);
    expect(makeReferenceContext(f.store, f.folder, f.course, '', f.index, null).ownLaps).toHaveLength(1);
    await setLibraryDecision(f.store, raw, true);
    expect(await listRuns(f.store)).toHaveLength(2);
    expect((await loadLapHistory(f.store))[0].rows).toHaveLength(2);
    expect(makeReferenceContext(f.store, f.folder, f.course, '', f.index, f.metadata()).ownLaps).toHaveLength(2);
    expect(f.write.mock.calls.every(([path]) => path === 'sodegaura/runs.json')).toBe(true);
  });
  it('保存失敗を成功扱いにせず、再試行して除外し、後から追加できる', async () => {
    const f = await fixture(), all = await listRuns(f.store, undefined, false, true), raw = all.find(r => r.file === 'day.bnx4')!;
    f.failWrite(true);
    await expect(setLibraryDecision(f.store, raw, false)).rejects.toThrow('write failed');
    expect(raw.entry).toBeNull();
    expect((await listRuns(f.store, undefined, false, true)).find(r => r.file === raw.file)?.libraryAdmission?.status).toBe('pending');
    f.failWrite(false);
    await setLibraryDecision(f.store, raw, false);
    const excluded = (await listRuns(f.store, undefined, false, true)).find(r => r.file === raw.file)!;
    expect(excluded.libraryAdmission?.status).toBe('excluded');
    expect(await listRuns(f.store)).toHaveLength(1);
    await setLibraryDecision(f.store, excluded, true);
    expect(await listRuns(f.store)).toHaveLength(2);
  });
  it('表示した後に変更・削除されたログへの選択を保存しない', async () => {
    const f = await fixture(), raw = (await listRuns(f.store, undefined, false, true)).find(r => r.file === 'day.bnx4')!;
    f.files.find(file => file.path.endsWith(raw.file))!.mtimeMs++;
    await expect(setLibraryDecision(f.store, raw, false)).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
    f.files.splice(1, 1);
    await expect(setLibraryDecision(f.store, raw, true)).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('選択メタデータの読込み失敗で除外を解除しない', async () => {
    const f = await fixture();
    f.failRead();
    await expect(listRuns(f.store)).rejects.toThrow('read failed');
    expect(f.write).not.toHaveBeenCalled();
  });
});
