import { describe, expect, it } from 'vitest';
import { planRunDelete } from './runDelete';
import type { RunItem } from './runOpener';
import { readRunsFile, findRunRow } from './runsFile';
import type { RunStore } from './runStore';
import { daysLeft, listTrash, purgeExpired, restoreTrashedRun, trashRun, TRASH_DAYS } from './runTrash';

const DAY = 24 * 60 * 60 * 1000;

/** メモリの上の置き場 (ネイティブの RunTrash と同じ動き: .trash/<id>/<道> へ移す・戻す・消す) */
function memoryStore(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const boxes = new Map<string, { manifest: string; files: Map<string, string>; mtimeMs: number }>();
  const store = {
    async listAll() { return [...files.keys()].map(path => ({ path, size: files.get(path)!.length, mtimeMs: 0, local: true })); },
    async readText(p: string) { return files.get(p) ?? null; },
    async readTextStrict(p: string) { return files.get(p) ?? null; },
    async writeText(p: string, t: string) { files.set(p, t); },
    trash: {
      async move(paths: string[], id: string, manifest: string) {
        const box = { manifest, files: new Map<string, string>(), mtimeMs: 0 };
        const moved: string[] = [];
        for (const p of paths) { if (files.has(p)) { box.files.set(p, files.get(p)!); files.delete(p); } moved.push(p); }
        boxes.set(id, box);
        return { moved, failed: [] };
      },
      async list() { return [...boxes].map(([id, b]) => ({ id, manifest: b.manifest, files: [...b.files].map(([path, t]) => ({ path, size: t.length })), mtimeMs: b.mtimeMs })); },
      async restore(id: string) {
        const b = boxes.get(id)!;
        const restored: string[] = [];
        const failed: Array<{ path: string; error: string }> = [];
        for (const [p, t] of b.files) {
          if (files.has(p)) { failed.push({ path: p, error: 'exists' }); continue; }
          files.set(p, t); b.files.delete(p); restored.push(p);
        }
        if (!failed.length) boxes.delete(id);
        return { restored, failed };
      },
      async purge(ids: string[]) { ids.forEach(id => boxes.delete(id)); return { purged: ids, failed: [] }; }
    }
  } as unknown as RunStore;
  return { store, files, boxes };
}

const D = 'sodegaura/20261025';
const A = '20261025100000';
const item: RunItem = {
  folder: 'sodegaura', file: `20261025/${A}.nmea`, courseName: '袖ヶ浦', startMs: 1, lapCount: 12, best: 84.7,
  videos: [], synced: true, folderVideos: [], laps: [], pending: false, entry: null
};
const runsJson = (row: object) => JSON.stringify({ version: 2, runs: { [`20261025/${A}`]: row } });

describe('アプリのゴミ箱', () => {
  it('移すとファイルと runs.json の行が消え、戻すと名前・メモ・同期ごと戻る', async () => {
    const { store, files } = memoryStore({
      [`${D}/${A}.nmea`]: 'log', [`${D}/${A}.mov`]: 'video', [`${D}/GX010001.MP4`]: 'gopro',
      'sodegaura/runs.json': runsJson({ id: 'r1', updatedAt: '2026-10-25T00:00:00Z', name: '朝の走行', note: 'タイヤ新品', videos: [{ name: 'x.mov' }] })
    });
    const plan = planRunDelete(item, await store.listAll(), [item]);
    const now = Date.UTC(2026, 9, 28);
    expect((await trashRun(store, item, plan, now)).failed).toEqual([]);
    expect(files.has(`${D}/${A}.nmea`)).toBe(false);
    expect(files.has(`${D}/${A}.mov`)).toBe(false);
    // 付けていない動画は残る
    expect(files.has(`${D}/GX010001.MP4`)).toBe(true);
    expect(findRunRow(await readRunsFile(store, 'sodegaura'), item.file)).toBeNull();

    const trashed = await listTrash(store);
    expect(trashed).toHaveLength(1);
    expect(trashed[0].manifest?.row?.name).toBe('朝の走行');
    expect(trashed[0].manifest?.lapCount).toBe(12);
    expect(trashed[0].size).toBe('log'.length + 'video'.length);
    expect(daysLeft(trashed[0], now)).toBe(TRASH_DAYS);

    expect((await restoreTrashedRun(store, trashed[0])).failed).toEqual([]);
    expect(files.get(`${D}/${A}.nmea`)).toBe('log');
    expect(files.get(`${D}/${A}.mov`)).toBe('video');
    const row = findRunRow(await readRunsFile(store, 'sodegaura'), item.file);
    // 印 (id) も戻る (解析用のセッション・参考ラップが走行を指すのに使う)
    expect(row).toMatchObject({ id: 'r1', name: '朝の走行', note: 'タイヤ新品', videos: [{ name: 'x.mov' }] });
    expect(await listTrash(store)).toEqual([]);
  });

  it('戻す先に同じ名前があるファイルは上書きせず、ゴミ箱に残す', async () => {
    const { store, files } = memoryStore({ [`${D}/${A}.nmea`]: 'log', [`${D}/${A}.mov`]: 'video' });
    await trashRun(store, item, planRunDelete(item, await store.listAll(), [item]));
    files.set(`${D}/${A}.mov`, 'new video');
    const [t] = await listTrash(store);
    const r = await restoreTrashedRun(store, t);
    expect(r.failed).toEqual([{ path: `${D}/${A}.mov`, error: 'exists' }]);
    expect(files.get(`${D}/${A}.mov`)).toBe('new video');
    expect(files.get(`${D}/${A}.nmea`)).toBe('log');
    expect(await listTrash(store)).toHaveLength(1);
  });

  it('30 日を過ぎたものだけ本当に消す', async () => {
    const { store, files } = memoryStore({ [`${D}/${A}.nmea`]: 'log', [`${D}/20261025110000.nmea`]: 'log2' });
    const t0 = Date.UTC(2026, 9, 1);
    await trashRun(store, item, planRunDelete(item, await store.listAll(), [item]), t0);
    const b: RunItem = { ...item, file: '20261025/20261025110000.nmea' };
    await trashRun(store, b, planRunDelete(b, [...files.keys()].map(path => ({ path, size: 1, mtimeMs: 0, local: true })), [b]), t0 + 5 * DAY);
    const now = t0 + TRASH_DAYS * DAY + 1;
    const left = await purgeExpired(store, await listTrash(store), now);
    expect(left).toHaveLength(1);
    expect(left[0].manifest?.file).toBe(b.file);
    expect(await listTrash(store)).toHaveLength(1);
    expect(daysLeft(left[0], now)).toBe(5);
  });

  it('trash.json が読めないものも、フォルダの時刻で並べて出す。ただし自動では消さない', async () => {
    const { store, boxes } = memoryStore({});
    boxes.set('x', { manifest: '{broken', files: new Map([['a/b.nmea', '1']]), mtimeMs: 0 });
    const [t] = await listTrash(store);
    expect(t).toMatchObject({ id: 'x', manifest: null, trashedAt: 0 });
    expect(await purgeExpired(store, [t], Date.UTC(2026, 9, 28))).toHaveLength(1);
    expect(boxes.has('x')).toBe(true);
  });
});
