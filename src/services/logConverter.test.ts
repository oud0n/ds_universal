import { describe, expect, it } from 'vitest';
import { convertToNmea, type ConvertedPoint } from './logConverter';
import { parseNmea } from './nmeaParser';

/** .bon4 の速度 (0.01 m/s の整数) を NMEA に書いて読み戻し、同じ整数に戻るか */
describe('NMEA の速度の細かさ', () => {
  it('.bon4 の速度の値が、NMEA を通しても変わらない', () => {
    const raws: number[] = [];
    for (let r = 0; r <= 12000; r++) raws.push(r); // 0〜432 km/h はすべて
    for (let r = 12001; r <= 0xffff; r += 97) raws.push(r);
    const t0 = Date.UTC(2026, 9, 12, 4, 31, 31);
    const points: ConvertedPoint[] = raws.map((raw, i) => ({
      time: new Date(t0 + i * 50),
      elapsed: i * 0.05,
      latitude: 35.5 + i * 1e-7,
      longitude: 140.0,
      altitude: 20.5,
      speed: raw * 0.036,
      heading: 0,
      satellites: null,
      distance: 0,
      source: undefined as never
    }));
    const { points: back } = parseNmea(convertToNmea(points));
    expect(back.length).toBe(raws.length);
    const bad = back.filter((p, i) => Math.round((p.speed / 3.6) * 100) !== raws[i]);
    expect(bad.length).toBe(0);
  });
});

import { parseDigispiceRawBinary } from './rawBinaryParser';
import { selectConvertPoints } from './logConverter';
import { fileDateHint } from './nmeaParser';
import type { Session, TelemetryPoint } from '../types/telemetry';

const sessionOf = (points: TelemetryPoint[], date = '2026-10-12'): Session =>
  ({ points, laps: [], date } as unknown as Session);

/** NMEA の 1 行を、チェックサムを付けて作る */
function line(body: string): string {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return `$${body}*${c.toString(16).toUpperCase().padStart(2, '0')}`;
}

const ggaParts = (text: string) =>
  text.split('\r\n').filter(l => l.includes('GGA,')).map(l => l.slice(1, l.indexOf('*')).split(','));

describe('NMEA の GGA の欄を書き戻す', () => {
  it('品質・HDOP・ジオイド高・DGPS の欄が、読み込んで書き出しても変わらない', () => {
    const src = [
      line('GPGGA,043131.00,3608.984510,N,13955.275110,E,2,12,0.8,25.34,M,39.1,M,1.5,0123'),
      line('GPRMC,043131.00,A,3608.984510,N,13955.275110,E,10.123,90.00,121026,,,A'),
      line('GPGGA,043131.10,3608.984610,N,13955.275210,E,4,09,1.20,25.4,M,-3.5,M,,'),
      line('GPRMC,043131.10,A,3608.984610,N,13955.275210,E,10.200,90.00,121026,,,A')
    ].join('\r\n');
    const parsed = parseNmea(src, 'test.nmea');
    const out = convertToNmea(selectConvertPoints(sessionOf(parsed.points), { kind: 'all' }));
    const [a, b] = ggaParts(out);
    // 6 品質, 7 衛星数, 8 HDOP, 9 標高, 11 ジオイド高, 13 DGPS の経過秒, 14 基準局
    expect([a[6], a[7], a[8], a[9], a[11], a[13], a[14]]).toEqual(['2', '12', '0.8', '25.34', '39.1', '1.5', '0123']);
    expect([b[6], b[7], b[8], b[9], b[11], b[13], b[14]]).toEqual(['4', '09', '1.20', '25.4', '-3.5', '', '']);
    // 読み込んだ速度 (0.001 ノット) もそのまま書き戻す
    const rmc = out.split('\r\n').filter(l => l.includes('RMC,')).map(l => l.split(',')[7]);
    expect(rmc).toEqual(['10.123', '10.200']);
    // 書き出したものをもう一度読んで書いても、GGA と速度は同じ (方位は位置から求め直すことがあるので比べない)
    const again = convertToNmea(selectConvertPoints(sessionOf(parseNmea(out).points), { kind: 'all' }));
    expect(ggaParts(again)).toEqual(ggaParts(out));
    expect(again.split('\r\n').filter(l => l.includes('RMC,')).map(l => l.split(',')[7])).toEqual(rmc);
  });

  it('欄の無い NMEA や .bon4 からの書き出しは、これまでと同じ形 (品質 1、ほかは空欄)', () => {
    const src = [
      line('GPGGA,043131.00,3608.98451,N,13955.27511,E,1,,,,M,,M,,'),
      line('GPRMC,043131.00,A,3608.98451,N,13955.27511,E,0.00,0.00,121026,,,A')
    ].join('\r\n');
    const parsed = parseNmea(src);
    expect(parsed.points[0].ggaFields).toBeUndefined();
    const [a] = ggaParts(convertToNmea(selectConvertPoints(sessionOf(parsed.points), { kind: 'all' })));
    expect(a.slice(6)).toEqual(['1', '', '', '', 'M', '', 'M', '', '']);
  });
});

describe('.bon4 → NMEA → .bon4 (逆変換)', () => {
  it('速度・緯度経度・標高・時刻が、.bon4 の値のまま戻る', () => {
    const n = 400;
    const buf = new ArrayBuffer(8 + n * 26);
    const v = new DataView(buf);
    const t0 = Date.UTC(2026, 9, 12, 4, 31, 31, 750);
    const recs = Array.from({ length: n }, (_, i) => ({
      speed: (i * 37) % 6000,
      lat: 361497418 + i * 13,
      lon: 1399212518 - i * 7,
      alt: 144 + (i % 50),
      ms: t0 + i * 50
    }));
    recs.forEach((r, i) => {
      const o = 8 + i * 26;
      const d = new Date(r.ms);
      v.setUint16(o, 0x2085, true);
      v.setUint16(o + 2, r.speed, true);
      v.setInt32(o + 4, r.lat, true);
      v.setInt32(o + 8, r.lon, true);
      v.setInt32(o + 12, r.alt, true);
      v.setUint16(o + 16, 0x00c0, true);
      v.setUint16(o + 18, d.getUTCFullYear(), true);
      v.setUint8(o + 20, d.getUTCMonth() + 1);
      v.setUint8(o + 21, d.getUTCDate());
      v.setUint8(o + 22, d.getUTCHours());
      v.setUint8(o + 23, d.getUTCMinutes());
      v.setUint8(o + 24, d.getUTCSeconds());
      v.setUint8(o + 25, Math.round(d.getUTCMilliseconds() / 10));
    });
    const [part] = parseDigispiceRawBinary('20261012133132.bon4', buf);
    const nmea = convertToNmea(selectConvertPoints(sessionOf(part.points as TelemetryPoint[]), { kind: 'all' }));
    const back = parseNmea(nmea, '20261012133132_UTC.nmea').points;
    expect(back.length).toBe(n);
    back.forEach((p, i) => {
      const r = recs[i];
      expect(Math.round((p.speed / 3.6) * 100)).toBe(r.speed);
      expect(Math.round(p.latitude * 1e7)).toBe(r.lat);
      expect(Math.round(p.longitude * 1e7)).toBe(r.lon);
      expect(Math.round(p.altitude * 10)).toBe(r.alt);
      expect(new Date(p.timestamp!).getTime()).toBe(r.ms);
    });
  });
});

describe('日付の無い NMEA は、ファイル名の日付を使う', () => {
  const ggaOnly = (times: string[]) =>
    times.map((t, i) => line(`GPGGA,${t},3608.98${451 + i * 10},N,13955.27511,E,1,08,,20.0,M,,M,,`)).join('\r\n');

  it('ファイル名の日付と、GGA の時刻で日時が付く', () => {
    const { points, startDate } = parseNmea(ggaOnly(['043131.00', '043131.10', '043131.20']), 'log_2026-10-12.nmea');
    expect(points[0].timestamp).toBe('2026-10-12T04:31:31.000Z');
    expect(points[2].timestamp).toBe('2026-10-12T04:31:31.200Z');
    expect(startDate?.toISOString()).toBe('2026-10-12T04:31:31.000Z');
  });

  it('ファイル名が端末の時刻 (日本の朝 8 時) で、UTC では前の日のとき', () => {
    const { points } = parseNmea(ggaOnly(['230001.00', '230001.10']), '20261013080000.nmea');
    expect(points[0].timestamp).toBe('2026-10-12T23:00:01.000Z');
  });

  it('日付の欄が空の RMC も、ファイル名の日付で日時が付き、0 時をまたぐと次の日になる', () => {
    const rmc = ['235959.80', '235959.90', '000000.00', '000000.10'].map((t, i) =>
      line(`GPRMC,${t},A,3608.98${451 + i * 10},N,13955.27511,E,20.000,0.00,,,,A`)).join('\r\n');
    const { points } = parseNmea(rmc, 'log_20261012.nmea');
    expect(points.map(p => p.timestamp)).toEqual([
      '2026-10-12T23:59:59.800Z', '2026-10-12T23:59:59.900Z', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.100Z'
    ]);
    expect(points.map(p => p.time)).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it('ファイル名に日付が無ければ、これまでどおり日時は付けない', () => {
    const { points } = parseNmea(ggaOnly(['043131.00', '043131.10']), 'track.nmea');
    expect(points[0].timestamp).toBeUndefined();
  });

  it('日付として読めない数字は使わない', () => {
    expect(fileDateHint('20261399.nmea')).toBeNull();
    expect(fileDateHint('run_20261012133132.nmea')?.localMs).toBe(Date.UTC(2026, 9, 12, 13, 31, 32));
  });
});

import { convertToBon4 } from './logConverter';
import { bon4Header } from './bon4Writer';

describe('.bon4 で書き出す', () => {
  /** 確かめの値まで正しい .bon4 を作る */
  function makeBon4(n: number): Uint8Array {
    const out = new Uint8Array(8 + n * 26);
    const v = new DataView(out.buffer);
    const t0 = Date.UTC(2026, 9, 12, 4, 31, 31, 750);
    for (let i = 0; i < n; i++) {
      const o = 8 + i * 26;
      const d = new Date(t0 + i * 50);
      v.setUint16(o, 0x2085, true);
      v.setUint16(o + 2, (i * 41) % 5000, true);
      v.setInt32(o + 4, 361497418 + i * 11, true);
      v.setInt32(o + 8, 1399212518 - i * 5, true);
      v.setInt32(o + 12, 150 + (i % 30), true);
      v.setUint16(o + 16, 0x00c0, true);
      v.setUint16(o + 18, d.getUTCFullYear(), true);
      v.setUint8(o + 20, d.getUTCMonth() + 1);
      v.setUint8(o + 21, d.getUTCDate());
      v.setUint8(o + 22, d.getUTCHours());
      v.setUint8(o + 23, d.getUTCMinutes());
      v.setUint8(o + 24, d.getUTCSeconds());
      v.setUint8(o + 25, Math.round(d.getUTCMilliseconds() / 10));
    }
    const first = { tMs: t0, latitude: 361497418 / 1e7, longitude: 1399212518 / 1e7, speedKmh: 0 };
    out.set(bon4Header(first), 0);
    return out;
  }

  it('.bon4 を読み込んで .bon4 で書き出すと、元のファイルと同じになる (時刻の調整をしていても)', () => {
    const src = makeBon4(300);
    const [part] = parseDigispiceRawBinary('20261012133132.bon4', src.slice().buffer);
    const session = sessionOf(part.points as TelemetryPoint[]);
    expect(convertToBon4(selectConvertPoints(session, { kind: 'all' }, 0), 0)).toEqual(src);
    expect(convertToBon4(selectConvertPoints(session, { kind: 'all' }, 9), 9)).toEqual(src);
  });

  it('NMEA から作った .bon4 を読み込むと、NMEA と同じ点になる', () => {
    const nmea = [
      line('GPGGA,043131.00,3608.984510,N,13955.275110,E,1,10,,25.3,M,,M,,'),
      line('GPRMC,043131.00,A,3608.984510,N,13955.275110,E,10.123,90.00,121026,,,A'),
      line('GPGGA,043131.10,3608.984610,N,13955.275210,E,1,10,,25.4,M,,M,,'),
      line('GPRMC,043131.10,A,3608.984610,N,13955.275210,E,10.200,90.00,121026,,,A')
    ].join('\r\n');
    const from = parseNmea(nmea, 'a.nmea').points;
    const bytes = convertToBon4(selectConvertPoints(sessionOf(from), { kind: 'all' }));
    expect(bytes.length).toBe(8 + 2 * 26);
    const [part] = parseDigispiceRawBinary('a.bon4', bytes.slice().buffer);
    const back = part.points as TelemetryPoint[];
    back.forEach((p, i) => {
      expect(p.latitude).toBeCloseTo(from[i].latitude, 7);
      expect(p.longitude).toBeCloseTo(from[i].longitude, 7);
      expect(p.altitude).toBeCloseTo(from[i].altitude, 1);
      expect(Math.abs(p.speed - from[i].speed)).toBeLessThan(0.02);
      expect(p.timestamp).toBe(from[i].timestamp);
    });
    // 先頭の確かめの値は、書いた最初の点から求めたもの
    expect(Array.from(bytes.slice(0, 8))).toEqual(Array.from(bon4Header({ tMs: 0, latitude: from[0].latitude, longitude: from[0].longitude, speedKmh: from[0].speed })));
  });
});

describe('.bon4 の読み込み', () => {
  it('1/100 秒が 99 の点 (時刻が前後と合わない点) は読まない', () => {
    const n = 5;
    const buf = new ArrayBuffer(8 + n * 26);
    const v = new DataView(buf);
    // 24.94 → (99: 位置は 25.0 前後) → 25.10 → 25.15 → 25.20
    const rows: Array<[number, number, number]> = [[24, 94, 0], [25, 99, 1], [25, 10, 2], [25, 15, 3], [25, 20, 4]];
    rows.forEach(([sec, sub, k], i) => {
      const o = 8 + i * 26;
      v.setUint16(o, 0x2085, true);
      v.setUint16(o + 2, 2300, true);
      v.setInt32(o + 4, 353937096 - k * 62, true);
      v.setInt32(o + 8, 1400881716 - k * 100, true);
      v.setInt32(o + 12, 926, true);
      v.setUint16(o + 16, 0x00c0, true);
      v.setUint16(o + 18, 2026, true);
      v.setUint8(o + 20, 9);
      v.setUint8(o + 21, 13);
      v.setUint8(o + 22, 0);
      v.setUint8(o + 23, 42);
      v.setUint8(o + 24, sec);
      v.setUint8(o + 25, sub);
    });
    const [part] = parseDigispiceRawBinary('a.bon4', buf);
    const times = (part.points as TelemetryPoint[]).map(p => p.timestamp);
    expect(times).toEqual(['2026-09-13T00:42:24.940Z', '2026-09-13T00:42:25.100Z', '2026-09-13T00:42:25.150Z', '2026-09-13T00:42:25.200Z']);
  });
});
