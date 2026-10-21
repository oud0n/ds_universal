import { describe, expect, it } from 'vitest';
import { parseHeartRate } from './heartRateProtocol';

describe('心拍計 (標準の Heart Rate Measurement)', () => {
  it('8 ビットの心拍', () => {
    expect(parseHeartRate(Uint8Array.from([0x00, 72]))).toEqual({ bpm: 72, contact: null, rrMs: [] });
  });
  it('16 ビットの心拍・肌に触れている', () => {
    expect(parseHeartRate(Uint8Array.from([0x07, 0x2c, 0x01]))).toEqual({ bpm: 300, contact: true, rrMs: [] });
  });
  it('肌に触れていない', () => {
    expect(parseHeartRate(Uint8Array.from([0x04, 60]))?.contact).toBe(false);
  });
  it('消費エネルギーを飛ばして RR 間隔を読む', () => {
    // 印 0x18: エネルギーあり・RR あり。心拍 150、エネルギー 0x0010、RR 1024 (= 1000 ms) と 512 (= 500 ms)
    expect(parseHeartRate(Uint8Array.from([0x18, 150, 0x10, 0x00, 0x00, 0x04, 0x00, 0x02]))).toEqual({ bpm: 150, contact: null, rrMs: [1000, 500] });
  });
  it('短すぎるものは読まない', () => {
    expect(parseHeartRate(Uint8Array.from([0x01, 0x10]))).toBeNull();
    expect(parseHeartRate(new Uint8Array(0))).toBeNull();
  });
});
