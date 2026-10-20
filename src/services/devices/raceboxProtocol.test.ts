import { describe, expect, it } from 'vitest';
import { RaceboxStream, raceboxChecksum } from './raceboxProtocol';

/** 資料 (Revision 9) の例のパケット */
const EXAMPLE = `B5 62 FF 01 50 00 A0 E7 0C 07 E6 07 01 0A 08 33
08 37 19 00 00 00 2A AD 4D 0E 03 01 EA 0B C6 93
E1 0D 3B 37 6F 19 61 8C 09 00 0F 01 09 00 9C 03
00 00 2C 07 00 00 23 00 00 00 00 00 00 00 D0 00
00 00 88 A9 DD 00 2C 01 00 59 FD FF 71 00 CE 03
2F FF 56 00 FC FF 06 DB`.split(/\s+/).map(h => parseInt(h, 16));
const packet = Uint8Array.from(EXAMPLE);

describe('RaceBox のデータのメッセージ (資料の例)', () => {
  it('確かめの値が資料と合う', () => {
    expect(raceboxChecksum(packet, 2, packet.length - 2)).toEqual([0x06, 0xdb]);
  });

  it('資料の読み方の答えと同じ値になる', () => {
    const [s] = new RaceboxStream().push(packet);
    expect(new Date(s.tMs).toISOString()).toBe('2022-01-10T08:51:08.240Z');
    expect(s.valid).toBe(true);
    expect(s.fixStatus).toBe(3);
    expect(s.satellites).toBe(11);
    expect(s.longitude).toBeCloseTo(23.2887238, 7);
    expect(s.latitude).toBeCloseTo(42.6719035, 7);
    expect(s.altitude).toBeCloseTo(590.095, 3);
    expect(s.speedKmh).toBeCloseTo(0.126, 3);
    expect(s.heading).toBe(0);
    expect(s.horizontalAccuracy).toBeCloseTo(0.924, 3);
    expect(s.battery).toEqual({ percent: 89, charging: false });
    expect([s.gX, s.gY, s.gZ]).toEqual([-0.003, 0.113, 0.974]);
    expect([s.rollRate, s.pitchRate, s.yawRate]).toEqual([-2.09, 0.86, -0.04]);
  });

  it('分かれて届いても、2 つつながって届いても読める', () => {
    const st = new RaceboxStream();
    expect(st.push(packet.slice(0, 20))).toEqual([]);
    expect(st.push(packet.slice(20, 50))).toEqual([]);
    expect(st.push(packet.slice(50)).length).toBe(1);
    const two = new Uint8Array(packet.length * 2 + 3);
    two.set([0x00, 0x12, 0x34], 0);
    two.set(packet, 3);
    two.set(packet, 3 + packet.length);
    expect(new RaceboxStream().push(two).length).toBe(2);
  });

  it('確かめの値が合わないパケットは捨てる', () => {
    const bad = packet.slice();
    bad[30] ^= 0xff;
    const st = new RaceboxStream();
    expect(st.push(bad)).toEqual([]);
    expect(st.dropped).toBe(1);
  });

  it('Micro では電池の欄を入力の電圧として読む', () => {
    const [s] = new RaceboxStream(true).push(packet);
    expect(s.battery).toBeNull();
    expect(s.inputVoltage).toBeCloseTo(8.9, 5);
  });
});
