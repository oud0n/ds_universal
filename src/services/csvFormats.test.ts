import { describe, expect, it } from 'vitest';
import { matchCsvFormat, mergeSensorRows, parseClock, parseCsvFormat, parseLogWithFormat, readRows, sensorKeyOf, zonedToUtcMs, type CsvFormat } from './csvFormats';
import { compileExpr, parseCalcFile, parseExpr } from './calcChannels';
import type { TelemetryPoint } from '../types/telemetry';

const logFmt: CsvFormat = {
  version: 1, id: 'user:aim', name: 'AiM', kind: 'log', header: ['Time', 'Lat', 'Lon', 'WaterT'], headerRow: 1, delimiter: ';',
  time: { column: 'Time', as: 'seconds' },
  columns: { Lat: { target: 'lat' }, Lon: { target: 'lon' }, Spd: { target: 'speed', speedUnit: 'm/s' }, WaterT: { target: 'custom:water', label: '水温', unit: '℃' }, Lap: { ignore: true } }
};
const logCsv = 'AiM export\nTime;Lat;Lon;Spd;WaterT;Lap\n0;35.4;140.1;10;80;1\n0.1;35.40001;140.10001;10;80.5;1\nx;1;1;1;1;1\n0.2;35.40002;140.10002;11;81;1\n';

describe('CSV の形式の定義 (PLAN-36)', () => {
  it('形式のファイルを読む (おかしな列は落とす)', () => {
    const f = parseCsvFormat(JSON.stringify({ ...logFmt, columns: { ...logFmt.columns, Bad: { target: 'nope' } } }), 'x');
    expect(f?.columns.Bad).toBeUndefined();
    expect(f?.columns.WaterT.target).toBe('custom:water');
    expect(parseCsvFormat('{"version":2}', 'x')).toBeNull();
  });

  it('当てるファイル: <走行>.<xxx>.csv は xxx、ほかは見出しの列', () => {
    const sensor: CsvFormat = { ...logFmt, id: 'user:obd', kind: 'sensor', sensorKey: 'obd_nd5', header: [] };
    expect(sensorKeyOf('sodegaura/20261024100000.obd_nd5.csv')).toBe('obd_nd5');
    expect(sensorKeyOf('export.csv')).toBeNull();
    expect(matchCsvFormat('a/20261024100000.obd_nd5.csv', '', [logFmt, sensor])).toBe(sensor);
    expect(matchCsvFormat('export.csv', logCsv, [logFmt, sensor])).toBe(logFmt);
    expect(matchCsvFormat('export.csv', 'Time;Lat\n', [logFmt])).toBeNull();
  });

  it('log: 列の行き先・単位・自分で名前を付けた値', () => {
    const r = parseLogWithFormat(logCsv, logFmt);
    expect(r.points).toHaveLength(3);
    expect(r.points[0].speed).toBeCloseTo(36);
    expect(r.points[2].custom?.water).toBe(81);
  });

  it('日時の文字はタイムゾーンで UTC に直す', () => {
    expect(zonedToUtcMs(2026, 10, 24, 10, 0, 0, 0, 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 24, 1, 0, 0));
    expect(parseClock('2026-10-24 10:00:00.5', 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 24, 1, 0, 0, 500));
    expect(parseClock('2026-10-24T01:00:00Z', 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 24, 1, 0, 0));
  });

  it('sensor: UTC の時刻で走行の点に合わせ、行の間は直線でつなぐ', () => {
    const fmt: CsvFormat = { version: 1, id: 'user:hr', name: 'hr', kind: 'sensor', sensorKey: 'hr', header: [], headerRow: 0, delimiter: ',', time: { column: 'time_utc_ms', as: 'utcMs' }, columns: { bpm: { target: 'custom:bpm' }, rpm: { target: 'rpm' } } };
    const t0 = Date.UTC(2026, 9, 24, 1, 0, 0);
    const rows = readRows(`time_utc_ms,bpm,rpm\n${t0},100,3000\n${t0 + 1000},110,4000\n${t0 + 10000},150,5000\n`, fmt);
    const pts = [0, 0.5, 1, 5].map((time, index) => ({ index, time } as TelemetryPoint));
    const out = mergeSensorRows(pts, t0, rows);
    expect(out[1].custom?.bpm).toBeCloseTo(105);
    expect(out[1].rpm).toBeCloseTo(3500);
    // 行の間が 2 秒より空いているところは入れない
    expect(out[3].custom).toBeUndefined();
    // 走行の時刻が UTC で分からないときは合わせない
    expect(mergeSensorRows(pts, null, rows)).toBe(pts);
  });
});

describe('計算式 (PLAN-36)', () => {
  const p = { speed: 100, rpm: 6000, gear: 3, brake: 20, custom: { water: 90 } } as unknown as TelemetryPoint;
  it('四則・比べる・関数・自分で名前を付けた値', () => {
    expect(compileExpr('speed * 0.5')(p)).toBe(50);
    expect(compileExpr('rpm / gear')(p)).toBe(2000);
    expect(compileExpr('(brake > 10) * 100')(p)).toBe(100);
    expect(compileExpr('max(water - 85, 0)')(p)).toBe(5);
    expect(compileExpr('-speed + 2 * 3')(p)).toBe(-94);
    expect(compileExpr('throttle')(p)).toBeUndefined();
    expect(compileExpr('speed / 0')(p)).toBeUndefined();
  });
  it('読めない式は理由を返し、ファイルからは落とす', () => {
    expect(() => parseExpr('speed *')).toThrow();
    expect(() => parseExpr('foo(1)')).toThrow();
    expect(parseCalcFile(JSON.stringify({ version: 1, channels: [{ key: 'mph', expr: 'speed * 0.621' }, { key: 'bad', expr: '(' }] })).map(c => c.key)).toEqual(['mph']);
  });
});
