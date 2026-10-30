import { describe, expect, it } from 'vitest';
import { alignImu, fuseImuG, imuWobbleG, lowPassTrack, parseImuCsv, WOBBLE_LIMIT_G, type ImuTrack } from './imuG';
import type { TelemetryPoint } from '../types/telemetry';

// 本当の加減速 G: 4 秒ごとに 加速 0.3 G (2 秒) → ブレーキ −0.9 G (1 秒) → 0 (1 秒)
const trueLong = (t: number) => { const k = t % 4; return k < 2 ? 0.3 : k < 3 ? -0.9 : 0; };
const trueLat = (t: number) => 0.8 * Math.sin((2 * Math.PI * t) / 6);
const START = Date.UTC(2026, 9, 25, 0, 0, 0);

/** 20 Hz の点。計算した G は、本当の G を前後 0.6 秒でならしたもの (速い変化が鈍る) に揺れを足したもの */
function points(): TelemetryPoint[] {
  const out: TelemetryPoint[] = [];
  for (let i = 0; i < 20 * 60; i++) {
    const t = i / 20;
    let sl = 0, sa = 0, n = 0;
    for (let k = -6; k <= 6; k++) { sl += trueLong(t + k / 20); sa += trueLat(t + k / 20); n++; }
    const noise = 0.05 * Math.sin(i * 1.7);
    out.push({ index: i, time: t, latitude: 35, longitude: 140, altitude: 0, speed: 100, heading: 0, distance: 0,
      accelG: sl / n + noise, corneringG: sa / n - noise, combinedG: 0, turningRadius: 9999, driftAngle: 0 } as TelemetryPoint);
  }
  return out;
}

/** 100 Hz の G センサー。時計が offsetMs 遅れ、坂の分 0.05 G ずれている。vib: 20 Hz の振動、wobble: 5 Hz の揺れ (G) */
function imu(offsetMs: number, vib = 0, wobble = 0): ImuTrack {
  const n = 100 * 62;
  const t = new Float64Array(n), long = new Float32Array(n), lat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sec = i / 100 - 1;
    t[i] = START + sec * 1000 + offsetMs;
    const shake = vib * Math.sin(2 * Math.PI * 20 * sec) + wobble * Math.sin(2 * Math.PI * 5 * sec);
    long[i] = trueLong(sec) + 0.05 + shake;
    lat[i] = trueLat(sec) + shake;
  }
  return { t, long, lat };
}

describe('iPhone の G センサーの G を合わせる', () => {
  it('csv を読む', () => {
    const tr = parseImuCsv('time_utc_ms,g_long,g_lat,g_vert\n' + Array.from({ length: 30 }, (_, i) => `${1000 + i * 10},0.1,0.2,1`).join('\n'));
    expect(tr?.t.length).toBe(30);
    expect(parseImuCsv('a,b\n1,2')).toBeNull();
  });

  it('時計のずれを見つける', () => {
    const p = points();
    const off = alignImu(p, imu(300), START);
    expect(Math.abs(off - 300)).toBeLessThanOrEqual(40);
  });

  it('合わせた G は、ブレーキの踏み始めがはっきり出て、坂のずれは残らない', () => {
    const p = points();
    const err = (pts: TelemetryPoint[]) => pts.reduce((s, q) => s + Math.abs(q.accelG - trueLong(q.time)), 0) / pts.length;
    const before = err(p);
    fuseImuG(p, imu(300), START, 300);
    const after = err(p.slice(40, -40));
    expect(after).toBeLessThan(before / 2);
    // 一定の加速の所で、坂の分 (0.05) が残っていない
    const steady = p.filter(q => q.time % 4 > 0.8 && q.time % 4 < 1.2);
    const mean = steady.reduce((s, q) => s + q.accelG, 0) / steady.length;
    expect(Math.abs(mean - 0.3)).toBeLessThan(0.04);
  });

  it('20 Hz の振動は落とし、ブレーキの踏み始めは鈍らせない (なめらかの設定でフィルターを替える)', () => {
    const rough = (pts: TelemetryPoint[]) => Math.sqrt(pts.slice(41, -40).reduce((s, q, i, a) => i ? s + (q.accelG - a[i - 1].accelG) ** 2 : s, 0) / (pts.length - 81));
    const clean = fuseImuG(points(), imu(0), START, 0, 'standard');
    const shaky = fuseImuG(points(), imu(0, 0.3), START, 0, 'standard');
    // 0.3 G の振動を足しても、ざらつきはほとんど増えない
    expect(rough(shaky)).toBeLessThan(rough(clean) * 1.3 + 0.01);
    // ブレーキ (−0.9 G) の 0.15 秒後には、半分以上まで落ちている
    const at = (pts: TelemetryPoint[], t: number) => pts.find(q => Math.abs(q.time - t) < 1e-6)!.accelG;
    expect(at(shaky, 10.15)).toBeLessThan(-0.45);
    // 強いほど、なめらか
    const strong = fuseImuG(points(), imu(0, 0.3), START, 0, 'strong');
    const weak = fuseImuG(points(), imu(0, 0.3), START, 0, 'weak');
    expect(rough(strong)).toBeLessThanOrEqual(rough(weak));
  });

  it('フィルターは遅れを出さない (前後から 1 回ずつ)', () => {
    const tr = imu(0);
    const f = lowPassTrack(tr, 2.5);
    // ブレーキの始まり (10 秒) の前後で、−0.3 G を切る時刻がずれていない
    const cross = (v: Float32Array) => { for (let i = 1050; i < 1150; i++) if (v[i] < -0.3) return tr.t[i]; return NaN; };
    expect(Math.abs(cross(f.long) - cross(tr.long))).toBeLessThanOrEqual(40);
  });

  it('端末が揺れていた (3〜8 Hz) ことを見つける', () => {
    const p = points();
    expect(imuWobbleG(p, imu(0), START, 0)!).toBeLessThan(WOBBLE_LIMIT_G);
    expect(imuWobbleG(p, imu(0, 0.3), START, 0)!).toBeLessThan(WOBBLE_LIMIT_G);
    expect(imuWobbleG(p, imu(0, 0, 0.2), START, 0)!).toBeGreaterThan(WOBBLE_LIMIT_G);
  });
});
