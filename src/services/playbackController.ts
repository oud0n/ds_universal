/**
 * 1 つの動画のウインドウの全部の <video> を、1 か所で App の時刻に合わせる。
 * 再生の基準は App の時刻だけで、動画はそれに付いていく。以前は動画の timeupdate (1 秒に 4 回ほど) で App の時刻を進めていたため、
 * ほかのウインドウの表示がカクつき (#11)、動画がないと時刻が進まなかった (#10)。
 *
 * 枠ごとに再生の速さの倍率 (rate) を持てる。走行比較では、遅い車の動画ほど速く回す (docs/video_sets_design.md の 6):
 * 速さ = 再生の速さ × rate (距離の対応の傾き) + ずれを詰める補正。ずれは実際に出たコマ (requestVideoFrameCallback) で測る。
 * ±16 ms の遊びを設け、速さは小刻みに変えない (Safari が引っかかるため)。速さが 0.25〜4 倍を外れるとき、
 * ずれが大きいときは、その位置へ飛ぶ
 */

export interface PlaybackTarget {
  /** 動画の中の位置 (秒)。撮影の範囲の外なら outOfRange */
  localTime: number;
  durationSec: number;
  outOfRange: boolean;
  /** 再生の速さの倍率 (既定 1)。走行比較の、距離の対応の傾き */
  rate?: number;
}

// ずれを詰め始める大きさと、詰め終える大きさ (行ったり来たりしないよう、間をあける)。
// 速さを変えるのは 0.5 秒に 1 回まで (速さを小刻みに変えると、iPhone の Safari では映像と音が引っかかる)
const CORRECT_START_SEC = 0.04;
const CORRECT_STOP_SEC = 0.015;
const RATE_CHANGE_INTERVAL_MS = 500;
const MIN_RATE = 0.25;
const MAX_RATE = 4;
/** これより大きくずれたら飛ぶ。倍率のある枠 (走行比較) は、速さの変わり目で外れやすいので小さめにする */
const JUMP_SEC = 0.5;
const JUMP_SEC_RATED = 0.25;

interface Entry {
  el: HTMLVideoElement;
  /** 最後に出たコマの、動画の中の時刻と、それを受け取った時刻 (performance.now) */
  frame: { mediaTime: number; at: number } | null;
  frameHandle: number | null;
  /** ずれを詰めているところか */
  correcting: boolean;
  /** 最後に速さを変えた時刻 (performance.now) */
  rateChangedAt: number;
  /** 合わせている動画のファイル。チャプターや .LRV で同じ <video> のファイルが替わったら、出たコマの記録と一度だけの再生をやり直す */
  src: string;
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

/**
 * 再生を始める。iPhone の Safari は、音の出る動画を、画面に触れた操作の中でしか再生させない (アプリの時刻で後から始めると断られる)。
 * 断られたら音を消して再生し直す (音のない動画は、操作がなくても再生できる)。音は、画面に触れたときに VideoTile が戻す
 */
function playSafely(el: HTMLVideoElement): void {
  el.play().catch((err: unknown) => {
    if ((err as { name?: string })?.name === 'NotAllowedError' && !el.muted) {
      el.muted = true;
      el.play().catch(() => {});
    }
  });
}

export class PlaybackController {
  private entries = new Map<string, Entry>();
  // 止めたまま最初のコマを出すために、一度だけ再生して止めた動画 (iPhone の Safari は、再生するまで動画を読み込まず、黒いまま)
  private primed = new WeakSet<HTMLVideoElement>();

  /** 枠の <video> を登録する (ref のコールバックから。null で外す) */
  attach(key: string, el: HTMLVideoElement | null): void {
    const old = this.entries.get(key);
    if (old && old.el === el) return;
    if (old) this.stopFrames(old);
    if (!el) { this.entries.delete(key); return; }
    const entry: Entry = { el, frame: null, frameHandle: null, correcting: false, rateChangedAt: 0, src: el.currentSrc || el.src };
    this.entries.set(key, entry);
    this.watchFrames(entry);
  }

  element(key: string): HTMLVideoElement | null {
    return this.entries.get(key)?.el ?? null;
  }

  pauseAll(): void {
    this.entries.forEach(({ el }) => { if (!el.paused) el.pause(); });
  }

  /** 枠ごとの位置に合わせる。targets にない枠は止める */
  sync(targets: Map<string, PlaybackTarget>, isPlaying: boolean, speed: number): void {
    this.entries.forEach((entry, key) => {
      const t = targets.get(key);
      if (!t || t.outOfRange) { if (!entry.el.paused) entry.el.pause(); return; }
      this.syncEntry(entry, t, isPlaying, speed);
    });
  }

  /** 出たコマの時刻を覚える (currentTime は出ているコマより先に進んでいることがあるため) */
  private watchFrames(entry: Entry): void {
    const v = entry.el as FrameVideo;
    if (!v.requestVideoFrameCallback) return;
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      entry.frame = { mediaTime: meta.mediaTime, at: performance.now() };
      entry.frameHandle = v.requestVideoFrameCallback!(onFrame);
    };
    entry.frameHandle = v.requestVideoFrameCallback(onFrame);
  }

  private stopFrames(entry: Entry): void {
    const v = entry.el as FrameVideo;
    if (entry.frameHandle !== null) v.cancelVideoFrameCallback?.(entry.frameHandle);
    entry.frameHandle = null;
  }

  /** 今出ている位置。再生中は、最後に出たコマの時刻をそのあと進んだ分だけ進める */
  private shownTime(entry: Entry): number {
    const { el, frame } = entry;
    if (!frame || el.paused || el.seeking) return el.currentTime;
    const elapsed = (performance.now() - frame.at) / 1000;
    // コマが 0.2 秒より来ていなければ (読み込み待ちなど)、currentTime を使う
    return elapsed > 0.2 ? el.currentTime : frame.mediaTime + elapsed * el.playbackRate;
  }

  private syncEntry(entry: Entry, t: PlaybackTarget, isPlaying: boolean, speed: number): void {
    const el = entry.el;
    const src = el.currentSrc || el.src;
    if (entry.src !== src) {
      entry.src = src;
      entry.frame = null;
      entry.correcting = false;
      this.primed.delete(el);
    }
    let localTime = t.localTime;
    if (localTime < 0 || (t.durationSec > 0 && localTime > t.durationSec)) {
      if (!el.paused) el.pause();
      return;
    }
    // 移動中 (seeking) は合わせない。移動が終わったら (seeked) もう一度合わせる
    if (el.seeking) return;
    // 動画の本当の長さを超えた位置には移動できない (移動しても終わりに止まり、移動が終わるたびに合わせ直して止まらなくなる)
    if (Number.isFinite(el.duration) && el.duration > 0 && localTime > el.duration) localTime = el.duration;
    const rated = t.rate !== undefined;
    const base = speed * (t.rate ?? 1);
    const diff = localTime - this.shownTime(entry); // 正なら動画が遅れている
    // 止めているとき・倍率が範囲の外 (比べる車が止まっている・Car 1 が止まっているなど) は、位置だけ合わせる
    if (!isPlaying || base < MIN_RATE * speed || base > MAX_RATE * speed) {
      // コマをまだ読んでいない動画 (iPhone) は、音を消して一度だけ再生して止め、止めたままでもコマを出せるようにする
      if (el.readyState < 2 && !this.primed.has(el)) {
        this.primed.add(el);
        const wasMuted = el.muted;
        const target = localTime;
        el.muted = true;
        // 再生が始まったら止めて、今の位置へ移す (移し終えると seeked で、もう一度合わせる)
        el.play().then(() => { el.pause(); el.muted = wasMuted; el.currentTime = target; }).catch(() => { el.muted = wasMuted; el.currentTime = target; });
        return;
      }
      if (!el.paused) el.pause();
      // 止めているときはコマ送り (0.1 秒) にも付いていけるよう、細かく合わせる
      if (Math.abs(diff) > 0.02) el.currentTime = localTime;
      if (el.playbackRate !== speed) el.playbackRate = speed;
      return;
    }
    if (Math.abs(diff) > (rated ? JUMP_SEC_RATED : JUMP_SEC)) {
      // 大きくずれたら (シーク・周の始めに戻ったときなど) 飛ぶ
      el.currentTime = localTime;
      if (Math.abs(el.playbackRate - base) > 0.001) el.playbackRate = base;
    } else {
      // 少しのずれは、再生の速さを少し変えて追いつく (毎回飛ぶと映像が止まって見える)。
      // 音を出している動画は速さを変えずにおく (速さを変えると、Safari は音の高さを保つ処理をして、iPhone では映像が重くなる)。
      // 音を出すのはふつう基準の枠で、App の時刻と同じ速さで進むので、ずれるのはまれ。大きくずれたら上で飛ぶ
      if (!el.muted) entry.correcting = false;
      else if (Math.abs(diff) > CORRECT_START_SEC) entry.correcting = true;
      else if (Math.abs(diff) < CORRECT_STOP_SEC) entry.correcting = false;
      const correction = entry.correcting ? Math.max(-0.1, Math.min(0.1, diff * 0.5)) : 0;
      const rate = Math.max(MIN_RATE * speed, Math.min(MAX_RATE * speed, base * (1 + correction)));
      // 速さを小刻みに変えない (2% より小さい変化と、前に変えてから 0.5 秒たたないうちの変化はしない。ただし詰め終えたら元の速さへすぐ戻す)
      const now = performance.now();
      const big = Math.abs(el.playbackRate - rate) > Math.max(0.001, rate * 0.02);
      const backToBase = !entry.correcting && Math.abs(el.playbackRate - rate) > 0.001;
      if (backToBase || (big && now - entry.rateChangedAt >= RATE_CHANGE_INTERVAL_MS)) {
        el.playbackRate = rate;
        entry.rateChangedAt = now;
      }
    }
    // 長さが分かっていれば再生を始める (iPhone の Safari は再生を始めるまでコマを読まないので、コマを読むのを待たない)
    if (el.paused && el.readyState >= 1) playSafely(el);
  }
}
