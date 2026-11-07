import { describe, expect, it } from 'vitest';
import type { Lap, Session } from '../types/telemetry';
import { applyRunMetadata, assignLap, createAnalysisStore, reuseStoredSessions, selectAvailableCars, type AnalysisState } from './lapAssignmentState';

function run(id: string, file?: { name: string; revision: number; part: number }): Session {
  const lap: Lap = { lapNumber: 1, lapTime: 30, startTime: 0, endTime: 30, startIndex: 0, endIndex: 0,
    distance: 1, topSpeed: 150, bottomSpeed: 40, avgSpeed: 100, sectors: [], points: [] };
  return {
    id, sessionName: id, fileName: 'same.bon4', laps: [lap], points: [], date: '2026-01-01', circuitName: 'Course',
    samplingRate: 10, totalDistance: 1, bestLapIndex: 0, theoreticalBestTime: 30, sectors: [],
    ...(file && { sourceFile: { file: file.name, folder: 'track', storageRevision: file.revision,
      part: file.part, size: 12, mtimeMs: 34, courseHash: 'test' } })
  };
}
const empty = (): AnalysisState => ({ sessions: [], selectedCars: [] });

describe('ラップを Car へ割り当てる', () => {
  it('直接開いた同名ファイルの分割走行は、各セッションを独立に保持する', () => {
    const first = { ...run('first'), sessionName: 'log_1' }, second = { ...run('second'), sessionName: 'log_2' };
    expect(assignLap({ sessions: [first, second], selectedCars: [] }, [], first.id, 1, 0).sessions).toEqual([first]);
  });
  it('従来の選択窓口では未割当ての走行を閉じない', () => {
    const a = run('a'), b = run('b'), c = run('c');
    const initial = { sessions: [a, b, c], selectedCars: [] };
    const result = assignLap(initial, [], 'b', 1, 2, false);
    expect(result.sessions).toEqual([a, b, c]);
    expect(result.selectedCars[0].sessionId).toBe('b');
  });

  it('動画の保存担当として残す走行は全パートを保ち、別の不要な走行だけ閉じる', () => {
    const a = run('a1', { name: 'A.nmea', revision: 1, part: 1 });
    const a2 = run('a2', { name: 'A.nmea', revision: 1, part: 2 });
    const loose = run('loose'), unused = run('unused');
    const state = assignLap(empty(), [a, a2, loose, unused], a.id, 1, 0, false);
    const selected = assignLap(state, [], loose.id, 1, 0, true, [a.id]);
    expect(selected.sessions).toEqual([a, a2, loose]);
    expect(selected.selectedCars.map(c => c.sessionId)).toEqual([loose.id]);
    const next = assignLap(selected, [run('next')], 'next', 1, 0);
    expect(next.sessions.map(s => s.id)).toEqual(['next']);
  });

  it('動画に必要な旧版と、同じ道の新しい内容を同時に保持しない', () => {
    const a = run('a', { name: 'A.nmea', revision: 1, part: 1 }), loose = run('loose');
    const newer = run('new-a', { name: 'A.nmea', revision: 1, part: 1 }); newer.sourceFile!.mtimeMs++;
    const state = assignLap(empty(), [a, loose], loose.id, 1, 0, false);
    expect(() => assignLap(state, [newer], newer.id, 1, 1, true, [a.id])).toThrow();
    expect(state.sessions).toEqual([a, loose]);
  });

  it('同じ周を複数の枠に置ける。選び直した枠だけ距離補正を外す', () => {
    const a = run('a'), b = run('b');
    const initial = assignLap(empty(), [a], 'a', 1, 0);
    const duplicate = assignLap(initial, [], 'a', 1, 1);
    const corrected = { ...duplicate, selectedCars: duplicate.selectedCars.map(c => ({ ...c, distanceOffsetM: 37, setBy: 'auto' as const })) };
    const result = assignLap(corrected, [b], 'b', 1, 0);
    expect(result.selectedCars.map(c => [c.slot, c.sessionId, c.colorHex])).toEqual([[0, 'b', '#ef4444'], [1, 'a', '#3b82f6']]);
    expect(result.selectedCars[0].distanceOffsetM).toBeUndefined();
    expect(result.selectedCars[0].setBy).toBeUndefined();
    expect(result.selectedCars[1]).toBe(corrected.selectedCars[1]);
    expect(initial.sessions).toEqual([a]);
  });

  it('最新の一覧に追加し、4 台の割り当てから外れたログを閉じる。閉じたログは再利用できない', () => {
    let state = empty();
    for (let slot = 0; slot < 4; slot++) state = assignLap(state, [run(String(slot))], String(slot), 1, slot);
    const next = assignLap(state, [run('new')], 'new', 1, 2);
    expect(next.sessions.map(s => s.id)).toEqual(['0', '1', '3', 'new']);
    expect(next.selectedCars.map(c => c.sessionId)).toEqual(['0', '1', 'new', '3']);
    expect(() => assignLap(next, [], '2', 1, 3)).toThrow();
  });

  it('同じ保管場所・フォルダ・ファイルの分割はまとめて残し、別の保管場所の同名ファイルは閉じる', () => {
    const parts = [1, 2].map(part => run(`new-${part}`, { name: 'run.bon4', revision: 8, part }));
    const old = run('old', { name: 'run.bon4', revision: 7, part: 1 });
    const other = run('unassigned', { name: 'other/run.bon4', revision: 8, part: 1 });
    const result = assignLap({ sessions: [old, other], selectedCars: [] }, parts, 'new-2', 1, 2);
    expect(result.sessions).toEqual(parts);
    const replaced = assignLap(result, [old], 'old', 1, 2);
    expect(replaced.sessions).toEqual([old]);
  });

  it('同じ道でも内容の版が違えば、前の分割データを混ぜない', () => {
    const old = run('old', { name: 'run.bon4', revision: 1, part: 2 });
    const fresh = run('fresh', { name: 'run.bon4', revision: 1, part: 1 });
    fresh.sourceFile!.mtimeMs++;
    expect(assignLap({sessions:[old],selectedCars:[]},[fresh],'fresh',1,0).sessions).toEqual([fresh]);
    const selected = assignLap(empty(), [old], old.id, 1, 0);
    expect(() => assignLap(selected, [fresh], fresh.id, 1, 1)).toThrow(/Car 1/);
    expect(assignLap(selected, [fresh], fresh.id, 1, 0).sessions).toEqual([fresh]);
  });

  it('同じセッション ID を意図して読み直したとき、新しい点と名前を全枠に反映する', () => {
    const original = run('a');
    const previous = assignLap(empty(), [original], 'a', 1, 0);
    const fresh = { ...run('a'), sessionName: 'Updated' };
    const result = assignLap(previous, [fresh], 'a', 1, 3);
    expect(result.sessions[0]).toBe(fresh);
    expect(result.sessions[0].points).not.toBe(original.points);
    expect(result.selectedCars.map(c => c.label)).toEqual(['Updated (L1)', 'Updated (L1)']);
  });

  it('無効な枠・周には失敗し、もとの一覧を保つ', () => {
    const initial = assignLap(empty(), [run('keep')], 'keep', 1, 1);
    const snapshot = structuredClone(initial);
    for (const slot of [-1, 0.5, 4, NaN]) expect(() => assignLap(initial, [], 'keep', 1, slot)).toThrow();
    expect(() => assignLap(initial, [run('new')], 'new', 2, 0)).toThrow();
    expect(initial).toEqual(snapshot);
  });

  it('同じ ID の読み直しでほかの Car の周が消える場合は、全枠とも変更しない', () => {
    const a = run('a');
    const initial = assignLap(empty(), [a], 'a', 1, 1);
    const changed = { ...a, laps: [{ ...a.laps[0], lapNumber: 2 }] };
    expect(() => assignLap(initial, [changed], 'a', 2, 0)).toThrow(/Car 2/);
    expect(initial.sessions).toEqual([a]);
    expect(initial.selectedCars.map(c => c.lapNumber)).toEqual([1]);
  });

  it('同じ元を別の入口から解析しても ID・時計補正・手動のコース図を保ち、古い点列は使わない', () => {
    const old = { ...run('old', { name: 'run.bon4', revision: 1, part: 1 }), clockOffsetSec: 1.25,
      pathPolylines: [[[1, 2]]] as Array<Array<[number, number]>>, pathPolylinesSource: 'manual' as const };
    const fresh = run('new', { name: 'run.bon4', revision: 1, part: 1 });
    fresh.sourceFile!.courseHash = 'reordered-sectors';
    const [reused] = reuseStoredSessions([old], [fresh]);
    const initial = assignLap(empty(), [old], old.id, 1, 0);
    const result = assignLap(initial, [reused], reused.id, 1, 1);
    expect(result.sessions).toHaveLength(1);
    expect(reused.id).toBe(old.id);
    expect(reused.clockOffsetSec).toBe(1.25);
    expect(reused.pathPolylines).toBe(old.pathPolylines);
    expect(reused.points).toBe(fresh.points);
    expect(result.selectedCars.map(c => c.sessionId)).toEqual(['old', 'old']);
    const changed = { ...fresh, sourceFile: { ...fresh.sourceFile!, mtimeMs: 99 } };
    expect(reuseStoredSessions([old], [changed])[0]).toBe(changed);
  });

  it('コース変更後の自動コース図は引き継がず、別の Car の同じ番号の周の範囲も黙って変えない', () => {
    const old = { ...run('old', { name: 'run.bon4', revision: 1, part: 1 }),
      pathPolylines: [[[1, 2]]] as Array<Array<[number, number]>>, pathPolylinesSource: 'auto' as const };
    const fresh = run('new', { name: 'run.bon4', revision: 1, part: 1 });
    fresh.sourceFile!.courseHash = 'changed-course';
    fresh.laps = [{ ...fresh.laps[0], startTime: 10, endTime: 40 }];
    const [reused] = reuseStoredSessions([old], [fresh]);
    expect(reused.pathPolylines).toBeUndefined();
    const initial = assignLap(empty(), [old], old.id, 1, 0);
    expect(() => assignLap(initial, [reused], reused.id, 1, 1)).toThrow(/Car 1/);
    expect(initial.sessions[0]).toBe(old);
    expect(assignLap(initial, [reused], reused.id, 1, 0).sessions[0]).toBe(reused);
  });
});

describe('解析状態の同期更新', () => {
  it('復元中に外した走行や消えた周を割り当てず、最新の名前と基準枠を使う', () => {
    const a = run('live'), removed = run('removed');
    const stale = assignLap(assignLap(empty(), [removed], removed.id, 1, 0), [a], a.id, 1, 1).selectedCars;
    const current = { sessions: [{ ...a, sessionName: 'Latest' }], selectedCars: [] };
    const restored = selectAvailableCars(current, [...stale, { ...stale[1], slot: 3, lapNumber: 99 }]);
    expect(restored.sessions).toBe(current.sessions);
    expect(restored.selectedCars.map(c => [c.slot, c.sessionId, c.label])).toEqual([[1, 'live', 'Latest (L1)']]);
  });

  it('再解析で未保存の名前を消さず、共有する最新行のメモと車種を反映する', () => {
    const old = { ...run('old', { name: 'run.bon4', revision: 1, part: 1 }), sessionName: 'Unsaved name', runNote: 'Unsaved note', vehicleName: 'Unsaved car' };
    const parsed = run('new', { name: 'run.bon4', revision: 1, part: 1 });
    const reused = reuseStoredSessions([old], [parsed]);
    expect(reused[0].sessionName).toBe('Unsaved name');
    expect(reused[0].runNote).toBe('Unsaved note');
    const latest = applyRunMetadata(reused, { updatedAt: '', name: 'Latest name', car: 'Latest car' });
    expect(latest[0]).toMatchObject({ id: 'old', sessionName: 'Latest name', vehicleName: 'Latest car' });
    expect(latest[0].runNote).toBeUndefined();
    expect(latest[0].points).toBe(parsed.points);
  });

  it('続けて割り当てても直前の枠を残し、購読者には確定した一覧を渡す', () => {
    const store = createAnalysisStore();
    const snapshots: AnalysisState[] = [];
    const stop = store.subscribe(() => snapshots.push(store.getSnapshot()));
    const first = store.update(s => assignLap(s, [run('a')], 'a', 1, 0));
    const second = store.update(s => assignLap(s, [run('b')], 'b', 1, 1));
    expect(snapshots[0]).toBe(first);
    expect(snapshots[1]).toBe(second);
    expect(second.selectedCars.map(c => c.sessionId)).toEqual(['a', 'b']);
    expect(store.update(s => s)).toBe(second);
    expect(snapshots).toHaveLength(2);
    stop();
    store.update(s => assignLap(s, [], 'b', 1, 3));
    expect(snapshots).toHaveLength(2);
  });

  it('直前の割り当てで閉じた周は、その場で拒否して一覧も通知回数も変えない', () => {
    const store = createAnalysisStore({ sessions: [run('a'), run('b')], selectedCars: [] });
    let count = 0;
    store.subscribe(() => { count++; });
    const committed = store.update(s => assignLap(s, [], 'a', 1, 0));
    expect(() => store.update(s => assignLap(s, [], 'b', 1, 1))).toThrow();
    expect(store.getSnapshot()).toBe(committed);
    expect(count).toBe(1);
  });
});

it('同じ保存行へ向く別形式を同時に再利用しない', () => {
  const a = run('old-format', { name: 'run.bon4', revision: 1, part: 1 });
  const b = run('new-format', { name: 'run.nmea', revision: 1, part: 1 });
  expect(() => reuseStoredSessions([a], [b])).toThrow();
});
