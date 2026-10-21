import { describe, expect, it } from 'vitest';
import { DroggerStream, nmeaChecksumOk } from './droggerProtocol';

/** 確かめの値を付けた文 */
function nmea(body: string): string {
  let x = 0;
  for (const c of body) x ^= c.charCodeAt(0);
  return `$${body}*${x.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
}
const enc = (s: string) => new TextEncoder().encode(s);

const GGA = nmea('GNGGA,012345.20,3524.0000,N,14000.0000,E,4,24,0.6,45.3,M,39.0,M,1.0,0000');
const RMC = nmea('GNRMC,012345.20,A,3524.0000,N,14000.0000,E,54.0,90.0,211026,,,R');

describe('Drogger の NMEA (Bluetooth LE)', () => {
  it('確かめの値を見る', () => {
    expect(nmeaChecksumOk(RMC.trim())).toBe(true);
    expect(nmeaChecksumOk(RMC.trim().replace('54.0', '55.0'))).toBe(false);
  });

  it('GGA と RMC から、時刻・位置・速さ・高さ・衛星の数・測位の質をそろえる', () => {
    const s = new DroggerStream();
    const fixes = s.push(enc(GGA + RMC));
    expect(fixes).toHaveLength(1);
    const f = fixes[0];
    expect(new Date(f.tMs).toISOString()).toBe('2026-10-21T01:23:45.200Z');
    expect(f.latitude).toBeCloseTo(35.4, 6);
    expect(f.longitude).toBeCloseTo(140, 6);
    expect(f.speedKmh).toBeCloseTo(54 * 1.852, 6);
    expect(f).toMatchObject({ altitude: 45.3, satellites: 24, quality: 4, valid: true, course: 90 });
  });

  it('文が通知の途中で切れても、つないで読む', () => {
    const s = new DroggerStream();
    const all = GGA + RMC;
    const out = [...s.push(enc(all.slice(0, 30))), ...s.push(enc(all.slice(30, 100))), ...s.push(enc(all.slice(100)))];
    expect(out).toHaveLength(1);
  });

  it('落ちて壊れた文は捨て、次の文から読み直す', () => {
    const s = new DroggerStream();
    const broken = RMC.slice(0, 20); // 途中で落ちた
    const out = s.push(enc(broken + GGA + RMC));
    expect(out).toHaveLength(1);
    expect(out[0].altitude).toBe(45.3);
  });

  it('測位していない (V) は valid: false', () => {
    const s = new DroggerStream();
    const out = s.push(enc(nmea('GNRMC,012345.20,V,3524.0000,N,14000.0000,E,0.0,,211026,,,N')));
    expect(out[0].valid).toBe(false);
  });
});
