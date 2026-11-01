import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fixLoneSecondJumps, isLoneSecondJump } from './timeRepair';
import { parseNmea } from '../services/nmeaParser';
import { calculateNmeaChecksum } from '../services/nmeaExporter';
import { parseDigispiceRawBinary } from '../services/rawBinaryParser';

describe('GPS の時刻の飛び (BUG-41)', () => {
  it('1 点だけ 1 秒先へ飛んで次で戻る点を、1 秒戻す', () => {
    const t = [1.79, 1.84, 1.89, 1.94, 2.99, 2.1, 2.15];
    expect(fixLoneSecondJumps(t)).toEqual([4]);
    expect(t[4]).toBeCloseTo(1.99, 6);
  });

  it('本当に 1 秒空いた記録 (次の点も先へ進む) は直さない', () => {
    const t = [1.84, 1.89, 1.94, 2.99, 3.04, 3.09];
    expect(fixLoneSecondJumps(t)).toEqual([]);
    expect(t[3]).toBe(2.99);
  });

  it('1 点ずつ読む所の見分け', () => {
    expect(isLoneSecondJump(1.94, 2.99, 2.1)).toBe(true);
    expect(isLoneSecondJump(1.94, 2.99, 3.04)).toBe(false);
    expect(isLoneSecondJump(1.94, 1.99, 1.9)).toBe(false);
  });

  it('NMEA を読むとき、飛んだ点を戻し、続く点を捨てない', () => {
    const tod = ['035901.840', '035901.890', '035901.940', '035902.990', '035902.040', '035902.090', '035902.140'];
    const text = tod.map((t, i) => {
      const body = `GPRMC,${t},A,3523.70${String(i).padStart(4, '0')},N,14005.305608,E,10.000,90.00,301026,,,A`;
      return `$${body}*${calculateNmeaChecksum(body)}`;
    }).join('\n');
    const { points } = parseNmea(text, 'x.nmea');
    expect(points.length).toBe(7);
    expect(points.map(p => p.timestamp!.slice(17, 23))).toEqual(['01.840', '01.890', '01.940', '01.990', '02.040', '02.090', '02.140']);
    for (let i = 1; i < points.length; i++) expect(points[i].time).toBeGreaterThan(points[i - 1].time);
  });
});

// 2026-10-30 の袖ヶ浦: .nmea・.bon4 にその 1 点がある走行 (../private にあるときだけ)
const DIR = `${process.cwd()}/../private/samples/pro_compare_sodegaura_20261030`;
describe.skipIf(!existsSync(`${DIR}/20261030125425.nmea`))('実際の走行 (袖ヶ浦 10/30)', () => {
  it('同じ走行の .nmea と .bon4 で点の数が同じになり、時刻の順も同じ', () => {
    const nmea = parseNmea(readFileSync(`${DIR}/20261030125425.nmea`, 'utf8'), '20261030125425.nmea').points;
    const b = readFileSync(`${DIR}/20261030125425.bon4`);
    const bon4 = parseDigispiceRawBinary('x.bon4', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).flatMap(s => s.points);
    expect(nmea.length).toBe(bon4.length);
    // .bon4 は 1/100 秒を 98 までで書く (bon4Writer) ので、.99 の点だけ 0.01 秒ずれる
    const far = nmea.filter((p, i) => Math.abs(Date.parse(p.timestamp!) - Date.parse(bon4[i].timestamp!)) > 20).length;
    expect(far).toBe(0);
  });
});
