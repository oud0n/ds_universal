import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createCourseParsers, parseCln, parseSci, exportCln, exportSci } from './courseFiles';
import { findMatchingCourse } from './courseMatch';
import { parseNmea } from './nmeaParser';
import { lapsFromAnyFile, lapsFromFile, groupRunsByFolder, reconcileFolder, type LapIndex } from './lapIndex';
import type { CsvFormat } from './csvFormats';
import { planRunDelete } from '../services/runDelete';
import type { RunItem } from './runRecords';

describe('UIに依存しないコースと対応ログ', () => {
  const bytes = fs.readFileSync('public/demo/sodegaura_20260815.nmea');
  const line = parseCln(fs.readFileSync('courses/ControlLine/sodegaura.cln', 'utf8'));
  it('計測線とセクターを同じ精度で往復し、言語は呼び出し側が選ぶ', () => {
    expect(parseCln(exportCln(line))).toEqual(line);
    const sectors = parseSci('35,139,35.1,139.1,1\r\n', 'a');
    expect(parseSci(exportSci(sectors), 'a')).toEqual(sectors);
    expect(() => createCourseParsers(ja => ja).parseCln('')).toThrow('無効な .cln');
  });
  it('公開実ログで袖ヶ浦を選び、無関係な場所へ計測線を割り当てない', () => {
    const points = parseNmea(bytes.toString(), 'demo.nmea').points;
    const courses = [{ id: 'sodegaura', centerLat: line.latA, centerLon: line.lonA, controlLine: line }];
    expect(findMatchingCourse(courses, points[0].latitude, points[0].longitude, points)?.id).toBe('sodegaura');
    expect(findMatchingCourse(courses, 0, 0, points)).toBeUndefined();
  });
  it('内容が同じNMEAとLOGで周の識別・境界・セクターを保持する', async () => {
    const course = { name: 'Sodegaura', controlLine: line, sectors: [] };
    expect(await lapsFromAnyFile('demo.log', bytes, course)).toEqual(lapsFromFile('demo.nmea', bytes, course));
    const files = ['a/test.csv', 'a/test.fit', 'a/test.nmea', 'a/test.bon4', 'a/test.iphone_imu.csv', 'a/test.obd.csv', 'exports/a.gpx'].map(path => ({ path, size: 1, mtimeMs: 1 }));
    expect([...groupRunsByFolder(files).values()].flat().map(f => f.path)).toEqual(['a/test.csv', 'a/test.fit', 'a/test.nmea']);
    expect([...groupRunsByFolder([{ path: 'a/20261107/log.gpx', size: 1, mtimeMs: 1 }]).keys()]).toEqual(['a']);
    expect([...groupRunsByFolder([{ path: 'a/session.racechrono.csv', size: 1, mtimeMs: 1 }]).values()].flat()).toHaveLength(1);
  });
  it('別形式の同名走行は削除も独立し、所有の分からない付属ファイルを残す', () => {
    const csv = { folder: 'a', file: 'test.csv', videos: [] } as unknown as RunItem;
    const fit = { ...csv, file: 'test.fit' };
    const files = ['a/test.csv', 'a/test.fit', 'a/test.mov', 'a/test.obd.csv'].map(path => ({ path, size: 1, mtimeMs: 1, local: true }));
    expect(planRunDelete(csv, files, [csv, fit]).remove.map(f => f.path)).toEqual(['a/test.csv']);
  });
  it('登録済みCSV定義を索引に渡し、定義変更後は同じファイルでも再計算する', async () => {
    const points = parseNmea(bytes.toString(), 'demo.nmea').points;
    const csv = new TextEncoder().encode('Time;Lat;Lon;Speed\n' + points.map(p => [p.time, p.latitude, p.longitude, p.speed].join(';')).join('\n'));
    const format: CsvFormat = { version: 1, id: 'user:test', name: 'Test', kind: 'log', header: ['Time', 'Lat', 'Lon', 'Speed'], headerRow: 0, delimiter: ';', time: { column: 'Time', as: 'seconds' }, columns: { Lat: { target: 'lat' }, Lon: { target: 'lon' }, Speed: { target: 'speed', speedUnit: 'km/h' } } };
    const course = { name: 'Sodegaura', controlLine: line, sectors: [] };
    const compute = (name: string, b: Uint8Array) => lapsFromAnyFile(name, b, course, [format]);
    const files = [{ path: 'a/run.csv', size: csv.length, mtimeMs: 1 }];
    const first = await reconcileFolder('a', files, course, null, async () => csv, compute, undefined, 'format-1');
    expect(first.index.files['run.csv'].laps).toHaveLength(12);
    const reused = await reconcileFolder('a', files, course, first.index, async () => csv, compute, undefined, 'format-1');
    expect(reused.computed).toBe(0);
    // NMEA以外の古い索引も推定フラグを再生成する。
    const old = structuredClone(reused.index);
    old.files['run.csv'].split = 2;
    expect((await reconcileFolder('a', files, course, old, async () => csv, compute, undefined, 'format-1')).computed).toBe(1);
    expect((await reconcileFolder('a', files, course, reused.index as LapIndex, async () => csv, compute, undefined, 'format-2')).computed).toBe(1);
  });
});
