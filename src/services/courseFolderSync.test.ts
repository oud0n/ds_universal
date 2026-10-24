import { describe, expect, it } from 'vitest';
import { courseFileKey, courseFiles, itemFromCourseFiles, mergeEditedCourses, parseCourseIndex, type CourseIndexEntry } from './courseFolderSync';
import type { UserCircuitItem } from './userCircuitStorage';

const cl = { name: '日光', latA: 36.662468, lonA: 139.862454, latB: 36.662254, lonB: 139.862701 };
const s1 = { id: 'a', name: 'S1', latA: 36.661326, lonA: 139.863753, latB: 36.661539, lonB: 139.863392 };
const item = (over: Partial<UserCircuitItem> = {}): UserCircuitItem => ({
  id: 'edited:日光', name: '日光', controlLine: cl, sectors: [s1, { ...cl, id: 'f', name: 'S2' }], sources: { cln: 'edited' }, nameEn: 'Nikko', folder: 'nikko', ...over
});
const entry = (over: Partial<CourseIndexEntry> = {}): CourseIndexEntry => ({ name: '日光', file: 'nikko', nameEn: 'Nikko', folder: 'nikko', updatedAt: '2026-10-24T00:00:00Z', ...over });

describe('course/ のコース (コース編集で保存したもの)', () => {
  it('鍵は記録のフォルダ名、無ければ名前から', () => {
    expect(courseFileKey({ name: '日光', folder: 'nikko' })).toBe('nikko');
    expect(courseFileKey({ name: '日光' })).toMatch(/^c_[0-9a-z]+$/);
  });

  it('書いて読み直すと、計測線・セクター・ゴールの線が戻る (.sci に計測線・ゴールの線は入れない)', () => {
    const { cln, sci } = courseFiles(item());
    expect(sci.trim().split(/\r?\n/)).toHaveLength(1);
    const back = itemFromCourseFiles(entry(), cln, sci);
    expect(back.controlLine).toMatchObject({ latA: cl.latA, lonB: cl.lonB });
    expect(back.sectors.map(s => s.name)).toEqual(['S1', 'S2']);
    expect(back.sectors[1]).toMatchObject({ latA: cl.latA });
    expect(back).toMatchObject({ nameEn: 'Nikko', folder: 'nikko', id: 'edited:日光' });
    const fin = { name: 'Finish Line', latA: 36.7, lonA: 139.9, latB: 36.71, lonB: 139.91 };
    const stage = item({ finishLine: fin, sectors: [s1, { ...fin, id: 'f', name: 'S2' }] });
    const f2 = courseFiles(stage);
    expect(f2.sci.trim().split(/\r?\n/)).toHaveLength(1);
    const back2 = itemFromCourseFiles(entry({ finishLine: fin }), f2.cln, f2.sci);
    expect(back2.sectors[1]).toMatchObject({ latA: fin.latA });
    expect(back2.finishLine).toMatchObject({ latA: fin.latA });
  });

  it('同じ名前なら書いた時刻の新しいほう。端末の中にだけあるもの・端末のほうが新しいものは書く。消した印は消す', () => {
    const remoteNew = itemFromCourseFiles(entry({ updatedAt: '2026-10-25T00:00:00Z' }), courseFiles(item()).cln, null);
    const r1 = mergeEditedCourses([item({ updatedAt: '2026-10-24T00:00:00Z' })], [{ entry: entry({ updatedAt: '2026-10-25T00:00:00Z' }), item: remoteNew }]);
    expect(r1.edited[0].updatedAt).toBe('2026-10-25T00:00:00Z');
    expect(r1.upload).toEqual([]);
    const r2 = mergeEditedCourses([item({ updatedAt: '2026-10-26T00:00:00Z' })], [{ entry: entry({ updatedAt: '2026-10-25T00:00:00Z' }), item: remoteNew }]);
    expect(r2.edited[0].updatedAt).toBe('2026-10-26T00:00:00Z');
    expect(r2.upload.map(c => c.name)).toEqual(['日光']);
    const r3 = mergeEditedCourses([item({ name: '筑波', id: 'edited:筑波' })], []);
    expect(r3.upload.map(c => c.name)).toEqual(['筑波']);
    const r4 = mergeEditedCourses([item()], [{ entry: entry({ deleted: true }), item: null }]);
    expect(r4.edited).toEqual([]);
  });

  it('courses.json の壊れた行は使わない', () => {
    expect(parseCourseIndex(JSON.stringify({ version: 1, courses: { a: { name: 'x', file: '../a', updatedAt: 'x' }, b: { name: 'y', file: 'b', updatedAt: 'z' } } })).courses).toEqual({ b: { name: 'y', file: 'b', updatedAt: 'z' } });
    expect(parseCourseIndex('{').courses).toEqual({});
  });
});
