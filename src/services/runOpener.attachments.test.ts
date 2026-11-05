import { afterEach, expect, it, vi } from 'vitest';
import * as gps from './gpmfParser';
import * as metadata from './videoMetadataParser';
import * as runsFile from './runsFile';
import type { Session } from '../types/telemetry';
import { videoSyncManager } from './videoSyncManager';
import { videoViewStore } from './videoViewStore';
import { abandonOpenRuns, attachCompanionVideos, attachRunVideos, companionRunMatches, companionRuns, assertRunSyncTarget, releaseClosedRunVideos, getOpenRun, getOpenRunItem, flushOpenRunsStrict, scheduleRunSave, setRunMeta, type RunItem } from './runOpener';
import type { RunStore } from './runStore';
import type { RemoteVideo } from './remoteVideo';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function attachment(file: string, includeVideo = false) {
  const video: RemoteVideo = { name: file + '.mp4', size: 20, url: 'lapfile://run/' + file, path: 'course/' + file + '.mp4', lastModified: 0 };
  const item: RunItem = { folder: 'course', file, courseName: 'C', startMs: null, lapCount: 0, best: null,
    videos: includeVideo ? [video.name] : [], folderVideos: [], synced: false, laps: [], pending: false,
    entry: { updatedAt: '', videos: [{ name: video.name, pins: [{ name: file, logPart: 1, logTimeSec: 3, videoTimeSec: 2 }] }] } };
  return { store: {} as RunStore, item, runSessions: [], sessions: () => [], circuitName: () => 'C',
    videos: includeVideo ? [video] : [], fromRuns: true };
}

function delayMetadata() {
  const started = latch(), resume = latch();
  const spy = vi.spyOn(metadata, 'parseVideoMetadata').mockImplementation(async file => {
    started.release();
    await resume.promise;
    return { fileName: file.name, fileSize: file.size, creationTime: null, durationSec: 10, timescale: 1000 };
  });
  return { started, resume, spy };
}

afterEach(() => {
  abandonOpenRuns();
  for (const t of videoSyncManager.getTracks()) videoSyncManager.removeTrack(t.id);
  vi.restoreAllMocks();
});

it('選択 A の動画情報が遅れて返っても、次の B にトラックやピンを出さない', async () => {
  const { started, resume } = delayMetadata();
  const parseGps = vi.spyOn(gps, 'parseGoproGps');
  const restorePins = vi.spyOn(videoViewStore, 'setPins');
  const published: string[][] = [];
  const stop = videoSyncManager.subscribe(() => published.push(videoSyncManager.getTracks().map(v => v.fileName)));
  let current = 'A';
  try {
    const old = attachRunVideos({ ...attachment('A', true), isCurrent: () => current === 'A' });
    await started.promise;
    current = 'B';
    const next = attachRunVideos({ ...attachment('B'), isCurrent: () => current === 'B' });
    resume.release();
    await Promise.all([old, next]);
    expect(getOpenRun()?.item.file).toBe('B');
    expect(published.flat()).not.toContain('A.mp4');
    expect(parseGps).not.toHaveBeenCalled();
    expect(restorePins).not.toHaveBeenCalled();
  } finally { stop(); }
});

it('列で待っている途中に選択を外した処理は、開いている走行を閉じない', async () => {
  const { started, resume, spy } = delayMetadata();
  const active = attachment('active');
  await attachRunVideos(active);
  let current = true;
  const companion = attachCompanionVideos({ ...attachment('side', true), isCurrent: () => current });
  await started.promise;
  const queued = attachRunVideos({ ...attachment('queued', true), isCurrent: () => current });
  current = false;
  resume.release();
  expect(await Promise.all([companion, queued])).toEqual([0, 0]);
  expect(getOpenRun()?.item).toBe(active.item);
  expect(companionRuns()).toEqual([]);
  expect(spy).toHaveBeenCalledTimes(1);
});

it('開いている走行を比較車へ置いても保存者を二重に作らず、古い補正を戻さない', async () => {
  const opts = attachment('same');
  await attachRunVideos(opts);
  const restore = vi.fn();
  await attachCompanionVideos({ ...opts, setClockOffset: restore });
  expect(getOpenRun()?.item).toBe(opts.item);
  expect(companionRuns()).toEqual([]);
  expect(restore).not.toHaveBeenCalled();
});

it('初めての名前編集を保存できなくても、手元の行に編集値を保つ', async () => {
  const opts = attachment('A'); opts.item.entry = null;
  vi.spyOn(runsFile, 'updateRun').mockRejectedValue(new Error('write failed'));
  await expect(setRunMeta(opts.store, opts.item, { name: 'New name', note: 'New note', car: 'New car' })).rejects.toThrow('write failed');
  expect(opts.item.entry).toMatchObject({ name: 'New name', note: 'New note', car: 'New car' });
});

it('名前・車種の保存が失敗したあと時計だけ保存しても、未保存の編集を手元から消さない', async () => {
  const session = { id: 's', points: [], laps: [], clockOffsetSec: 0 } as unknown as Session;
  const opts = { ...attachment('meta'), runSessions: [session], sessions: () => [session] };
  let disk: runsFile.RunRow = { ...opts.item.entry!, name: 'Saved name', note: 'Saved note', car: 'Saved car' };
  opts.item.entry = disk;
  let fail = true;
  vi.spyOn(runsFile, 'updateRun').mockImplementation(async (_s, _folder, _file, update) => {
    if (fail) throw new Error('metadata write failed');
    disk = { updatedAt: disk.updatedAt, ...update(disk) };
    return disk;
  });
  await attachRunVideos(opts);
  await expect(setRunMeta(opts.store, opts.item, { name: 'Edited name', note: null, car: 'Edited car' })).rejects.toThrow();
  fail = false; session.clockOffsetSec = 2;
  await flushOpenRunsStrict();
  expect(disk.name).toBe('Edited name');
  expect(disk.note).toBeUndefined();
  expect(opts.item.entry).toMatchObject({ name: 'Edited name', car: 'Edited car', parts: { '1': { clockOffsetSec: 2 } } });
  expect(opts.item.entry?.note).toBeUndefined();
});

it('古い名前保存の完了で、次の編集の preview を戻さない', async () => {
  const opts = attachment('meta');
  let finishFirst!: () => void, finishSecond!: () => void;
  const original = { ...opts.item.entry! };
  vi.spyOn(runsFile, 'updateRun')
    .mockImplementationOnce(async (_s, _folder, _file, update) => new Promise(resolve => {
      finishFirst = () => resolve({ ...original, ...update(original) });
    }))
    .mockImplementationOnce(async (_s, _folder, _file, update) => new Promise(resolve => {
      finishSecond = () => resolve({ ...original, ...update(original) });
    }));
  const first = setRunMeta(opts.store, opts.item, { name: 'First' });
  const second = setRunMeta(opts.store, opts.item, { name: 'Second' });
  finishFirst(); await first;
  expect(opts.item.entry?.name).toBe('Second');
  finishSecond(); await second;
  expect(opts.item.entry?.name).toBe('Second');
});

it('別の一覧が持つ古い行から、保存済みの古い編集を再び持ち込まない', async () => {
  const session = { id: 's', points: [], laps: [], clockOffsetSec: 0 } as unknown as Session;
  const opts = { ...attachment('shared-meta'), runSessions: [session], sessions: () => [session] };
  const otherView = { ...opts.item };
  let disk: runsFile.RunRow = { ...opts.item.entry!, name: 'Original' };
  let fail = true;
  vi.spyOn(runsFile, 'updateRun').mockImplementation(async (_s, _folder, _file, update) => {
    if (fail) throw new Error('metadata write failed');
    disk = { updatedAt: '', ...update(disk) }; return disk;
  });
  await attachRunVideos(opts);
  await expect(setRunMeta(opts.store, otherView, { name: 'First' })).rejects.toThrow();
  fail = false; await flushOpenRunsStrict();
  await setRunMeta(opts.store, opts.item, { name: 'Second' });
  await setRunMeta(opts.store, otherView, { note: 'Later note' });
  expect(disk).toMatchObject({ name: 'Second', note: 'Later note' });
  expect(opts.item.entry).toMatchObject({ name: 'Second', note: 'Later note' });
});

it.each([1, 0])('分割ログが %s 本だけ残っていても、未保存の名前を保存し、分割番号と動画は書き換えない', async remaining => {
  const sessions = ['first', 'second'].map(id => ({ id, points: [], laps: [], clockOffsetSec: 0 } as unknown as Session));
  let live = sessions;
  const opts = { ...attachment('split-meta'), runSessions: sessions, sessions: () => live };
  let disk: runsFile.RunRow = { ...opts.item.entry!, name: 'Old', parts: { '1': { clockOffsetSec: 0 }, '2': { clockOffsetSec: 8 } } };
  const videosBefore = disk.videos;
  opts.item.entry = disk;
  let fail = true;
  vi.spyOn(runsFile, 'updateRun').mockImplementation(async (_s, _folder, _file, update) => {
    if (fail) throw new Error('write failed');
    disk = { updatedAt: '', ...update(disk) }; return disk;
  });
  await attachRunVideos(opts);
  await expect(setRunMeta(opts.store, opts.item, { name: 'New' })).rejects.toThrow();
  live = sessions.slice(0, remaining);
  await expect(flushOpenRunsStrict()).rejects.toThrow('write failed');
  fail = false; await flushOpenRunsStrict();
  expect(disk.name).toBe('New');
  expect(disk.parts).toEqual({ '1': { clockOffsetSec: 0 }, '2': { clockOffsetSec: 8 } });
  expect(disk.videos).toEqual(videosBefore);
});

it.each([true, false])('比較側の通知が先=%s でも、基準から外れた走行の動画と保存担当を引き継ぐ', async companionFirst => {
  const meta = vi.spyOn(metadata, 'parseVideoMetadata').mockImplementation(async file => ({
    fileName: file.name, fileSize: file.size, creationTime: null, durationSec: 10, timescale: 1000
  }));
  vi.spyOn(gps, 'parseGoproGps').mockRejectedValue(new Error('no GPS in synthetic video'));
  const a = attachment('A', true), c = attachment('C');
  a.item.entry!.videos![0].clock = { source: 'manual', logPart: null, offsetSec: 0, utcMs: 1000 };
  await attachRunVideos(a);
  const trackIds = videoSyncManager.getTracks().map(t => t.id);
  const edited = { source: 'manual' as const, logId: null, offsetSec: 0, utcMs: 9000 };
  videoSyncManager.setClock(trackIds[0], edited);
  if (companionFirst) await attachCompanionVideos(a);
  await attachRunVideos({ ...c, keepPrevious: () => true });
  if (!companionFirst) await attachCompanionVideos(a);
  expect(companionRuns()).toEqual(['course/A']);
  expect(getOpenRun()?.item).toBe(c.item);
  expect(getOpenRunItem('course', 'A')).toBe(a.item);
  expect(videoSyncManager.getTracks().map(t => t.id)).toEqual(trackIds);
  expect(videoSyncManager.getTracks()[0].clock).toEqual(edited);
  expect(meta).toHaveBeenCalledTimes(1);
});

it('既存の未保存動画時計を保ったまま、新しく開けた動画だけ保存行から復元する', async () => {
  vi.spyOn(metadata, 'parseVideoMetadata').mockImplementation(async file => ({ fileName: file.name, fileSize: file.size, creationTime: null, durationSec: 10, timescale: 1000 }));
  vi.spyOn(gps, 'parseGoproGps').mockRejectedValue(new Error('no GPS'));
  const a = attachment('A', true);
  a.item.entry!.videos![0].clock = { source: 'manual', logPart: null, offsetSec: 0, utcMs: 1000 };
  await attachRunVideos(a);
  const originalId = videoSyncManager.getTracks()[0].id;
  const edited = { source: 'manual' as const, logId: null, offsetSec: 0, utcMs: 9000 };
  videoSyncManager.setClock(originalId, edited);
  const extra = { ...a.videos[0], name: 'A2.mp4', path: 'course/A2.mp4', url: 'lapfile://run/A2' };
  a.item.entry!.videos!.push({ name: extra.name, clock: { source: 'manual', logPart: null, offsetSec: 0, utcMs: 2000 } });
  await attachRunVideos({ ...a, videos: [...a.videos, extra] });
  expect(videoSyncManager.getTracks().find(t => t.id === originalId)?.clock).toEqual(edited);
  expect(videoSyncManager.getTracks().find(t => t.fileName === extra.name)?.clock.utcMs).toBe(2000);
});

it('同じ道でも元データの ID が変わった比較走行は、古い担当を再利用しない', async () => {
  const old = { id: 'old', points: [], laps: [] } as unknown as Session;
  const fresh = { ...old, id: 'fresh' };
  const a = attachment('A');
  await attachCompanionVideos({ ...a, runSessions: [old], sessions: () => [old] });
  expect(companionRunMatches('course/A', ['old'])).toBe(true);
  const b = attachment('A');
  await attachCompanionVideos({ ...b, runSessions: [fresh], sessions: () => [fresh] });
  expect(companionRunMatches('course/A', ['fresh'])).toBe(true);
  expect(getOpenRunItem('course', 'A')).toBe(b.item);
});

it('比較車を基準に戻すとき、同じ担当の未保存補正を古い行で戻さない', async () => {
  const session = { id: 's', points: [], laps: [], clockOffsetSec: 0 } as unknown as Session;
  const a = { ...attachment('A'), runSessions: [session], sessions: () => [session] };
  a.item.entry!.parts = { '1': { clockOffsetSec: 0.5 } };
  const setOffset = vi.fn((_id: string, value: number) => { session.clockOffsetSec = value; });
  await attachRunVideos({ ...a, setClockOffset: setOffset });
  session.clockOffsetSec = 1.25;
  await attachRunVideos({ ...attachment('C'), keepPrevious: () => true });
  setOffset.mockClear();
  const oldItem = { ...a.item, entry: { ...a.item.entry!, parts: { '1': { clockOffsetSec: 0.5 } } } };
  await attachRunVideos({ ...a, item: oldItem, setClockOffset: setOffset });
  expect(session.clockOffsetSec).toBe(1.25);
  expect(setOffset).not.toHaveBeenCalled();
  expect(getOpenRun()?.item).toBe(a.item);
  expect(companionRuns()).not.toContain('course/A');
});

it('前の保管場所の応答を待たずに新しい場所を開ける。前の動画・走行は戻らない', async () => {
  const { started, resume } = delayMetadata();
  const old = attachRunVideos(attachment('A', true));
  await started.promise;
  abandonOpenRuns();
  const next = attachment('B');
  await attachRunVideos(next);
  resume.release();
  expect(await old).toBe(0);
  expect(getOpenRun()?.item).toBe(next.item);
  expect(videoSyncManager.getTracks()).toEqual([]);
});

it('GPS を読んでいる途中に別の入力へ替えたら Blob URL もトラックも作らない', async () => {
  const started = latch(), resume = latch();
  vi.spyOn(metadata, 'parseVideoMetadata').mockImplementation(async file => ({
    fileName: file.name, fileSize: file.size, creationTime: null, durationSec: 20, timescale: 1000,
  }));
  vi.spyOn(gps, 'parseGoproGps').mockImplementation(async () => {
    started.release(); await resume.promise; throw new Error('No GPS');
  });
  const urls = vi.spyOn(URL, 'createObjectURL');
  let current = true;
  const old = videoSyncManager.addVideoFiles([new File(['A'], 'A.mp4')], [], true, () => current);
  await started.promise;
  current = false;
  await videoSyncManager.addVideoFiles([new File(['B'], 'B.mp4')], [], false);
  resume.release();
  await old;
  expect(videoSyncManager.getTracks().map(t => t.fileName)).toEqual(['B.mp4']);
  expect(urls).toHaveBeenCalledTimes(1);
});


it('割当てで元の点列を閉じる前に、保留していた時計補正を保存する', async () => {
  const session = { id:'s', points:[], laps:[], clockOffsetSec:0 } as unknown as Session;
  let live = [session];
  const opts = { ...attachment('saved'), runSessions:[session], sessions:() => live };
  let written: runsFile.RunRow | undefined;
  const write = vi.spyOn(runsFile, 'updateRun').mockImplementation(async (_store, _folder, _file, update) => {
    written = { ...opts.item.entry!, ...update(opts.item.entry!) };
    return written;
  });
  await attachRunVideos(opts);
  session.clockOffsetSec = 1.25;
  await flushOpenRunsStrict();
  live = [];
  expect(written?.parts?.['1']?.clockOffsetSec).toBe(1.25);
  expect(write).toHaveBeenCalledOnce();
});

it('保存に失敗したら手放す処理へ進めず、元の所有者を保持する', async () => {
  const session = { id:'s', points:[], laps:[], clockOffsetSec:0 } as unknown as Session;
  const opts = { ...attachment('not-saved'), runSessions:[session], sessions:() => [session] };
  await attachRunVideos(opts);
  session.clockOffsetSec = 2;
  vi.spyOn(runsFile, 'updateRun').mockRejectedValue(new Error('disk full'));
  await expect(flushOpenRunsStrict()).rejects.toThrow('disk full');
  expect(getOpenRun()?.item).toBe(opts.item);
});

it('厳格な保存を待つ間の追加編集も保存し、最初の控えだけで切替えを許さない', async () => {
  const session = { id: 's', points: [], laps: [], clockOffsetSec: 0 } as unknown as Session;
  const opts = { ...attachment('editing'), runSessions: [session], sessions: () => [session] };
  await attachRunVideos(opts);
  const started = latch(), resume = latch();
  const saved: runsFile.RunRow[] = [];
  vi.spyOn(runsFile, 'updateRun').mockImplementation(async (_s, _folder, _file, update) => {
    const row = { updatedAt: '', ...update(opts.item.entry!) };
    saved.push(row);
    if (saved.length === 1) { started.release(); await resume.promise; }
    return row;
  });
  session.clockOffsetSec = 1;
  const flush = flushOpenRunsStrict();
  await started.promise;
  session.clockOffsetSec = 2; scheduleRunSave();
  resume.release(); await flush;
  expect(saved.map(row => row.parts?.['1']?.clockOffsetSec)).toEqual([1, 2]);
});


it('次の動画の準備中、ログを全部手放した担当の古い動画を編集させない', async () => {
  vi.spyOn(metadata, 'parseVideoMetadata').mockImplementation(async file => ({ fileName: file.name, fileSize: file.size, creationTime: null, durationSec: 10, timescale: 1000 }));
  vi.spyOn(gps, 'parseGoproGps').mockRejectedValue(new Error('no GPS'));
  const session = { id: 'A', points: [], laps: [] } as unknown as Session;
  let live = [session];
  const a = { ...attachment('A', true), runSessions: [session], sessions: () => live };
  await attachRunVideos(a);
  expect(videoSyncManager.getTracks()).toHaveLength(1);
  // 採用前に保存済み。次の動画の非同期準備を始める前に、古い編集対象を外す。
  await flushOpenRunsStrict();
  live = [];
  releaseClosedRunVideos(new Set());
  const { started, resume } = delayMetadata();
  const next = attachRunVideos(attachment('B', true));
  await started.promise;
  expect(getOpenRun()).toBeNull();
  expect(videoSyncManager.getTracks()).toHaveLength(0);
  resume.release(); await next;
  expect(getOpenRun()?.item.file).toBe('B');
  expect(videoSyncManager.getTracks().map(t => t.fileName)).toEqual(['B.mp4']);
});

it.each([0, 1])('part %s を閉じた後の補正を、元の番号で保存する', async removed => {
  const first = { id: 'first', points: [{ timestamp: '2026-01-01T00:00:00Z' }], clockOffsetSec: 1 } as Session;
  const second = { id: 'second', points: [{ timestamp: '2026-01-01T01:00:00Z' }], clockOffsetSec: 8 } as Session;
  let live = [first, second];
  const opts = { ...attachment('partial-clock'), runSessions: live, sessions: () => live };
  let disk: runsFile.RunRow = { updatedAt: '', parts: { '1': { clockOffsetSec: 1 }, '2': { clockOffsetSec: 8 } }, videos: opts.item.entry!.videos };
  opts.item.entry = disk;
  vi.spyOn(runsFile, 'updateRun').mockImplementation(async (_s, _f, _n, update) => disk = { updatedAt: '', ...update(disk) });
  await attachRunVideos(opts); await flushOpenRunsStrict();
  live = live.filter((_, i) => i !== removed);
  // 閉じた側を別の保存で更新した値も戻さない。
  disk.parts![String(removed + 1)] = { clockOffsetSec: 19 };
  live[0].clockOffsetSec = 4.75;
  await flushOpenRunsStrict();
  expect(disk.parts?.[String(2 - removed)]?.clockOffsetSec).toBe(4.75);
  expect(disk.parts?.[String(removed + 1)]?.clockOffsetSec).toBe(19);
  expect(disk.videos).toEqual(opts.item.entry!.videos);
});

it('part 2 だけ付け直しても、保存行の part 2 の補正を復元する', async () => {
  const second = { id: 'second', points: [], clockOffsetSec: 0, sourceFile: { part: 2 } } as unknown as Session;
  const opts = { ...attachment('part-two'), runSessions: [second], sessions: () => [second] };
  opts.item.entry!.parts = { '1': { clockOffsetSec: 1 }, '2': { clockOffsetSec: 8 } };
  const restore = vi.fn((id, sec) => { if (id === second.id) second.clockOffsetSec = sec; });
  await attachRunVideos({ ...opts, setClockOffset: restore });
  expect(restore).toHaveBeenCalledExactlyOnceWith(second.id, 8);
});


it('日時の換算不能を strict 保存の成功にせず、元の時計・ピンを保持して修正後に再保存する', async () => {
  vi.spyOn(metadata, 'parseVideoMetadata').mockImplementation(async file => ({ fileName: file.name, fileSize: file.size, creationTime: null, durationSec: 10, timescale: 1000 }));
  vi.spyOn(gps, 'parseGoproGps').mockRejectedValue(new Error('no GPS'));
  const own = { id: 'own', points: [{ timestamp: '2026-01-01T00:00:00Z' }] } as Session;
  const undated = { id: 'undated', points: [{ time: 0 }] } as Session;
  const a = { ...attachment('guard', true), runSessions: [own], sessions: () => [own, undated] };
  a.item.entry!.videos![0].clock = { source: 'manual', logPart: 1, offsetSec: 2, utcMs: null };
  let disk = structuredClone(a.item.entry!);
  const write = vi.spyOn(runsFile, 'updateRun').mockImplementation(async (_s, _f, _n, update) => disk = { updatedAt: '', ...update(disk) });
  await attachRunVideos(a); await flushOpenRunsStrict();
  const previous = structuredClone(disk), t = videoSyncManager.getTracks()[0];
  expect(() => assertRunSyncTarget(t.id, undated)).toThrow();
  // 保存層も、プロジェクト復元など UI を通らない変更を検査する。
  videoSyncManager.setOffsetIn(t.id, undated, 7);
  write.mockClear();
  await expect(flushOpenRunsStrict()).rejects.toThrow();
  expect(write).not.toHaveBeenCalled(); expect(disk).toEqual(previous);
  videoSyncManager.setOffsetIn(t.id, own, 5);await flushOpenRunsStrict();
  expect(disk.videos![0].clock?.offsetSec).toBe(5);
});
