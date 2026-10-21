/**
 * iPhone の G センサーを、ラップタイマーの走行と同じ名前の .csv に書く (2026-10-21)。
 * ファイルは <走行のファイルの名前>.iphone_imu.csv。列は time_utc_ms, g_long, g_lat, g_vert, yaw_dps, ax, ay, az。
 *
 * 車の向きへの読み替え: 測定開始のあとの最初の 0.5 秒の重力の向きを「下」にし、iPhone の背面の向き (ホルダーで画面が運転者を向いて
 * いれば車の前) を水平に直したものを「前」にする。iPhone を平らに置いていて背面が下を向くときは、iPhone の上 (縦向きの上端) を前にする。
 * - g_long: 前へ加速が +、ブレーキが − (G)
 * - g_lat: 右へ曲がる (右向きの加速) が + (G)
 * - g_vert: 上向きが + (G)
 * - yaw_dps: 上から見て左回り (左へ曲がる) が + (度/秒)
 * - ax, ay, az: 読み替える前の、iPhone の向きのままの加速度 (G。動いた向きが +)。基準を変えて計算し直すため
 */

import { callNative, hasNative, onNative } from '../native/bridge';
import type { MotionBatch } from '../native/contract';
import { SensorCsvRecorder } from './sensorCsvRecorder';

type Vec = [number, number, number];

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec): Vec | null => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-6 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];

/** 車の向き (iPhone の座標で表した、上・前・右の単位ベクトル) */
export interface CarFrame {
  up: Vec;
  forward: Vec;
  right: Vec;
}

/**
 * 重力の向き (iPhone の座標。CoreMotion の gravity は下を向く) から、車の向きを決める。
 * 前は iPhone の背面 (−Z) を水平に直したもの。背面がほぼ上下を向くときは iPhone の上 (+Y)
 */
export function carFrameFromGravity(gravity: Vec): CarFrame | null {
  const up = norm(scale(gravity, -1));
  if (!up) return null;
  const horizontal = (v: Vec) => norm(sub(v, scale(up, dot(v, up))));
  const back: Vec = [0, 0, -1];
  const forward = Math.abs(dot(back, up)) < 0.9 ? horizontal(back) : horizontal([0, 1, 0]);
  if (!forward) return null;
  // 右 = 前 × 上 (前が北・上が上なら東)
  const right = cross(forward, up);
  return { up, forward, right };
}

/** iPhone の向きのままの加速度 (動いた向きが +) を、車の向きに読み替える */
export function toCar(frame: CarFrame, a: Vec): { long: number; lat: number; vert: number } {
  return { long: dot(a, frame.forward), lat: dot(a, frame.right), vert: dot(a, frame.up) };
}

const COLUMNS = ['g_long', 'g_lat', 'g_vert', 'yaw_dps', 'ax', 'ay', 'az'];
/** 基準の傾きを決めるのに使う、測り始めの長さ (ミリ秒) */
const BASELINE_MS = 500;

/**
 * 測っている間、G センサーを読んで .csv に書く。iPhone のアプリだけ (前のアプリ・ブラウザでは何もしない)。
 * runBase は今の走行のファイルの名前 (拡張子なし)。まだ無ければ null で、その間の値は書かない
 */
export class PhoneImuRecorder {
  private off: (() => void) | null = null;
  private frame: CarFrame | null = null;
  private baseline: { t0: number; sum: Vec; n: number } | null = null;
  private recorders = new Map<string, SensorCsvRecorder>();
  private running = false;

  constructor(private readonly runBase: () => string | null) {}

  async start(): Promise<void> {
    if (this.running || !hasNative()) return;
    this.running = true;
    this.frame = null;
    this.baseline = null;
    this.off = onNative('system.motion', b => this.onBatch(b));
    try {
      await callNative('system.motionStart', { hz: 50 });
    } catch {
      // 前のアプリ (G センサーを読めない) では記録しない
      this.off?.();
      this.off = null;
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await callNative('system.motionStop', {}).catch(() => {});
    this.off?.();
    this.off = null;
    await this.flush();
    this.recorders.clear();
  }

  /** ためた行を書く (ラップタイマーの保存と一緒に) */
  flush(): Promise<void> {
    return Promise.all([...this.recorders.values()].map(r => r.flush())).then(() => {});
  }

  /** 走行が替わった (周を数え直した): 次の値から新しいファイルに書く。基準の傾きはそのまま */
  newRun(): void {
    void this.flush();
    this.recorders.clear();
  }

  private onBatch(b: MotionBatch): void {
    for (let i = 0; i < b.t.length; i++) {
      const g: Vec = [b.gx[i], b.gy[i], b.gz[i]];
      if (!this.frame) {
        // 測り始めの 0.5 秒の重力の向きを平均して、基準にする
        this.baseline ??= { t0: b.t[i], sum: [0, 0, 0], n: 0 };
        this.baseline.sum = [this.baseline.sum[0] + g[0], this.baseline.sum[1] + g[1], this.baseline.sum[2] + g[2]];
        this.baseline.n++;
        if (b.t[i] - this.baseline.t0 < BASELINE_MS) continue;
        this.frame = carFrameFromGravity(scale(this.baseline.sum, 1 / this.baseline.n));
        if (!this.frame) { this.baseline = null; continue; }
      }
      // CoreMotion の userAcceleration は、動いた向きと逆の符号 (重力 + 加速度 = センサーの値、の分け方のため)。動いた向きを + にする
      const a: Vec = [-b.ux[i], -b.uy[i], -b.uz[i]];
      const car = toCar(this.frame, a);
      const yawDps = dot([b.rx[i], b.ry[i], b.rz[i]], this.frame.up) * 180 / Math.PI;
      this.record(b.t[i], { g_long: car.long, g_lat: car.lat, g_vert: car.vert, yaw_dps: yawDps, ax: a[0], ay: a[1], az: a[2] });
    }
  }

  private record(tMs: number, values: Record<string, number>): void {
    const base = this.runBase();
    if (!base) return;
    let rec = this.recorders.get(base);
    if (!rec) {
      rec = new SensorCsvRecorder(base, 'iphone_imu', COLUMNS);
      this.recorders.set(base, rec);
    }
    rec.add(tMs, values);
  }
}
