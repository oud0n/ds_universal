import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackController, type PlaybackTarget } from './playbackController';

/**
 * <video> の代わりに、ブラウザごとの動き方を時刻で再現する偽物。
 * 数字は、Chrome・Safari で測った値 (2026-10-20、_private のメモ) に合わせてある:
 * - 再生を始めてから動き出すまで (startLagMs): Chrome 0.23 秒、Safari の音のある動画 0.46 秒
 * - 移動 (currentTime を変える) してから seeked まで (seekedAfterMs) と、動き出すまで (resumeAfterMs):
 *   Safari の音のある動画は seeked が 0.15〜0.4 秒、動き出すのは 0.5〜0.7 秒。音を消すと 0.04 秒・0.07 秒
 * - Safari は、seeked のすぐあとに飛んだ先のコマを 1 枚出してから、しばらく止まることがある (previewFrame)
 * - Safari の音のある動画は、速さを変えると映像が止まる (rateChangeStallMs)
 */
interface Model {
  startLagMs: number;
  seekedAfterMs: number;
  resumeAfterMs: number;
  previewFrame: boolean;
  rateChangeStallMs: number;
}

const CHROME: Model = { startLagMs: 230, seekedAfterMs: 40, resumeAfterMs: 70, previewFrame: false, rateChangeStallMs: 0 };
const SAFARI_AUDIBLE: Model = { startLagMs: 460, seekedAfterMs: 200, resumeAfterMs: 600, previewFrame: false, rateChangeStallMs: 300 };
const SAFARI_MUTED: Model = { startLagMs: 80, seekedAfterMs: 40, resumeAfterMs: 70, previewFrame: false, rateChangeStallMs: 0 };

const FRAME_MS = 1000 / 60;

class Clock {
  now = 1000;
}

type FrameCb = (now: number, meta: { mediaTime: number; expectedDisplayTime?: number }) => void;

class FakeVideo {
  mediaTime = 0;
  paused = true;
  muted: boolean;
  seeking = false;
  duration: number;
  readyState = 4;
  src = 'blob:video';
  currentSrc = 'blob:video';
  seeks = 0;
  rateChanges = 0;
  private rate = 1;
  private stalledUntil = 0;
  private pending: { target: number; seekedAt: number; resumeAt: number } | null = null;
  private listeners = new Map<string, Set<() => void>>();
  private frameCbs = new Map<number, FrameCb>();
  private nextHandle = 1;
  private lastFrameAt = -Infinity;
  private lastPresented = NaN;

  constructor(private clock: Clock, private model: Model, opts: { muted?: boolean; duration?: number } = {}) {
    this.muted = opts.muted ?? false;
    this.duration = opts.duration ?? 1000;
  }

  get currentTime(): number { return this.mediaTime; }
  set currentTime(v: number) {
    this.seeks++;
    this.seeking = true;
    const now = this.clock.now;
    this.pending = { target: Math.min(v, this.duration), seekedAt: now + this.model.seekedAfterMs, resumeAt: now + this.model.resumeAfterMs };
    this.emit('seeking');
  }

  get playbackRate(): number { return this.rate; }
  set playbackRate(v: number) {
    if (v === this.rate) return;
    this.rate = v;
    this.rateChanges++;
    if (this.model.rateChangeStallMs > 0) this.stalledUntil = Math.max(this.stalledUntil, this.clock.now + this.model.rateChangeStallMs);
  }

  play(): Promise<void> {
    if (this.paused) {
      this.paused = false;
      this.stalledUntil = Math.max(this.stalledUntil, this.clock.now + this.model.startLagMs);
    }
    return Promise.resolve();
  }

  pause(): void { this.paused = true; }

  addEventListener(name: string, fn: () => void): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }

  removeEventListener(name: string, fn: () => void): void { this.listeners.get(name)?.delete(fn); }

  requestVideoFrameCallback(cb: FrameCb): number {
    const h = this.nextHandle++;
    this.frameCbs.set(h, cb);
    return h;
  }

  cancelVideoFrameCallback(h: number): void { this.frameCbs.delete(h); }

  private emit(name: string): void { this.listeners.get(name)?.forEach(fn => fn()); }

  private present(): void {
    this.lastFrameAt = this.clock.now;
    this.lastPresented = this.mediaTime;
    const cbs = [...this.frameCbs.values()];
    this.frameCbs.clear();
    cbs.forEach(cb => cb(this.clock.now, { mediaTime: this.mediaTime, expectedDisplayTime: this.clock.now }));
  }

  /** dt ミリ秒進める */
  step(dt: number): void {
    const now = this.clock.now;
    if (this.pending && this.seeking && now >= this.pending.seekedAt) {
      this.mediaTime = this.pending.target;
      this.seeking = false;
      this.stalledUntil = Math.max(this.stalledUntil, this.pending.resumeAt);
      this.pending = null;
      this.emit('seeked');
      if (this.model.previewFrame) this.present();
    }
    const moving = !this.paused && !this.seeking && now >= this.stalledUntil;
    if (moving) this.mediaTime = Math.min(this.duration, this.mediaTime + (dt / 1000) * this.rate);
    // 新しいコマが出たときだけ知らせる (止まっている間は知らせない)
    if (now - this.lastFrameAt >= FRAME_MS - 0.01 && this.mediaTime !== this.lastPresented && !this.seeking) this.present();
  }
}

/** App の時計と偽物の動画を、1/60 秒ずつ進める */
class Sim {
  clock = new Clock();
  video: FakeVideo;
  controller: PlaybackController;
  appTime = 100;
  playing = false;
  rate: number | undefined;
  durationSec = 1000;
  /** 進めた時刻ごとの、App の位置と動画の位置のずれ (秒。正なら動画が遅れている) */
  log: Array<{ t: number; diff: number }> = [];

  /** App の時計を、音を出している動画に付いていかせる (App.tsx のループと同じ。clockMaster.ts) */
  masterClock = false;
  /** App のループが最後に入れた時刻 (外で動かしたかを見分ける。App.tsx と同じ) */
  private loopTime: number | null = null;

  /** false なら、時計の元にしない枠 (走行比較の Car 2〜4) */
  clockEligible: boolean;

  constructor(model: Model, opts: { adjustAudibleRate: boolean; muted?: boolean; duration?: number; masterClock?: boolean; clockEligible?: boolean }) {
    this.masterClock = opts.masterClock ?? false;
    this.clockEligible = opts.clockEligible ?? true;
    vi.spyOn(performance, 'now').mockImplementation(() => this.clock.now);
    this.video = new FakeVideo(this.clock, model, { muted: opts.muted, duration: opts.duration });
    this.controller = new PlaybackController(opts.adjustAudibleRate);
    this.controller.attach('main', this.video as unknown as HTMLVideoElement);
    // 止めたまま、App の位置に合わせておく
    this.tick(0);
    this.run(500);
  }

  private tick(dt: number): void {
    this.clock.now += dt;
    this.video.step(dt);
    if (this.playing) {
      const next = this.appTime + (dt / 1000) * (this.rate ?? 1);
      const m = this.masterClock ? this.controller.masterAppTime() : null;
      const movedOutside = this.loopTime !== null && Math.abs(this.appTime - this.loopTime) > 1e-6;
      this.appTime = m !== null && !movedOutside && Math.abs(m - next) < 1 ? Math.max(this.appTime, m) : next;
      this.loopTime = this.appTime;
    }
    const t: PlaybackTarget = { localTime: this.appTime, durationSec: this.durationSec, outOfRange: false, ...(this.rate !== undefined ? { rate: this.rate } : {}), ...(this.clockEligible ? {} : { clockEligible: false }) };
    this.controller.sync(new Map([['main', t]]), this.playing, 1, this.masterClock ? this.appTime : undefined);
    this.log.push({ t: this.clock.now, diff: this.appTime - this.video.mediaTime });
  }

  run(ms: number): void {
    const steps = Math.round(ms / FRAME_MS);
    for (let i = 0; i < steps; i++) this.tick(FRAME_MS);
  }

  /** 合わせる処理を呼ばずに、時間だけ進める (止めたあとの App は描き直さないので、sync が呼ばれない) */
  idle(ms: number): void {
    const steps = Math.round(ms / FRAME_MS);
    for (let i = 0; i < steps; i++) { this.clock.now += FRAME_MS; this.video.step(FRAME_MS); }
  }

  play(): void { this.playing = true; }
  pause(): void { this.playing = false; }

  /** 最後の ms ミリ秒のずれの絶対値の最大 */
  maxDiffOverLast(ms: number): number {
    const from = this.clock.now - ms;
    return Math.max(...this.log.filter(e => e.t >= from).map(e => Math.abs(e.diff)));
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlaybackController (音を出している動画を時計の元にする)', () => {
  it('Safari の音のある動画: 速さも位置も変えず、始めから終わりまで揃う (App が動画を待つ)', () => {
    const sim = new Sim(SAFARI_AUDIBLE, { adjustAudibleRate: false, masterClock: true });
    const seeksBefore = sim.video.seeks;
    sim.play();
    sim.run(12000);
    expect(sim.video.rateChanges).toBe(0);
    expect(sim.video.seeks).toBe(seeksBefore);
    // App は動画に付いていくので、ずれは 1 コマ分ほど
    expect(sim.maxDiffOverLast(12000)).toBeLessThan(0.05);
    // 動画が動き出すまで (0.46 秒) は待つので、App の時刻はその分遅れて進む
    expect(sim.appTime).toBeGreaterThan(100 + 11.4);
    expect(sim.appTime).toBeLessThan(100 + 11.6);
  });

  it('見ている位置を動かしたら、動画が飛び、動き出すまで App が待つ', () => {
    const sim = new Sim(SAFARI_AUDIBLE, { adjustAudibleRate: false, masterClock: true });
    sim.play();
    sim.run(3000);
    const seeksBefore = sim.video.seeks;
    sim.appTime += 20;
    sim.run(3000);
    expect(sim.video.seeks - seeksBefore).toBe(1);
    expect(sim.maxDiffOverLast(1500)).toBeLessThan(0.05);
  });

  it('再生中に少しだけ戻しても (0.3 秒)、動画の位置に引き戻されず、動画がその位置へ飛ぶ', () => {
    const sim = new Sim(SAFARI_AUDIBLE, { adjustAudibleRate: false, masterClock: true });
    sim.play();
    sim.run(3000);
    const seeksBefore = sim.video.seeks;
    const target = sim.appTime - 0.3;
    sim.appTime = target;
    sim.run(2000);
    expect(sim.video.seeks - seeksBefore).toBe(1);
    // 戻した位置から進んでいる (引き戻されていれば、target + 2 秒より 0.3 秒先にいる)
    expect(sim.appTime).toBeLessThan(target + 2.05);
    expect(sim.maxDiffOverLast(1000)).toBeLessThan(0.05);
  });

  it('動画が動かないとき (再生できない) は、2 秒で時計の元をやめ、App の時計で進む', () => {
    const sim = new Sim({ ...SAFARI_AUDIBLE, startLagMs: 60000 }, { adjustAudibleRate: false, masterClock: true });
    sim.play();
    sim.run(5000);
    expect(sim.appTime).toBeGreaterThan(100 + 2.5);
  });

  it('時計の元にしない枠 (走行比較の Car 2〜4) は、音を出していても App の時計に合わせる', () => {
    const sim = new Sim(SAFARI_AUDIBLE, { adjustAudibleRate: false, masterClock: true, clockEligible: false });
    sim.play();
    sim.run(6000);
    // App は動画を待たずに進む (時計の元なら、動き出すまでの 0.46 秒だけ遅れる)
    expect(sim.appTime).toBeCloseTo(106, 1);
  });

  it('音を消した動画は時計の元にしない (これまでどおり App の時計に合わせる)', () => {
    const sim = new Sim(SAFARI_MUTED, { adjustAudibleRate: false, muted: true, masterClock: true });
    sim.play();
    sim.run(6000);
    expect(sim.appTime).toBeCloseTo(106, 1);
    expect(sim.maxDiffOverLast(2000)).toBeLessThan(0.05);
  });
});

describe('PlaybackController', () => {
  it('Chrome: 再生を始めた直後の出遅れを、飛ばずに速さで詰める', () => {
    const sim = new Sim(CHROME, { adjustAudibleRate: true });
    const seeksBefore = sim.video.seeks;
    sim.play();
    sim.run(6000);
    expect(sim.maxDiffOverLast(2000)).toBeLessThan(0.05);
    expect(sim.video.seeks - seeksBefore).toBeLessThanOrEqual(1);
  });

  it('Safari の音のある動画: 速さを変えずに、数回飛んで揃い、そのあと飛ばない', () => {
    const sim = new Sim(SAFARI_AUDIBLE, { adjustAudibleRate: false });
    const seeksBefore = sim.video.seeks;
    sim.play();
    sim.run(4000);
    expect(sim.video.rateChanges).toBe(0);
    expect(sim.video.seeks - seeksBefore).toBeLessThanOrEqual(3);
    const seeksAt4s = sim.video.seeks;
    sim.run(8000);
    expect(sim.video.seeks).toBe(seeksAt4s);
    expect(sim.maxDiffOverLast(8000)).toBeLessThan(0.2);
  });

  it('Safari の音のある動画: seeked のすぐあとにコマを 1 枚出して止まっても、飛び直しを繰り返さない', () => {
    const sim = new Sim({ ...SAFARI_AUDIBLE, previewFrame: true }, { adjustAudibleRate: false });
    const seeksBefore = sim.video.seeks;
    sim.play();
    sim.run(4000);
    expect(sim.video.seeks - seeksBefore).toBeLessThanOrEqual(3);
    sim.run(8000);
    expect(sim.maxDiffOverLast(8000)).toBeLessThan(0.2);
  });

  it('Safari の音を消した動画: 速さで詰めてよい', () => {
    const sim = new Sim(SAFARI_MUTED, { adjustAudibleRate: false, muted: true });
    sim.play();
    sim.run(6000);
    expect(sim.maxDiffOverLast(2000)).toBeLessThan(0.05);
  });

  it('再生中に見ている位置を大きく動かしたら、飛んでいる途中でもすぐ付いていく', () => {
    const sim = new Sim(SAFARI_AUDIBLE, { adjustAudibleRate: false });
    sim.play();
    // 始めの出遅れで飛んだ直後 (まだ動き出していない) に、20 秒先へ動かす
    sim.run(300);
    sim.appTime += 20;
    sim.run(1500);
    expect(Math.abs(sim.appTime - sim.video.mediaTime)).toBeLessThan(0.5);
  });

  it('止めているときは、コマ送り (0.1 秒) にも細かく合わせる', () => {
    const sim = new Sim(CHROME, { adjustAudibleRate: true });
    sim.appTime += 0.1;
    sim.run(200);
    expect(sim.video.paused).toBe(true);
    expect(Math.abs(sim.appTime - sim.video.mediaTime)).toBeLessThan(0.021);
  });

  it('止めたら、動画も止まる', () => {
    const sim = new Sim(CHROME, { adjustAudibleRate: true });
    sim.play();
    sim.run(2000);
    sim.pause();
    sim.run(300);
    expect(sim.video.paused).toBe(true);
    expect(Math.abs(sim.appTime - sim.video.mediaTime)).toBeLessThan(0.021);
  });

  it('飛んでいる途中で止めても、飛び終わったら動画が止まる (止めたあとは sync が呼ばれない。2026-10-20 iPhone で見つけた)', () => {
    const sim = new Sim(SAFARI_AUDIBLE, { adjustAudibleRate: false });
    sim.play();
    sim.run(3000);
    // 見ている位置を動かし、飛んでいる途中 (seeking) で止める
    sim.appTime += 20;
    sim.run(50);
    expect(sim.video.seeking).toBe(true);
    sim.pause();
    sim.run(FRAME_MS);
    // 止めたあとは App が描き直さないので、合わせる処理は呼ばれない
    sim.idle(3000);
    expect(sim.video.paused).toBe(true);
  });

  it('動画の終わりを過ぎても、飛び直しを繰り返さない', () => {
    const sim = new Sim(SAFARI_AUDIBLE, { adjustAudibleRate: false, duration: 105 });
    sim.durationSec = 105;
    sim.play();
    sim.run(4000);
    const seeksBeforeEnd = sim.video.seeks;
    sim.run(4000);
    expect(sim.video.seeks - seeksBeforeEnd).toBeLessThanOrEqual(2);
  });

  it('走行比較の枠 (倍率あり) も揃う', () => {
    const sim = new Sim(CHROME, { adjustAudibleRate: true, muted: true });
    sim.rate = 1.2;
    sim.play();
    sim.run(6000);
    expect(sim.maxDiffOverLast(2000)).toBeLessThan(0.05);
  });

  it('音を出す・消すを切り替えても、移動の時間の覚え方が混ざらない (Safari)', () => {
    const sim = new Sim(SAFARI_AUDIBLE, { adjustAudibleRate: false });
    sim.play();
    sim.run(4000);
    // 音を消すと、動き方が変わる (移動がすぐ終わる)
    sim.video.muted = true;
    (sim.video as unknown as { model: Model }).model = SAFARI_MUTED;
    sim.appTime += 2;
    sim.run(4000);
    expect(sim.maxDiffOverLast(2000)).toBeLessThan(0.05);
  });
});
