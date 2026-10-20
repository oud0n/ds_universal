import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fixesToBon4, fixesToNmea, runFileBase } from './runFiles';
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
    const cl = parseCln(fs.readFileSync(path.join(coursesDir, 'sodegaura.cln'), 'utf8'), 'x');
    const sci = parseSci(fs.readFileSync(path.join(coursesDir, 'sodegaura.sci'), 'utf8'), 's');
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
});
