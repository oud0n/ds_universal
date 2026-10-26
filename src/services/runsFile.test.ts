import { describe, expect, it } from 'vitest';
import { findRunRow, mergeRunsFiles, noteRunsConflictCopies, parseRunsFile, readRunsFile, removeRunRow, runKey, updateRun, isRunsConflictCopy } from './runsFile';
import type { RunStore } from './runStore';

// 1.0.2 が書いた runs.json (同じ走行の .bon4 と .nmea の 2 行。同期プロジェクトの形)
const v1 = {
  version: 1,
  runs: {
    '20260815/20260815092455.bon4': {
      updatedAt: '2026-10-21T00:00:00.000Z',
      videos: ['GX010014.MP4'],
      sync: { version: '2.0', savedAt: '', circuitName: 'x', videos: [{ fileName: 'GX010014.MP4', fileSize: 10, durationSec: 100, rawRecordedAt: null, recordedAtJst: null, matchedSessionId: 's_old', clock: { source: 'gps', logId: null, offsetSec: 0, utcMs: 1000 } }], sessions: [{ id: 's_old', fileName: '20260815092455.bon4', sessionName: '20260815092455', startDateJst: '', totalLaps: 0, samplingRate: 20, clockOffsetSec: 0 }] }
    },
    '20260815/20260815092455.nmea': {
      updatedAt: '2026-10-22T00:00:00.000Z',
      videos: ['GX010014.MP4'],
      sync: {
        version: '2.0', savedAt: '', circuitName: 'x',
        videos: [{ fileName: 'GX010014.MP4', fileSize: 10, durationSec: 100, rawRecordedAt: '2026-08-15T00:24:55.000Z', recordedAtJst: null, videoTimezone: 'JST', gpsTimezone: 'JST', matchedSessionId: 's2', sessionChosenManually: true, clock: { source: 'manual', logId: 's2', offsetSec: 22.31, utcMs: 2000 } }],
        sessions: [
          { id: 's1', fileName: '20260815092455.nmea', sessionName: '20260815092455_1', startDateJst: '', totalLaps: 0, samplingRate: 20, clockOffsetSec: 0 },
          { id: 's2', fileName: '20260815092455.nmea', sessionName: '20260815092455_2', startDateJst: '', totalLaps: 0, samplingRate: 20, clockOffsetSec: 1.5 }
        ],
        pins: [{ name: 'P', sessionTimeSec: 50, videoTimeSec: 27.69, calculatedOffsetSec: 22.31, trackFileName: 'GX010014.MP4', sessionId: 's2' }]
      }
    },
    '20260913092357.nmea': { updatedAt: '2026-10-01T00:00:00.000Z', videos: ['A.MP4'] }
  }
};

describe('runs.json (2 版)', () => {
  it('行の名前は日付のフォルダ/拡張子なしの名前', () => {
    expect(runKey('20260815/20260815092455.nmea')).toBe('20260815/20260815092455');
    expect(runKey('20260815092455.bon4')).toBe('20260815092455');
  });

  it('1 版を読み替える: 同じ走行の 2 行は新しいほう、ログの ID は何番目のログか', () => {
    const f = parseRunsFile(JSON.stringify(v1));
    expect(f.version).toBe(2);
    expect(Object.keys(f.runs).sort()).toEqual(['20260815/20260815092455', '20260913092357']);
    const row = f.runs['20260815/20260815092455'];
    expect(row.updatedAt).toBe('2026-10-22T00:00:00.000Z');
    expect(row.parts).toEqual({ 1: { clockOffsetSec: 0 }, 2: { clockOffsetSec: 1.5 } });
    const v = row.videos![0];
    expect(v).toMatchObject({ name: 'GX010014.MP4', size: 10, part: 2, chosen: true, timezone: { video: 'JST', gps: 'JST' }, recordedAt: '2026-08-15T00:24:55.000Z' });
    expect(v.clock).toEqual({ source: 'manual', logPart: 2, offsetSec: 22.31, utcMs: 2000 });
    expect(v.pins).toEqual([{ name: 'P', logPart: 2, logTimeSec: 50, videoTimeSec: 27.69 }]);
    expect(f.runs['20260913092357'].videos).toEqual([{ name: 'A.MP4' }]);
  });

  it('ほかのログに付いた時刻 (この走行のログでない) は世界の時刻で持つ。それも無ければ時刻を持たない (動画は捨てない)', () => {
    const f = parseRunsFile(JSON.stringify({ version: 1, runs: { 'a.nmea': { updatedAt: 'x', videos: ['B.MP4', 'C.MP4'], sync: { videos: [
      { fileName: 'B.MP4', fileSize: 1, durationSec: 1, recordedAtJst: null, matchedSessionId: null, clock: { source: 'manual', logId: 'other', offsetSec: 5, utcMs: 3000 } },
      { fileName: 'C.MP4', fileSize: 1, durationSec: 1, recordedAtJst: null, matchedSessionId: null, clock: { source: 'manual', logId: 'other', offsetSec: 5, utcMs: null } }
    ], sessions: [] } } } }));
    const vs = f.runs.a.videos!;
    expect(vs[0].clock).toEqual({ source: 'manual', logPart: null, offsetSec: 0, utcMs: 3000 });
    expect(vs[1].name).toBe('C.MP4');
    expect(vs[1].clock).toBeUndefined();
  });

  it('知らない項目は残す (上の段・行・動画)', () => {
    const text = JSON.stringify({ version: 2, future: 1, runs: { k: { updatedAt: 'x', id: 'r1', kind: 'reference', videos: [{ name: 'A.MP4', extra: { a: 1 } }] } } });
    const f = parseRunsFile(text);
    expect(f.future).toBe(1);
    expect(f.runs.k.kind).toBe('reference');
    expect(f.runs.k.videos![0].extra).toEqual({ a: 1 });
  });

  it('知らない版は読まない', () => {
    expect(parseRunsFile(JSON.stringify({ version: 3, runs: { a: { updatedAt: 'x' } } })).runs).toEqual({});
  });

  it('ぶつかったときの写しは行ごとに新しいほう', () => {
    const a = parseRunsFile(JSON.stringify({ version: 2, runs: { x: { updatedAt: '2026-10-01T00:00:00Z', name: 'old' }, y: { updatedAt: '2026-10-05T00:00:00Z' } } }));
    const b = parseRunsFile(JSON.stringify({ version: 2, runs: { x: { updatedAt: '2026-10-02T00:00:00Z', name: 'new' }, z: { updatedAt: '2026-10-03T00:00:00Z' } } }));
    const m = mergeRunsFiles(a, b);
    expect(m.runs.x.name).toBe('new');
    expect(Object.keys(m.runs).sort()).toEqual(['x', 'y', 'z']);
    expect(isRunsConflictCopy('runs 2.json')).toBe(true);
    expect(isRunsConflictCopy('runs.json')).toBe(false);
  });

  it('書くと全体を 2 版にし、ほかの行と知らない項目を残す。id を付け、名前だけの古い行を日付の行へ移す', async () => {
    let text: string | null = JSON.stringify({ ...v1, extra: 'keep' });
    const store = { readTextStrict: async () => text, readText: async () => text, writeText: async (_p: string, t: string) => { text = t; } } as unknown as RunStore;
    const row = await updateRun(store, 'sodegaura', '20260913/20260913092357.nmea', prev => ({ ...prev, note: 'メモ' }));
    const f = JSON.parse(text!);
    expect(f.version).toBe(2);
    expect(f.extra).toBe('keep');
    expect(Object.keys(f.runs).sort()).toEqual(['20260815/20260815092455', '20260913/20260913092357']);
    expect(row.note).toBe('メモ');
    expect(row.videos).toEqual([{ name: 'A.MP4' }]);
    expect(row.id).toMatch(/^r_/);
    expect(findRunRow(parseRunsFile(text), '20260913/20260913092357.bon4')?.id).toBe(row.id);
    // 2 回目は id を変えない
    const again = await updateRun(store, 'sodegaura', '20260913/20260913092357.nmea', prev => ({ ...prev, note: 'b' }));
    expect(again.id).toBe(row.id);
  });

  it('読めない形の runs.json には書かない', async () => {
    const text = '{"version": 3';
    const store = { readTextStrict: async () => text, readText: async () => text, writeText: async () => { throw new Error('must not write'); } } as unknown as RunStore;
    await expect(updateRun(store, 'f', 'a.nmea', p => ({ ...p }))).rejects.toThrow();
  });

  it('読めない書いた時刻の行は、いちばん古いものとみなす', () => {
    const f = parseRunsFile(JSON.stringify({ version: 1, runs: { 'd/a.bon4': { updatedAt: '', videos: ['X.MP4'] }, 'd/a.nmea': { updatedAt: '2026-10-01T00:00:00Z', videos: ['Y.MP4'] } } }));
    expect(f.runs['d/a'].videos).toEqual([{ name: 'Y.MP4' }]);
  });

  it('1 版の行のほかの項目は残し、読めない同期は legacy に残す', () => {
    const f = parseRunsFile(JSON.stringify({ version: 1, runs: { 'a.nmea': { updatedAt: '2026-10-01T00:00:00Z', videos: ['A.MP4'], sync: 'broken', memo: 'x' } } }));
    const row = f.runs.a;
    expect(row.memo).toBe('x');
    expect(row.legacy).toMatchObject({ sync: 'broken' });
    expect(row.videos).toEqual([{ name: 'A.MP4' }]);
  });
});

describe('行を消す・動画の行 (2026-10-25 のレビュー)', () => {
  const mem = (files: Record<string, string>) => ({
    readTextStrict: async (p: string) => files[p] ?? null,
    readText: async (p: string) => files[p] ?? null,
    writeText: async (p: string, t: string) => { files[p] = t; }
  }) as unknown as RunStore;

  it('ぶつかったときの写しがあると、消した印を残し、読み直しても行が戻らない', async () => {
    const row = { updatedAt: '2026-10-25T00:00:00Z', name: 'x' };
    const files: Record<string, string> = {
      'f/runs.json': JSON.stringify({ version: 2, runs: { '20261025/a': row } }),
      'f/runs 2.json': JSON.stringify({ version: 2, runs: { '20261025/a': row } })
    };
    const store = mem(files);
    noteRunsConflictCopies('f', ['f/runs 2.json']);
    try {
      await removeRunRow(store, 'f', '20261025/a.nmea');
      const after = await readRunsFile(store, 'f');
      expect(findRunRow(after, '20261025/a.nmea')).toBeNull();
    } finally {
      noteRunsConflictCopies('f', []);
    }
  });

  it('日付のフォルダの動画の行を書いても、サーキットのフォルダの同じ名前の動画の行は動かさない・消さない', async () => {
    const files: Record<string, string> = { 'f/runs.json': JSON.stringify({ version: 2, runs: { 'GX010001.MP4': { updatedAt: '2026-10-24T00:00:00Z', id: 'root', videoLaps: { marks: [] } } } }) };
    const store = mem(files);
    await updateRun(store, 'f', '20261025/GX010001.MP4', row => ({ ...row, name: 'dated' }));
    let runs = JSON.parse(files['f/runs.json']).runs;
    expect(runs['GX010001.MP4']?.id).toBe('root');
    expect(runs['20261025/GX010001.MP4']?.id).not.toBe('root');
    await removeRunRow(store, 'f', '20261025/GX010001.MP4');
    runs = JSON.parse(files['f/runs.json']).runs;
    expect(runs['GX010001.MP4']?.id).toBe('root');
    expect(runs['20261025/GX010001.MP4']).toBeUndefined();
  });
});

describe('天候・気温・路面温度 (2026-10-26)', () => {
  it('読めない値は落とし、読める値は残す', async () => {
    const { parseRunsFile } = await import('./runsFile');
    const f = parseRunsFile(JSON.stringify({ version: 2, runs: {
      a: { updatedAt: '2026-10-26T00:00:00Z', weather: 'wet', airTempC: 18, trackTempC: 22.5 },
      b: { updatedAt: '2026-10-26T00:00:00Z', weather: 'snow', airTempC: '18', trackTempC: 999 }
    } }));
    expect(f.runs.a).toMatchObject({ weather: 'wet', airTempC: 18, trackTempC: 22.5 });
    expect(f.runs.b.weather).toBeUndefined();
    expect(f.runs.b.airTempC).toBeUndefined();
    expect(f.runs.b.trackTempC).toBeUndefined();
  });
  it('一覧の文', async () => {
    const { conditionsText } = await import('./runWeather');
    expect(conditionsText({ weather: 'heavy-wet', airTempC: 12 }, true)).toBe('ヘビーウェット · 気温 12℃');
    expect(conditionsText({ trackTempC: 30 }, false)).toBe('Track 30℃');
    expect(conditionsText({}, true)).toBe('');
  });
});
