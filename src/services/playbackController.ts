/**
 * 1 つの動画のウインドウの全部の <video> を、1 か所で App の時刻に合わせる。
 * 再生の基準は App の時刻だけで、動画はそれに付いていく (ずれたら速さを少し変えて追いつき、大きくずれたら飛ぶ)。
 * 以前は動画の timeupdate (1 秒に 4 回ほど) で App の時刻を進めていたため、ほかのウインドウの表示がカクつき (#11)、
 * 動画がないと時刻が進まなかった (#10)
 */

export interface PlaybackTarget {
  /** 動画の中の位置 (秒)。撮影の範囲の外なら outOfRange */
  localTime: number;
  durationSec: number;
  outOfRange: boolean;
}

export class PlaybackController {
  private elements = new Map<string, HTMLVideoElement>();

  /** 枠の <video> を登録する (ref のコールバックから。null で外す) */
  attach(key: string, el: HTMLVideoElement | null): void {
    if (el) this.elements.set(key, el);
    else this.elements.delete(key);
  }

  element(key: string): HTMLVideoElement | null {
    return this.elements.get(key) ?? null;
  }

  pauseAll(): void {
    this.elements.forEach(el => { if (!el.paused) el.pause(); });
  }

  /** 枠ごとの位置に合わせる。targets にない枠は止める */
  sync(targets: Map<string, PlaybackTarget>, isPlaying: boolean, speed: number): void {
    this.elements.forEach((el, key) => {
      const t = targets.get(key);
      if (!t || t.outOfRange) { if (!el.paused) el.pause(); return; }
      syncElement(el, t.localTime, t.durationSec, isPlaying, speed);
    });
  }
}

function syncElement(el: HTMLVideoElement, localTime: number, durationSec: number, isPlaying: boolean, speed: number): void {
  if (localTime < 0 || (durationSec > 0 && localTime > durationSec)) {
    if (!el.paused) el.pause();
    return;
  }
  // 移動中 (seeking) は合わせない。移動が終わったら (seeked) もう一度合わせる
  if (el.seeking) return;
  // 動画の本当の長さを超えた位置には移動できない (移動しても終わりに止まり、移動が終わるたびに合わせ直して止まらなくなる)
  if (Number.isFinite(el.duration) && el.duration > 0 && localTime > el.duration) localTime = el.duration;
  const diff = localTime - el.currentTime; // 正なら動画が遅れている
  if (!isPlaying) {
    if (!el.paused) el.pause();
    // 止めているときはコマ送り (0.1 秒) にも付いていけるよう、細かく合わせる
    if (Math.abs(diff) > 0.02) el.currentTime = localTime;
    if (el.playbackRate !== speed) el.playbackRate = speed;
    return;
  }
  if (Math.abs(diff) > 0.5) {
    // 大きくずれたら (シーク・周の始めに戻ったときなど) 飛ぶ
    el.currentTime = localTime;
    el.playbackRate = speed;
  } else {
    // 少しのずれは、再生の速さを少し変えて追いつく (毎回飛ぶと映像が止まって見える)
    const rate = Math.abs(diff) < 0.03 ? speed : speed * (1 + Math.max(-0.1, Math.min(0.1, diff * 0.5)));
    if (Math.abs(el.playbackRate - rate) > 0.001) el.playbackRate = rate;
  }
  if (el.paused && el.readyState >= 2) el.play().catch(() => {});
}
