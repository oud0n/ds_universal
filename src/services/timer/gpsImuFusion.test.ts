import { describe, expect, it } from 'vitest';
import { GpsImuFusion } from './gpsImuFusion';
import type { LiveFix } from '../liveLapTimer';

const G = 9.80665;
const LAT0 = 35.394, LON0 = 140.088, COS = Math.cos((LAT0 * Math.PI) / 180);
const ll = (x: number, y: number) => ({ latitude: LAT0 + y / 111320, longitude: LON0 + x / (COS * 111320) });

/** 本当の走り: 北へ 10 秒まっすぐ (30 m/s)、半径 80 m で左へ 10 秒、0.8 G で 2 秒ブレーキ。1 ms ごとの状態 */
function truth() {
  const out: Array<{ t: number; x: number; y: number; v: number; along: number; yaw: number }> = [];
  let x = 0, y = 0, v = 30, psi = 0;
  for (let ms = 0; ms <= 22000; ms++) {
    const t = ms / 1000;
    const turning = t >= 10 && t < 20;
    const along = t >= 20 ? -0.8 * G : 0;
    const yaw = turning ? v / 80 : 0; // 左回り (rad/s)
    out.push({ t, x, y, v, along, yaw });
    v = Math.max(0, v + along * 0.001);
    psi -= yaw * 0.001;
    x += v * Math.sin(psi) * 0.001;
    y += v * Math.cos(psi) * 0.001;
  }
  return out;
}

describe('iPhone の GPS の間を G センサーで埋める', () => {
  it('10 Hz の測位が、本当の走りから 3 m 以内 (GPS は 1 Hz・0.6 秒遅れ・揺れあり、iPhone の前は 10 度ずれ)', () => {
    const tr = truth();
    const out: LiveFix[] = [];
    const f = new GpsImuFusion(x => out.push(x));
    const mount = (10 * Math.PI) / 180;
    const t0 = Date.UTC(2026, 9, 25);
    const pendingGps: Array<{ at: number; fix: LiveFix & { course?: number } }> = [];
    for (let ms = 0; ms <= 22000; ms += 20) {
      const s = tr[ms];
      // 1 秒ごとの GPS (0.6 秒あとに届く)
      if (ms % 1000 === 0) {
        const noise = 2 * Math.sin(ms * 0.37);
        pendingGps.push({ at: ms + 600, fix: { tMs: t0 + ms, ...ll(s.x + noise, s.y - noise), speedKmh: s.v * 3.6, valid: true } });
      }
      while (pendingGps.length && pendingGps[0].at <= ms) f.gps(pendingGps.shift()!.fix);
      // G センサー (50 Hz): 車の前後・左右の G を、iPhone の向き (10 度ずれ) で測ったもの + 少しのずれ
      const along = s.along / G + 0.02;
      const alat = -(s.v * s.v * (s.yaw ? 1 / 80 : 0)) / G; // 左へ曲がると左向き (−)
      const long = along * Math.cos(mount) - alat * Math.sin(mount);
      const lat = along * Math.sin(mount) + alat * Math.cos(mount);
      f.imu(t0 + ms, long, lat, (s.yaw * 180) / Math.PI + 0.3);
    }
    const fused = out.filter(o => o.tMs - t0 > 2000);
    expect(fused.length).toBeGreaterThan(150);
    let sq = 0;
    for (const o of fused) {
      const s = tr[Math.round(o.tMs - t0)];
      const p = ll(s.x, s.y);
      const dy = (o.latitude - p.latitude) * 111320, dx = (o.longitude - p.longitude) * COS * 111320;
      sq += dx * dx + dy * dy;
    }
    expect(Math.sqrt(sq / fused.length)).toBeLessThan(3);
  });

  it('GPS が途切れたら、推定を出し続けない', () => {
    const out: LiveFix[] = [];
    const f = new GpsImuFusion(x => out.push(x));
    const t0 = 1_000_000;
    f.gps({ tMs: t0, latitude: LAT0, longitude: LON0, speedKmh: 100, valid: true, course: 0 });
    for (let ms = 20; ms <= 6000; ms += 20) f.imu(t0 + ms, 0, 0, 0);
    expect(out.every(o => o.tMs - t0 <= 3000)).toBe(true);
  });

  it('GPS が長く途切れたあとは、ずれた推定に寄せず GPS からやり直す', () => {
    const out: LiveFix[] = [];
    const f = new GpsImuFusion(x => out.push(x));
    const t0 = 2_000_000;
    f.gps({ tMs: t0, latitude: LAT0, longitude: LON0, speedKmh: 72, valid: true, course: 0 });
    // 途切れている間、G センサーは前へ 0.3 G と言い続ける (推定はどんどん前へずれる)
    for (let ms = 20; ms <= 8000; ms += 20) f.imu(t0 + ms, 0.3, 0, 0);
    // 8 秒後に戻った GPS は、最初の所から 50 m 東
    const back = ll(50, 0);
    f.gps({ tMs: t0 + 8000, ...back, speedKmh: 72, valid: true, course: 90 });
    out.length = 0;
    f.imu(t0 + 8020, 0, 0, 0);
    f.imu(t0 + 8120, 0, 0, 0);
    const first = out[0];
    expect(first).toBeDefined();
    const dx = (first.longitude - back.longitude) * COS * 111320, dy = (first.latitude - back.latitude) * 111320;
    expect(Math.hypot(dx, dy)).toBeLessThan(5);
  });
});
