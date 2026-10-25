import { describe, expect, it, vi } from 'vitest';

// アプリの窓口のふり: G センサーの知らせを受け取る先と、書き足したファイルの中身を覚える
const written: Record<string, string> = {};
let motion: ((b: unknown) => void) | null = null;
vi.mock('../native/bridge', () => ({
  hasNative: () => true,
  onNative: (event: string, fn: (b: unknown) => void) => { if (event === 'system.motion') motion = fn; return () => { motion = null; }; },
  callNative: async (method: string, params: { path?: string; b64?: string }) => {
    if (method === 'system.appendFile' && params.path && params.b64) written[params.path] = (written[params.path] ?? '') + Buffer.from(params.b64, 'base64').toString();
    return {};
  },
  toBase64: (b: Uint8Array) => Buffer.from(b).toString('base64')
}));

import { PhoneImuRecorder } from './phoneImu';

/** 縦に立てて止まっている端末の値 (t0 から 20 ms ごと n 個) */
function batch(t0: number, n: number) {
  const t = Array.from({ length: n }, (_, i) => t0 + i * 20);
  const z = t.map(() => 0);
  return { t, gx: z, gy: t.map(() => -1), gz: z, ux: z, uy: z, uz: z, rx: z, ry: z, rz: z };
}

describe('測り始めてから走行のファイルができるまでの G センサーの値', () => {
  it('取っておいて、ファイルができたら先頭に書く (PLAN-29 の 3)', async () => {
    let base: string | null = null;
    const rec = new PhoneImuRecorder(() => base);
    await rec.start();
    // 基準の傾き (0.5 秒) のあと、ファイルがまだ無い間の値
    motion!(batch(1000, 25));
    motion!(batch(1500, 50));
    // コースが決まって、走行のファイルができた
    base = 'sodegaura/20261025/20261025150000';
    motion!(batch(2500, 10));
    await rec.flush();
    const csv = written['sodegaura/20261025/20261025150000.iphone_imu.csv'] ?? '';
    const times = csv.split('\n').slice(1).filter(Boolean).map(l => Number(l.split(',')[0]));
    expect(times[0]).toBeLessThan(2000);
    expect(times).toContain(1500);
    expect(times[times.length - 1]).toBe(2680);
  });
});
