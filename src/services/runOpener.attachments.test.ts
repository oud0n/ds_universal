import { afterEach, expect, it, vi } from 'vitest';
import * as gps from './gpmfParser';
import * as metadata from './videoMetadataParser';
import * as runsFile from './runsFile';
import type { Session } from '../types/telemetry';
import { videoSyncManager } from './videoSyncManager';
import { videoViewStore } from './videoViewStore';
import { abandonOpenRuns, attachCompanionVideos, attachRunVideos, companionRunMatches, companionRuns, getOpenRun, getOpenRunItem, flushOpenRunsStrict, type RunItem } from './runOpener';
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
