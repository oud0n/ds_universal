import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bon4Header, fixesToBon4, fixesToNmea, runFileBase } from './runFiles';
import { parseDigispiceRawBinary } from './rawBinaryParser';
import { parseNmea } from './nmeaParser';
import { extractLaps } from './lapCalculator';
import { parseCln, parseSci } from './pthParser';
import type { LiveFix } from './liveLapTimer';

const SAMPLE = [path.resolve(__dirname, '../../sample'), path.resolve(__dirname, '../../../ds_universal/sample')]
  .map(d => path.join(d, 'Track', '袖ケ浦_ND5RC_RE005', '20260808_1_26_73'))
  .find(d => fs.existsSync(d));

describe('runFiles', () => {
  it('ファイルの名前は、走り始めの端末の時刻の YYYYMMDDhhmmss', () => {
    const ms = new Date(2026, 9, 24, 9, 5, 7).getTime();
    expect(runFileBase(ms)).toBe('20261024090507');
  });

  it.skipIf(!SAMPLE)('袖ヶ浦のログを bon4 と NMEA に書いて読み戻すと、同じ周のタイムになる', () => {
    const file = fs.readdirSync(SAMPLE!).find(f => f.endsWith('.bon4'))!;
    const buf = fs.readFileSync(path.join(SAMPLE!, file));
    const points = parseDigispiceRawBinary(file, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)).flatMap(p => p.points);
    const fixes: LiveFix[] = points.map(p => ({ tMs: new Date(p.timestamp!).getTime(), latitude: p.latitude, longitude: p.longitude, speedKmh: p.speed, altitude: p.altitude, valid: true }));
    const coursesDir = path.resolve(__dirname, '../../courses');
    const cl = parseCln(fs.readFileSync(path.join(coursesDir, 'ControlLine', 'sodegaura.cln'), 'utf8'), 'x');
    const sci = parseSci(fs.readFileSync(path.join(coursesDir, 'Sector', 'sodegaura.sci'), 'utf8'), 's');
    const lapTimes = (pts: typeof points) => extractLaps(pts, cl, sci).laps.filter(l => !l.isWholeSession && !l.isPartialLap).map(l => l.lapTime.toFixed(2));
    const original = lapTimes(points);
    expect(original.length).toBeGreaterThan(0);

    const bon4 = fixesToBon4(fixes);
    const back = parseDigispiceRawBinary('x.bon4', bon4.buffer.slice(bon4.byteOffset, bon4.byteOffset + bon4.byteLength) as ArrayBuffer).flatMap(p => p.points);
    expect(back.length).toBe(points.length);
    expect(lapTimes(back)).toEqual(original);

    const nmea = parseNmea(fixesToNmea(fixes));
    expect(lapTimes(nmea.points)).toEqual(original);
  });

  it.skipIf(!SAMPLE)('.bon4 の先頭 8 バイトは、最初の点から求めた確かめの値と一致する (実際のログと、書いたファイル)', () => {
    const file = fs.readdirSync(SAMPLE!).find(f => f.endsWith('.bon4'))!;
    const buf = fs.readFileSync(path.join(SAMPLE!, file));
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // 実際のログの最初の点を、そのまま LiveFix にして先頭の値を求める
    const first: LiveFix = { tMs: 0, speedKmh: (v.getUint16(8 + 2, true) / 100) * 3.6, latitude: v.getInt32(8 + 4, true) / 1e7, longitude: v.getInt32(8 + 8, true) / 1e7, valid: true };
    const head = new DataView(bon4Header(first).buffer).getFloat64(0, true);
    expect(Math.abs(head - v.getFloat64(0, true))).toBeLessThan(0.001);
    // 書いたファイルの先頭も、書いた最初の点と合う
    const written = fixesToBon4([first, { ...first, tMs: 50 }]);
    const wv = new DataView(written.buffer);
    expect(Math.abs(wv.getFloat64(0, true) - head)).toBeLessThan(1e-9);
  });
});
