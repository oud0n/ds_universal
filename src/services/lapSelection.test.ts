import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/telemetry';
import { courseHash, type LapCourse } from './lapIndex';
import * as history from './lapHistory';
import type { RunStore } from './runStore';
import { getStorageRevision, invalidateStorageRevision } from './storageCourses';
import { prepareStoredLap } from './lapSelection';

const course: LapCourse = { name: 'A', controlLine: { name: 'A', latA: 35, latB: 35, lonA: 139.9995, lonB: 140.0005 }, sectors: [] };
const file = '20260102/log.nmea';
const path = 'track/' + file;
const start = Date.UTC(2026, 0, 2);

function part(id: string, utc: number): Session {
  // 40 秒で一周。先頭から 5, 45, 85 秒で計測線を通る。時刻はログの途中から始まる。
  const route = [[34.999, 140], [35.001, 140], [35.001, 140.01], [34.999, 140.01]];
  const points = Array.from({ length: 10 }, (_, i) => {
    const [latitude, longitude] = route[i % 4];
    return { index: i, time: 100 + i * 10, timestamp: new Date(utc + i * 10000).toISOString(),
      distance: i * 0.2, latitude, longitude, altitude: 0, speed: 72, heading: 0,
      accelG: 0, corneringG: 0, combinedG: 0, turningRadius: 0, driftAngle: 0 };
  });
  return { id, fileName: 'log.nmea', sessionName: id, date: '', points, circuitName: 'other',
    pathPolylines: [[[0, 0]]], finishLine: course.controlLine, sectors: [], laps: [],
    samplingRate: 1, totalDistance: 1.8, bestLapIndex: -1, theoreticalBestTime: 0 };
}

function fixture() {
  const lookup = vi.spyOn(history, 'courseForFolder').mockResolvedValue(course);
  const files = [path, 'track/old.mp4', 'track/20260102/cam.mp4', 'track/20260103/other.mp4']
    .map(path => ({ path, mtimeMs: 20, size: 2 }));
  const store = {
    listAll: vi.fn(async () => files),
    read: vi.fn(async () => new Uint8Array([0, 7, 8, 0]).subarray(1, 3)),
    readTextStrict: vi.fn(async (name: string) => name === 'track/runs.json' ? JSON.stringify({
      version: 2, runs: { '20260102/log': { name: 'Run', note: 'Dry' } },
    }) : null),
  };
  const secondStart = start + 600000;
  const sessions = [part('first', start), part('second', secondStart)];
  const parse = vi.fn(async (_name: string, _buffer: ArrayBuffer) => sessions);
  const choice = { kind: 'stored' as const, store: store as unknown as RunStore, courseHash: courseHash(course), storageRevision: getStorageRevision(),
    size: 2, mtimeMs: 20, row: { folder: 'track', file, part: 2, n: 2, time: 40,
      startMs: secondStart + 45000, runStartMs: start, hidden: false, topSpeed: 72, sectors: [] } };
  return { lookup, files, store, parse, choice, sessions };
}

afterEach(() => vi.restoreAllMocks());

describe('保管場所で選んだ周の準備', () => {
  it('フォルダの計測線で数え直し、同タイムの周と分割ログを UTC で見分ける', async () => {
    const { choice, parse, sessions } = fixture();
    const got = await prepareStoredLap(choice, parse, () => true);
    expect(parse.mock.calls[0][0]).toBe('log.nmea');
    expect(Array.from(new Uint8Array(parse.mock.calls[0][1]))).toEqual([7, 8]);
    expect(got.session).toBe(got.sessions[1]);
    expect(got.lap).toBe(got.session.laps[1]);
    expect(got.moved).toBe(false);
    expect(got.session).toMatchObject({ id: 'second', sessionName: 'Run (2)', runNote: 'Dry',
      circuitName: 'A', sourceFile: { storageRevision: getStorageRevision(), folder: 'track', file, part: 2,
        size: 2, mtimeMs: 20, courseHash: choice.courseHash } });
    expect(got.session.finishLine).toBeUndefined();
    expect(got.session.pathPolylines).toBeUndefined();
    expect(got.session.points).toBe(sessions[1].points);
    expect(got.item).toMatchObject({ lapCount: 4, best: 40, entry: { name: 'Run' } });
    expect(got.item.folderVideos.map(v => v.path)).toEqual(['track/old.mp4', 'track/20260102/cam.mp4']);
  });

  it('同じ版の走行で一覧の番号と合わなければ、開始時刻が近い計測周と moved を返す', async () => {
    const { choice, parse } = fixture();
    choice.row.n = 1;
    const got = await prepareStoredLap(choice, parse, () => true);
    expect([got.session.id, got.lap.lapNumber, got.moved]).toEqual(['second', 2, true]);
  });

  it('時刻のない分割ログでは、一覧のまとまりごとの起点で選ぶ', async () => {
    const { choice, parse, sessions } = fixture();
    for (const s of sessions) for (const p of s.points) delete p.timestamp;
    choice.row.startMs = 1e9 + 45000;
    const got = await prepareStoredLap(choice, parse, () => true);
    expect([got.session.id, got.lap.lapNumber, got.moved]).toEqual(['second', 2, false]);
  });

  it('一覧を開いた保管場所から変わっていたら、同名ファイルを探しにも行かない', async () => {
    const { choice, store, parse } = fixture();
    invalidateStorageRevision();
    await expect(prepareStoredLap(choice, parse, () => true)).rejects.toThrow();
    expect(store.listAll).not.toHaveBeenCalled();
  });

  it.each(['before', 'during'] as const)('ファイルが %s に差し替わったら開かない', async phase => {
    const { choice, files, store, parse, sessions } = fixture();
    if (phase === 'before') files[0].mtimeMs++;
    else parse.mockImplementationOnce(async () => { files[0].mtimeMs++; return sessions; });
    await expect(prepareStoredLap(choice, parse, () => true)).rejects.toThrow();
    if (phase === 'before') expect(store.read).not.toHaveBeenCalled();
  });

  it('コース編集が読み込みを追い越しても以前の計測線で選ばない', async () => {
    const { choice, lookup, parse, sessions } = fixture();
    parse.mockImplementationOnce(async () => {
      lookup.mockResolvedValue({ ...course, controlLine: { ...course.controlLine, latA: 35.001 } });
      return sessions;
    });
    await expect(prepareStoredLap(choice, parse, () => true)).rejects.toThrow();
  });

  it.each(['folder', 'slot'] as const)('読み取り中の %s の変更は、次のパースを始める前に取り消す', async change => {
    const { choice, store, parse } = fixture();
    let current = true;
    store.read.mockImplementationOnce(async () => {
      if (change === 'folder') invalidateStorageRevision(); else current = false;
      return new Uint8Array(2);
    });
    await expect(prepareStoredLap(choice, parse, () => current)).rejects.toThrow();
    expect(parse).not.toHaveBeenCalled();
  });

  it('走行名の読み込みを追い越した選択は、一覧や画面へ引き継がない', async () => {
    const { choice, store, parse } = fixture();
    let current = true;
    store.readTextStrict.mockImplementationOnce(async () => { current = false; return null; });
    await expect(prepareStoredLap(choice, parse, () => current)).rejects.toThrow();
    expect(store.readTextStrict.mock.calls.map(([name]) => name)).toEqual(['track/runs.json']);
  });
});
