/**
 * iPhone の GPS (1 秒に 1 回くらい) の間を、G センサー (加減速 G・回転の速さ) で埋めて、10 Hz の測位にする (2026-10-25)。
 * ラップタイマーで、計測線を越えた時刻を細かく出すため (iPhone の GPS だけで測るとき)。
 *
 * - G センサーの値が来るたびに、加減速 G で速さを、回転の速さで向きを変え、その速さと向きで位置を進める
 * - GPS が来たら、その GPS の時刻のときの推定と比べ、ずれの一部を今の推定に足して寄せる (GPS は届くまでに遅れるので、
 *   届いた時刻ではなく GPS の時刻で比べる)
 * - iPhone の「前」と車の前がずれていても使えるよう、GPS の速さの変わり方と G センサーの前後・左右の G の向きから、ずれの角度を覚える
 * - GPS が 3 秒来なければ、推定は出さない (ずれていくため)
 */
import type { LiveFix } from '../liveLapTimer';

const G = 9.80665;
const M_PER_DEG = 111320;
const HISTORY_MS = 4000;
const GPS_TIMEOUT_MS = 3000;
/** GPS とのずれのうち、今の推定に足す割合 (位置・速さ・向き) */
const K_POS = 0.6;
const K_SPEED = 0.5;
const K_HEADING = 0.4;

export interface FusionGpsFix extends LiveFix {
  /** 進む向き (度、北から右回り)。止まっているときなどは無い */
  course?: number;
}

interface State { t: number; x: number; y: number; v: number; psi: number }

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class GpsImuFusion {
  private origin: { lat: number; lon: number; cos: number } | null = null;
  private s: State | null = null;
  private history: State[] = [];
  private lastGps: { t: number; v: number; x: number; y: number } | null = null;
  private lastOutT = -Infinity;
  /** 前回の GPS からの、G センサーの前後・左右の G の和と数 (前のずれを覚えるため) */
  private acc = { long: 0, lat: 0, n: 0 };
  private axis = { sl: 0, sr: 0 };
  private theta = 0;

  constructor(private readonly onFix: (f: LiveFix) => void, private readonly outHz = 10) {}

  private xy(lat: number, lon: number) {
    const o = this.origin!;
    return { x: (lon - o.lon) * o.cos * M_PER_DEG, y: (lat - o.lat) * M_PER_DEG };
  }

  private latLon(x: number, y: number) {
    const o = this.origin!;
    return { latitude: o.lat + y / M_PER_DEG, longitude: o.lon + x / (o.cos * M_PER_DEG) };
  }

  /** iPhone の前と車の前のずれ (ラジアン。覚えた値) */
  get axisAngle(): number {
    return this.theta;
  }

  gps(fix: FusionGpsFix): void {
    if (!fix.valid) { this.onFix(fix); return; }
    if (!this.origin) this.origin = { lat: fix.latitude, lon: fix.longitude, cos: Math.cos((fix.latitude * Math.PI) / 180) };
    // GPS が長く途切れたあと (推定はずれている) は、寄せずに GPS からやり直す (前は 6 割だけ寄せて、ずれたまま出していた)。向きは前のものを使う
    let keepPsi: number | null = null;
    if (this.s && this.lastGps && fix.tMs - this.lastGps.t > GPS_TIMEOUT_MS) {
      keepPsi = this.s.psi;
      this.s = null;
      this.history = [];
      this.lastGps = null;
      this.acc = { long: 0, lat: 0, n: 0 };
    }
    const p = this.xy(fix.latitude, fix.longitude);
    const v = fix.speedKmh / 3.6;
    const course = fix.course !== undefined && Number.isFinite(fix.course) && v > 3 ? (fix.course * Math.PI) / 180 : null;
    // 前のずれを覚える: GPS の速さの変わり方と、その間の G センサーの前後・左右の G の平均
    if (this.lastGps && this.acc.n > 5 && fix.tMs > this.lastGps.t) {
      const gpsAcc = (v - this.lastGps.v) / ((fix.tMs - this.lastGps.t) / 1000) / G;
      if (Math.abs(gpsAcc) > 0.08 && v > 3) {
        this.axis.sl += gpsAcc * (this.acc.long / this.acc.n);
        this.axis.sr += gpsAcc * (this.acc.lat / this.acc.n);
        this.updateTheta();
      }
    }
    // GPS から求めた向き (向きが来ないとき)
    const derived = this.lastGps && v > 3 && Math.hypot(p.x - this.lastGps.x, p.y - this.lastGps.y) > 2 ? Math.atan2(p.x - this.lastGps.x, p.y - this.lastGps.y) : null;
    const heading = course ?? derived;
    // 2 つの GPS の位置から求めた向きは、その間の真ん中の時刻の向き。比べる推定もその時刻のもの
    const headingT = course !== null ? fix.tMs : this.lastGps ? (this.lastGps.t + fix.tMs) / 2 : fix.tMs;
    this.lastGps = { t: fix.tMs, v, x: p.x, y: p.y };
    this.acc = { long: 0, lat: 0, n: 0 };
    if (!this.s) {
      this.s = { t: fix.tMs, x: p.x, y: p.y, v, psi: heading ?? keepPsi ?? 0 };
      this.history = [{ ...this.s }];
      this.onFix(fix);
      this.lastOutT = fix.tMs;
      return;
    }
    // GPS の時刻のときの推定 (G センサーの値がまだその時刻まで来ていなければ、今の推定)
    const then = this.history.reduce<State | null>((best, h) => (h.t <= fix.tMs && (!best || h.t > best.t) ? h : best), null) ?? this.s;
    const ex = p.x - then.x, ey = p.y - then.y, ev = v - then.v;
    const s = this.s;
    // G センサーが来ていない (GPS より古い) ときは、GPS に合わせる
    if (s.t <= fix.tMs) {
      this.s = { t: fix.tMs, x: p.x, y: p.y, v, psi: heading ?? s.psi };
      this.history = [{ ...this.s }];
      this.onFix(fix);
      this.lastOutT = fix.tMs;
      return;
    }
    s.x += K_POS * ex;
    s.y += K_POS * ey;
    s.v = Math.max(0, s.v + K_SPEED * ev);
    if (heading !== null) {
      const at = this.history.reduce<State | null>((best, h) => (h.t <= headingT && (!best || h.t > best.t) ? h : best), null) ?? then;
      s.psi = wrap(s.psi + K_HEADING * wrap(heading - at.psi));
    }
  }

  private updateTheta(): void {
    if (Math.hypot(this.axis.sl, this.axis.sr) > 0.05) this.theta = Math.atan2(this.axis.sr, this.axis.sl);
  }

  /** G センサーの値 (UTC ミリ秒・車の向きに直した前後 G・左右 G・上から見て左回りが + の回転の速さ (度/秒)) */
  imu(tMs: number, longG: number, latG: number, yawDps: number): void {
    this.acc.long += longG;
    this.acc.lat += latG;
    this.acc.n++;
    const s = this.s;
    if (!s || !this.lastGps) return;
    // 曲がっている間は、回転の速さと速さから出る横向きの G (右が +) と、測った G の向きを比べて、前のずれを覚える
    const expLat = -(s.v * (yawDps * Math.PI) / 180) / G;
    if (Math.abs(expLat) > 0.25 && s.v > 5) {
      const w = 0.02;
      this.axis.sl += w * expLat * latG;
      this.axis.sr += w * -expLat * longG;
      this.updateTheta();
    }
    const dt = (tMs - s.t) / 1000;
    if (dt <= 0) return;
    if (dt > 0.2) { s.t = tMs; return; }
    // 覚えたずれの分だけ回して、車の前後の G にする
    const a = (longG * Math.cos(this.theta) + latG * Math.sin(this.theta)) * G;
    s.v = Math.max(0, s.v + a * dt);
    // 左回り (+) は、北から右回りの向きを減らす
    s.psi = wrap(s.psi - (yawDps * Math.PI) / 180 * dt);
    s.x += s.v * Math.sin(s.psi) * dt;
    s.y += s.v * Math.cos(s.psi) * dt;
    s.t = tMs;
    this.history.push({ ...s });
    while (this.history.length && this.history[0].t < tMs - HISTORY_MS) this.history.shift();
    if (tMs - this.lastGps.t > GPS_TIMEOUT_MS) return;
    if (tMs - this.lastOutT >= 1000 / this.outHz - 1) {
      this.lastOutT = tMs;
      this.onFix({ tMs, ...this.latLon(s.x, s.y), speedKmh: s.v * 3.6, valid: true });
    }
  }
}
