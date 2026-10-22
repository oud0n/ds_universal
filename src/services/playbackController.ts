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

import { clockMasterEnabled } from './clockMaster';

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
// 速さを変えずにおく音のある動画 (Safari) は、これより遅れたら飛ぶ (再生を始めた直後の出遅れ 0.2〜0.5 秒を残さないため)
const JUMP_SEC_AUDIBLE_FIXED = 0.2;
// 音を出している動画のずれを詰め始める大きさ (音を消した動画より大きくして、速さを変える回数を減らす)
const CORRECT_START_SEC_AUDIBLE = 0.08;
// 飛ぶときに、移動にかかる時間の分だけ先へ飛ぶ (移動のあいだも App の時刻は進むので、ちょうどの位置へ飛ぶと遅れたまま着き、また飛ぶ)。その上限。
// パソコンの Safari の音のある動画は、移動して動き出すまで 0.5〜0.7 秒かかる (音を消すと 0.05 秒ほど) (2026-10-20)
const MAX_SEEK_LEAD_SEC = 0.8;
// 飛んだ移動が動き出すのを待つ長さの上限
const SEEK_HOLD_MS = 1500;

/**
 * <video> の今のファイル。src は替えたその場で替わる。currentSrc は読み込みが始まるまで前のファイルのままなので、それより先に見る
 * (止めたまま Car を替えたとき、前のファイルと見誤って一度だけの再生をやり直さず、iPhone で黒いままだった。2026-10-22)
 */
const videoSrc = (el: HTMLVideoElement): string => el.getAttribute?.('src') || el.src || el.currentSrc;

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
  /** 再生中に飛んだ時刻 (performance.now)。移動が終わって次のコマが出たら、かかった時間を seekLead にする */
  seekStartedAt: number | null;
  /** 移動が終わり (seeked)、次のコマが出るのを待っている。Safari は seeked のあとも、しばらく動き出さない */
  seekDone: boolean;
  /** 飛んだ先 (動画の秒) */
  seekTarget: number;
  /** 前に合わせたときの App の時刻 (動画の秒) と、その時刻 (performance.now)。見ている位置を動かしたのを見分ける */
  lastLocal: number;
  lastSyncAt: number | null;
  /** 飛んだときに音を出していたか (移動にかかった時間を、どちらの seekLead として覚えるか) */
  seekAudible: boolean;
  /** 再生中に飛ぶとき、先へずらす秒数 (前の移動にかかった時間)。[音を消しているとき, 音を出しているとき] (Safari では 10 倍ほど違う) */
  seekLead: [number, number];
  onSeeked: () => void;
  /** 動画の位置 − App の時刻 (秒)。時計の元になれる枠 (音を出して再生している・倍率なし) のときだけ */
  appOffset: number | null;
  /** 時計の元として最後に返した時刻と、それが進んだ時刻 (動画が動かなくなったら、時計の元をやめるため) */
  masterLast: { value: number; atMs: number } | null;
  /** 動かなかったので、時計の元にしない (進んだコマが出たら戻す。コマを知らせてもらえないブラウザでは 5 秒後) */
  masterBlockedUntil: number;
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; expectedDisplayTime?: number }) => void) => number;
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
  /**
   * 音を出している動画も、再生の速さを少し変えてずれを詰めるか。
   * Safari (iPhone・iPad・パソコンとも) は、音のある動画の速さを変えると映像が重くなる (コマが 1 秒に数枚まで落ちる) ので false にする
   */
  constructor(private readonly adjustAudibleRate = true) {}

  private entries = new Map<string, Entry>();
  /** 時計の元にしている枠 (音を出して再生している、倍率のない枠の最初のもの)。clockMaster.ts */
  private master: Entry | null = null;
  private playing = false;
  // 止めたまま最初のコマを出すために、一度だけ再生して止めた動画 (iPhone の Safari は、再生するまで動画を読み込まず、黒いまま)
  private primed = new WeakSet<HTMLVideoElement>();

  /** 枠の <video> を登録する (ref のコールバックから。null で外す) */
  attach(key: string, el: HTMLVideoElement | null): void {
    const old = this.entries.get(key);
    if (old && old.el === el) return;
    if (old) { this.stopFrames(old); old.el.removeEventListener('seeked', old.onSeeked); }
    if (!el) { this.entries.delete(key); return; }
    const entry: Entry = {
      el, frame: null, frameHandle: null, correcting: false, rateChangedAt: 0, src: videoSrc(el),
      seekStartedAt: null, seekDone: false, seekTarget: 0, lastLocal: 0, lastSyncAt: null, seekAudible: false, seekLead: [0, 0],
      appOffset: null, masterLast: null, masterBlockedUntil: 0,
      onSeeked: () => {
        // 移動の途中で止めていたら、移動が終わったときに止める (止めたあとは sync が呼ばれないため)
        if (!this.playing && !el.paused) el.pause();
        if (entry.seekStartedAt === null) return;
        // コマが出たのを知らせてもらえるときは、次のコマが出るまで待って測る (watchFrames)
        if ((el as FrameVideo).requestVideoFrameCallback) entry.seekDone = true;
        else this.noteSeekTime(entry, performance.now());
      },
    };
    el.addEventListener('seeked', entry.onSeeked);
    this.entries.set(key, entry);
    this.watchFrames(entry);
  }

  element(key: string): HTMLVideoElement | null {
    return this.entries.get(key)?.el ?? null;
  }

  pauseAll(): void {
    this.entries.forEach(({ el }) => { if (!el.paused) el.pause(); });
  }

  /**
   * 枠ごとの位置に合わせる。targets にない枠は止める。
   * appTime (App の時刻) を渡すと、音を出して再生している枠を時計の元にする (masterAppTime)
   */
  sync(targets: Map<string, PlaybackTarget>, isPlaying: boolean, speed: number, appTime?: number): void {
    this.playing = isPlaying;
    let master: Entry | null = null;
    this.entries.forEach((entry, key) => {
      const t = targets.get(key);
      const el = entry.el;
      const eligible = clockMasterEnabled && appTime !== undefined && isPlaying && !!t && !t.outOfRange && t.rate === undefined && !el.muted
        && performance.now() >= entry.masterBlockedUntil
        && t.localTime >= 0 && !(t.durationSec > 0 && t.localTime > t.durationSec);
      entry.appOffset = eligible ? t!.localTime - appTime! : null;
      if (!eligible) entry.masterLast = null;
      if (eligible && !master) master = entry;
    });
    this.master = master;
    this.entries.forEach((entry, key) => {
      const t = targets.get(key);
      if (!t || t.outOfRange) { if (!entry.el.paused) entry.el.pause(); this.stopSeekWait(entry); return; }
      this.syncEntry(entry, t, isPlaying, speed);
    });
  }

  /**
   * 時計の元の動画の位置を、App の時刻に直したもの (秒)。時計の元がない・動画が 2 秒動かないときは null。
   * 動画が動き出すまで (再生の始め・移動の後) は止まったままの位置を返すので、App はそこで待つ
   */
  masterAppTime(): number | null {
    const e = this.master;
    if (!e || e.appOffset === null || !this.playing || e.el.ended) return null;
    const value = this.shownTime(e) - e.appOffset;
    const now = performance.now();
    if (!e.masterLast || value > e.masterLast.value + 1e-4) e.masterLast = { value, atMs: now };
    else if (now - e.masterLast.atMs > 2000) {
      // 動かない動画を待ち続けない。進んだコマが出るまで、時計の元にしない
      e.masterBlockedUntil = (e.el as FrameVideo).requestVideoFrameCallback ? Infinity : now + 5000;
      e.masterLast = null;
      return null;
    }
    return value;
  }

  /** 飛んだ移動を待つのと、移動の時間の測りかけをやめる (動画を止めたとき。止めたあとの時間を、移動の時間として覚えないように) */
  private stopSeekWait(entry: Entry): void {
    entry.seekStartedAt = null;
    entry.seekDone = false;
    entry.lastSyncAt = null;
  }

  /** 飛んでから動き出すまでの時間を覚える。ばらつくので、前の値とならす */
  private noteSeekTime(entry: Entry, at: number): void {
    const started = entry.seekStartedAt;
    entry.seekStartedAt = null;
    entry.seekDone = false;
    // 測っているあいだに音を出す・消すが切り替わったら (再生を断られて音を消したときも)、どちらの時間とも言えないので覚えない
    if (started === null || entry.el.muted === entry.seekAudible) return;
    const sec = (at - started) / 1000;
    // 1.5 秒より長いのは、途中で止めた・タブを隠したなどで、移動の時間ではないので覚えない
    if (!(sec >= 0) || sec > SEEK_HOLD_MS / 1000) return;
    const lead = Math.min(MAX_SEEK_LEAD_SEC, sec);
    const i = entry.seekAudible ? 1 : 0;
    entry.seekLead[i] = entry.seekLead[i] > 0 ? (entry.seekLead[i] + lead) / 2 : lead;
  }

  /** 出たコマの時刻を覚える (currentTime は出ているコマより先に進んでいることがあるため) */
  private watchFrames(entry: Entry): void {
    const v = entry.el as FrameVideo;
    if (!v.requestVideoFrameCallback) return;
    const onFrame = (_now: number, meta: { mediaTime: number; expectedDisplayTime?: number }) => {
      // コマが画面に出る時刻を使う。Safari はコマが出てから 30 ms ほど遅れて知らせてくるので、受け取った時刻を使うと
      // 動画がいつも遅れて見え、速さを変え続けてしまう (2026-10-19)。先の時刻 (Chrome) や大きく外れた値はそのまま使わない
      const now = performance.now();
      const shown = meta.expectedDisplayTime;
      // Chrome はこれから出す時刻 (少し先)、Safari は出したあとに知らせる。大きく外れた値は使わない
      const at = shown !== undefined && Number.isFinite(shown) && Math.abs(now - shown) < 100 ? shown : now;
      // 時計の元にしないでいた動画が、進んだコマを出したら (動き出したら)、また時計の元にできる
      if (entry.masterBlockedUntil > 0 && entry.frame && meta.mediaTime > entry.frame.mediaTime + 0.001) entry.masterBlockedUntil = 0;
      entry.frame = { mediaTime: meta.mediaTime, at };
      // 飛んだ先より進んだコマが出たら、動き出した。Safari は、移動が終わるとすぐ飛んだ先のコマを出し、そのあとしばらく止まることがある
      if (entry.seekDone && meta.mediaTime > entry.seekTarget + 0.01) this.noteSeekTime(entry, at);
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
    const src = videoSrc(el);
    if (entry.src !== src) {
      entry.src = src;
      entry.frame = null;
      entry.correcting = false;
      entry.seekLead = [0, 0];
      entry.seekStartedAt = null;
      entry.seekDone = false;
      this.primed.delete(el);
    }
    const rated = t.rate !== undefined;
    const base = speed * (t.rate ?? 1);
    // 動画を止める場合 (止めている・位置が動画の外・倍率が範囲の外) は、飛んだ移動を待たない (移動の途中で止めても、測りかけを残さない)。
    // 再生中に、App の時刻が前に合わせたときから進むはずの分より 0.15 秒以上動いたら、見ている位置を動かしたので、やはり待たない。
    // 前に合わせてから 0.25 秒より空いたとき (タブを隠したなど) は、そのあいだの倍率の変わり方がわからないので見分けない
    const nowMs = performance.now();
    let userMoved = false;
    const moving = isPlaying && t.localTime >= 0 && !(t.durationSec > 0 && t.localTime > t.durationSec)
      && base >= MIN_RATE * speed && base <= MAX_RATE * speed;
    if (!moving) {
      this.stopSeekWait(entry);
    } else {
      const dt = entry.lastSyncAt === null ? Infinity : (nowMs - entry.lastSyncAt) / 1000;
      userMoved = dt <= 0.25 && Math.abs(t.localTime - (entry.lastLocal + base * dt)) > 0.15;
      if (userMoved) {
        entry.seekStartedAt = null;
        entry.seekDone = false;
      }
      entry.lastLocal = t.localTime;
      entry.lastSyncAt = nowMs;
    }
    let localTime = t.localTime;
    if (localTime < 0 || (t.durationSec > 0 && localTime > t.durationSec)) {
      if (!el.paused) el.pause();
      return;
    }
    // 止める指示は、移動中 (seeking) でも先に出す (止めたあとの App は描き直さないので、
    // 移動が終わってから合わせる機会がなく、動画だけ再生を続けてしまう。2026-10-20 iPhone で見つけた)
    if (!isPlaying && !el.paused) el.pause();
    // 移動中 (seeking) は合わせない。移動が終わったら (seeked) もう一度合わせる
    if (el.seeking) return;
    // 動画の本当の長さを超えた位置には移動できない (移動しても終わりに止まり、移動が終わるたびに合わせ直して止まらなくなる)
    if (Number.isFinite(el.duration) && el.duration > 0 && localTime > el.duration) localTime = el.duration;
    const diff = localTime - this.shownTime(entry); // 正なら動画が遅れている
    // 止めているとき・倍率が範囲の外 (比べる車が止まっている・Car 1 が止まっているなど) は、位置だけ合わせる
    if (!isPlaying || base < MIN_RATE * speed || base > MAX_RATE * speed) {
      // コマをまだ読んでいない動画 (iPhone) は、音を消して一度だけ再生して止め、止めたままでもコマを出せるようにする
      if (el.readyState < 2 && !this.primed.has(el)) {
        this.primed.add(el);
        const wasMuted = el.muted;
        const target = localTime;
        el.muted = true;
        // 一瞬だけ再生している印 (この間に画面に触れても、VideoTile が音を戻さないように。戻すと一瞬音が鳴る。2026-10-20)
        const ds = (el as { dataset?: DOMStringMap }).dataset;
        if (ds) ds.dsPriming = '1';
        const done = () => { if (ds) delete ds.dsPriming; el.muted = wasMuted; el.currentTime = target; };
        // 再生が始まったら止めて、今の位置へ移す (移し終えると seeked で、もう一度合わせる)
        el.play().then(() => { el.pause(); done(); }).catch(done);
        return;
      }
      if (!el.paused) el.pause();
      // 止めているときはコマ送り (0.1 秒) にも付いていけるよう、細かく合わせる
      if (Math.abs(diff) > 0.02) el.currentTime = localTime;
      if (el.playbackRate !== speed) el.playbackRate = speed;
      return;
    }
    const audible = !el.muted;
    // 時計の元の動画は、App がこの動画に付いてくるので、ふだんは合わせない (速さも位置も変えない)。
    // 見ている位置を動かしたとき (大きなずれ) だけ、ちょうどの位置へ飛ぶ (App は動画が動き出すまで待つので、先へずらさない)
    const isMaster = entry === this.master;
    // 飛ぶずれの大きさ。速さで詰められない音のある動画は、小さなずれでも飛ぶ
    const jump = isMaster ? JUMP_SEC : rated ? JUMP_SEC_RATED : audible && !this.adjustAudibleRate ? JUMP_SEC_AUDIBLE_FIXED : JUMP_SEC;
    // 前に飛んだ移動がまだ終わらず動き出していないあいだは、近くへはもう一度飛ばない
    // (動き出すまで currentTime が止まって遅れて見えるので、飛び直し続けて、移動にかかる時間も覚えられなくなる)。
    // 見ている位置を動かしたとき (上で待つのをやめる) と、1.5 秒たっても動き出さないときは飛ぶ
    const seeking = entry.seekStartedAt !== null && nowMs - entry.seekStartedAt < SEEK_HOLD_MS;
    if (seeking) {
      if (Math.abs(el.playbackRate - base) > 0.001) el.playbackRate = base;
    } else if (Math.abs(diff) > jump || (isMaster && userMoved && Math.abs(diff) > 0.02)) {
      // 時計の元の動画は、見ている位置を少し動かしただけでも、その位置へ飛ぶ (App はこの動画に付いてくるので、飛ばないと位置が戻される)
      // 大きくずれたら (シーク・周の始めに戻ったときなど) 飛ぶ。前の移動にかかった時間の分だけ先へ
      let lead = isMaster ? 0 : Math.min(entry.seekLead[audible ? 1 : 0] * base, MAX_SEEK_LEAD_SEC);
      // 終わりの近くでは先へずらさない (終わりで止まった動画を見て、飛び直し続けないように)
      if (Number.isFinite(el.duration) && el.duration > 0 && localTime + lead >= el.duration) lead = 0;
      const target = localTime + lead;
      el.currentTime = target;
      entry.seekTarget = target;
      entry.seekAudible = audible;
      entry.seekStartedAt = performance.now();
      entry.seekDone = false;
      entry.correcting = false;
      // 移動の前に出ていたコマの記録は使わない (移動が終わってすぐ合わせ直すと、前の位置を見てもう一度飛ぶため)。次のコマが出るまでは currentTime で測る
      entry.frame = null;
      if (Math.abs(el.playbackRate - base) > 0.001) el.playbackRate = base;
    } else {
      // 少しのずれは、再生の速さを少し変えて追いつく (毎回飛ぶと映像が止まって見える)。
      // Safari では、音を出している動画は速さを変えずにおく (速さを変えると、音の高さを保つ処理をして、映像が重くなる)。上で小さなずれでも飛ぶ。
      // Chrome・Electron では音のある動画も詰める (再生を始めた直後の出遅れ 0.1〜0.5 秒が、飛ぶ大きさに届かずに残るため)。
      // 音のある動画は、詰め始めるずれを大きめにして、速さを変える回数を減らす
      if (isMaster || (audible && !this.adjustAudibleRate)) entry.correcting = false;
      else if (Math.abs(diff) > (audible ? CORRECT_START_SEC_AUDIBLE : CORRECT_START_SEC)) entry.correcting = true;
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
