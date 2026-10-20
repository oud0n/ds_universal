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
