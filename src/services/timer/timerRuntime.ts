/**
 * ラップタイマーの中身 (2026-10-21、PLAN-24 の作る順番の 4。設計は Fable の案 A)。
 * 測位の出どころ・コース・周の数え方・走っている間の記録・G センサー・Bluetooth の機器・保存と選んだフォルダへの写しを持つ。
 * 画面 (LapTimerScreen) は、これの様子 (subscribe / getSnapshot) を出し、ボタンを押したら呼ぶだけ。
 * 今の段 (A2) では、画面を開いたときに作り、閉じたときに片付ける (動きは前と同じ)。次の段で、アプリに 1 つにして、タブを替えても測り続ける
 */

import { bleLoggerLink } from '../bleLoggerLink';
import { LiveLapTimer, type LiveFix, type LiveLapEvent, type LiveLapState } from '../liveLapTimer';
import { CIRCUIT_PRESETS, findMatchingCircuit } from '../circuitDatabase';
import { LiveRunRecorder, closeRunFiles } from '../runRecorder';
import { courseFolder, UNSORTED_FOLDER } from '../../utils/courseNames';
import { callNative, hasNative, onNative } from '../../native/bridge';
import { PhoneImuRecorder } from '../phoneImu';
import { getRunStore } from '../runStore';
import { LAP_INDEX_FILE, lapKey, parseLapIndex } from '../lapIndex';
import { getLang } from '../../utils/i18n';
import { setPositionSource, type PositionSource } from '../positionSource';
import { digspiceFeed, distanceKm, phoneFeed, replayFeed, type PhoneInfo, type StopFeed } from './positionFeeds';
import { LapDeviceSet, type LapDeviceStatus } from './lapDeviceSet';
import { PhoneCameraRecorder, type CameraStatus } from './phoneCamera';
import { GpsImuFusion } from './gpsImuFusion';

const FUSION_KEY = 'ds_timer_phone_fusion';
/** iPhone の GPS の間を G センサーで埋めるか (既定はオン) */
export function loadPhoneFusion(): boolean {
  try { return localStorage.getItem(FUSION_KEY) !== 'off'; } catch { return true; }
}
export function savePhoneFusion(on: boolean): void {
  try { localStorage.setItem(FUSION_KEY, on ? 'on' : 'off'); } catch { /* 覚えられなくても測れる */ }
}
import type { CircuitPreset, TelemetryPoint } from '../../types/telemetry';

export type TimerSource = PositionSource | 'replay';

export interface ReplayLog {
  id: string;
  name: string;
  points: TelemetryPoint[];
  startDate?: Date;
}

/** 選んだフォルダへ写す、走っている間の最短の間隔 */
const SYNC_INTERVAL_MS = 3 * 60 * 1000;
/** 走っている間に、記録を保存する間隔 */
const SAVE_INTERVAL_MS = 2000;
/** 周を終えたあと、そのタイムを大きく出しておく長さ (ミリ秒) */
export const FLASH_MS = 6000;

const presetsWithLine = CIRCUIT_PRESETS.filter(c => c.controlLine);

/** 声で知らせる */
export function speak(text: string, lang: string): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 1.05;
    synth.speak(u);
  } catch {
    // 声を出せない環境では黙る
  }
}

export function lapSpeech(e: LiveLapEvent): { text: string; lang: string } {
  const ja = getLang() === 'ja';
  const t = e.lap.timeSec;
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  const tenth = Math.floor((t - Math.floor(t)) * 10);
  const d = e.diffToBestSec;
  if (ja) {
    const time = `${m > 0 ? `${m}分` : ''}${s}秒${tenth}`;
    const diff = d === null ? '' : e.isBest ? '、ベスト' : `、プラス${Math.abs(d).toFixed(1)}`;
    return { text: time + diff, lang: 'ja-JP' };
  }
  const time = `${m > 0 ? `${m} ` : ''}${s} point ${tenth}`;
  const diff = d === null ? '' : e.isBest ? ', best lap' : `, plus ${Math.abs(d).toFixed(1)}`;
  return { text: time + diff, lang: 'en-US' };
}

/** 画面に出す様子 */
export interface TimerSnapshot {
  source: TimerSource;
  replayId: string;
  replaySpeed: number;
  course: CircuitPreset | null;
  /** 周の数え方の様子 (0.1 秒ごと・周を終えたときに読み直す) */
  lap: LiveLapState | null;
  /** 最後に届いた測位 (測っていない間も) と、届いた時刻 (performance.now) */
  lastPos: LiveFix | null;
  lastFixPerf: number;
  flash: { event: LiveLapEvent; until: number } | null;
  voice: boolean;
  measuring: boolean;
  savedRun: { laps: number; best: number | null } | null;
  saveError: string | null;
  syncNote: { ok: boolean; text: string } | null;
  phoneInfo: PhoneInfo;
  pastBest: { time: number; startMs: number } | null;
  devices: LapDeviceStatus[];
  /** 周をはじめから数え直した回数 (画面が、出した経過の覚えを捨てるため) */
  epoch: number;
  /** 内蔵カメラの録画の様子 */
  camera: CameraStatus;
}

export interface TimerRuntimeDeps {
  /** 再生で試せるログ (読み込んだ走行) */
  replayLogs: () => ReplayLog[];
  /** 端末の GPS の文言 (言語に合わせたもの) */
  phoneMessages: () => { unavailable: string; denied: string };
}

export class TimerRuntime {
  private listeners = new Set<() => void>();
  private snap: TimerSnapshot;

  private timer: LiveLapTimer | null = null;
  private fixes: LiveFix[] = [];
  private recorder: LiveRunRecorder | null = null;
  private readonly imu: PhoneImuRecorder;
  readonly devices: LapDeviceSet;
  private manualCourse = false;
  /** デジスパイスの接続を、このタイマーがつないだか (離れるときに、自分でつないだものだけ切る) */
  private connectedHere = false;
  private lastSyncMs = 0;
  private stopFeed: StopFeed | null = null;
  private intervals: ReturnType<typeof setInterval>[] = [];
  private onHide = () => { if (document.visibilityState === 'hidden') void this.sync(); };
  private running = false;
  private pastBestToken = 0;
  /** iPhone の GPS の間を G センサーで埋める (測っている間・端末の GPS のとき) */
  private fusion: GpsImuFusion | null = null;
  readonly camera: PhoneCameraRecorder;
  private offCamera: (() => void) | null = null;

  constructor(private readonly deps: TimerRuntimeDeps, initialSource: TimerSource) {
    const firstReplay = deps.replayLogs()[0]?.id ?? '';
    this.snap = {
      source: initialSource, replayId: firstReplay, replaySpeed: 4, course: null, lap: null,
      lastPos: null, lastFixPerf: 0, flash: null, voice: true, measuring: false,
      savedRun: null, saveError: null, syncNote: null, phoneInfo: { accuracy: null, error: null },
      pastBest: null, devices: [], epoch: 0, camera: { recording: false, error: null }
    };
    this.camera = new PhoneCameraRecorder(st => this.set({ camera: st }));
    this.imu = new PhoneImuRecorder(() => this.recorder?.current?.fileBase ?? null);
    this.devices = new LapDeviceSet({ onFix: f => this.handleFix(f), runBase: () => this.recorder?.current?.fileBase ?? null });
    this.devices.subscribe(() => this.set({ devices: this.devices.getSnapshot() }));
  }

  // ---- 様子 ----

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  getSnapshot = (): TimerSnapshot => this.snap;

  private set(patch: Partial<TimerSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach(l => l());
  }

  /** 周の数え方の様子を読み直す (画面が 0.1 秒ごとに呼ぶ。測位ごと (20 Hz) に描き直すと、車の中で端末が熱くなるため) */
  refresh(): void {
    this.set({ lap: this.timer?.getState() ?? null });
  }

  /** 今書いている走行 (メニューの記録の一覧で使う) */
  get currentRunId(): string | null {
    return this.recorder?.current?.id ?? null;
  }

  /** 消した走行を書いていたら、次の測位から新しい走行にする */
  forgetRun(id: string): void {
    if (this.recorder?.current?.id === id) {
      void closeRunFiles(this.recorder.filesBase);
      this.recorder = null;
    }
  }

  // ---- 始める・片付ける (画面を開いた・閉じた) ----

  start(): void {
    if (this.running) return;
    this.running = true;
    // Bluetooth の機器 (位置・センサー・カメラ) は、開いただけではつながない。出どころの印か測定開始でつなぐ (2026-10-21)
    this.applySource();
    this.intervals.push(setInterval(() => { void this.flush(); }, SAVE_INTERVAL_MS));
    document.addEventListener('visibilitychange', this.onHide);
    window.addEventListener('pagehide', this.onHide);
    if (hasNative()) this.offCamera = onNative('camera.state', e => this.camera.noteState(e.recording, e.error));
  }

  dispose(): void {
    if (!this.running) return;
    this.running = false;
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    document.removeEventListener('visibilitychange', this.onHide);
    window.removeEventListener('pagehide', this.onHide);
    this.offCamera?.();
    this.offCamera = null;
    // 画面を閉じたら録画も止める (測っていた走行の .mov として置く)
    void this.camera.stop(this.recorder?.filesBase ?? null, this.cameraFolder());
    this.endFeed();
    void this.imu.stop();
    void this.devices.disconnect();
    void this.sync();
  }

  // ---- 出どころ ----

  private positionKind(): 'racebox' | 'drogger' | null {
    const s = this.snap.source;
    return s === 'racebox' || s === 'drogger' ? s : null;
  }

  setSource(s: TimerSource): void {
    if (s === this.snap.source) return;
    // 試すための再生中の録画は、再生をやめたら止める
    if (this.snap.source === 'replay' && !this.snap.measuring) void this.camera.stop(null, this.cameraFolder());
    this.set({ source: s });
    if (s !== 'replay') setPositionSource(s);
    if (!this.running) return;
    this.applySource();
    // つないでいたら、位置の機器を替えてつなぎ直す (つないでいなければ、印か測定開始まで待つ)
    if (this.devices.isConnected) void this.devices.connect(this.positionKind());
  }

  setReplay(id: string, speed?: number): void {
    const logChanged = id !== this.snap.replayId;
    this.set({ replayId: id, ...(speed !== undefined ? { replaySpeed: speed } : {}) });
    // 再生するログを替えたら、自分で選んだのでなければコースは選び直す (前のログのコースのままにしない)
    if (logChanged && !this.manualCourse) this.chooseCourse(null);
    if (this.running && this.snap.source === 'replay') this.applySource();
  }

  setReplaySpeed(speed: number): void {
    this.setReplay(this.snap.replayId, speed);
  }

  private endFeed(): void {
    this.stopFeed?.();
    this.stopFeed = null;
  }

  /** 出どころを替えたら、測位と周をはじめからにする (コースはそのまま) */
  private applySource(): void {
    this.endFeed();
    this.resetRun();
    const src = this.snap.source;
    const onFix = (f: LiveFix) => this.handleFix(f);
    if (src === 'digspice') {
      // 開いただけではつながない。つなぐのは出どころの印 (connectSource) と測定開始
      const off = digspiceFeed(onFix);
      this.stopFeed = () => {
        off();
        // ここでつないだ接続は、測っていないまま離れたら切る (ほかの画面にいる間に探し続けて、電池を使わないように)
        if (this.connectedHere && !this.snap.measuring) {
          this.connectedHere = false;
          void bleLoggerLink.disconnect();
        }
      };
    } else if (src === 'phone') {
      // 測っている間は、GPS の間を G センサーで埋めた測位を使う (設定でオンのとき)
      this.stopFeed = phoneFeed(f => (this.fusion ? this.fusion.gps(f) : onFix(f)), i => this.set({ phoneInfo: i }), this.deps.phoneMessages());
    } else if (src === 'replay') {
      this.stopFeed = replayFeed(this.deps.replayLogs().find(l => l.id === this.snap.replayId), this.snap.replaySpeed, onFix);
    }
    // RaceBox・Drogger の測位は、機器 (LapDeviceSet) が handleFix へ渡す
  }

  /** 上の出どころの印を押した: 位置の機器につなぐ (デジスパイスは切断ボタンで切っていても。RaceBox・Drogger は機器の一式と一緒に) */
  connectSource(): void {
    if (this.snap.source === 'digspice') {
      if (bleLoggerLink.isLinkIdle()) this.connectedHere = true;
      void bleLoggerLink.startAndConnect(true);
    } else if (this.positionKind()) {
      void this.devices.connect(this.positionKind());
    }
  }

  // ---- コース ----

  /** コースを決める。replay なら、それまでに届いた測位を新しいコースで数え直す (声は出さない) */
  chooseCourse(c: CircuitPreset | null, opts: { replay?: boolean; manual?: boolean } = {}): void {
    if (opts.manual !== undefined) this.manualCourse = opts.manual;
    const timer = c?.controlLine ? new LiveLapTimer({ controlLine: c.controlLine, sectors: c.sectors }) : null;
    // 届いた測位で数え直すのは、測っている間とログの再生だけ (測定開始を押す前の測位では周を数えない)
    if (timer && opts.replay && (this.snap.measuring || this.snap.source === 'replay')) this.fixes.forEach(f => timer.push(f));
    this.timer = timer;
    const changed = c?.id !== this.snap.course?.id;
    this.set({ course: c, lap: timer?.getState() ?? null, flash: null });
    if (changed) this.loadPastBest(c);
  }

  /** このコースの、保管場所の記録のベスト (測る前の画面に出す) */
  private loadPastBest(course: CircuitPreset | null): void {
    const token = ++this.pastBestToken;
    this.set({ pastBest: null });
    if (!course || !hasNative()) return;
    void (async () => {
      const store = await getRunStore();
      if (!store || token !== this.pastBestToken) return;
      const folder = courseFolder(course.name, course.folder, course.id);
      const index = parseLapIndex(await store.readText(`${folder}/${LAP_INDEX_FILE}`).catch(() => null));
      if (!index || token !== this.pastBestToken) return;
      const hidden = new Set(index.hidden.map(h => lapKey(h.file, h.part, h.n)));
      let best: { time: number; startMs: number } | null = null;
      for (const [file, rec] of Object.entries(index.files)) {
        for (const l of rec.laps) if (!hidden.has(lapKey(file, l.part, l.n)) && (!best || l.time < best.time)) best = { time: l.time, startMs: l.startMs };
      }
      if (token === this.pastBestToken) this.set({ pastBest: best });
    })();
  }

  /**
   * 自動で選んだコースを、周を数える前は、届いた測位で選び直す (同じ敷地に計測線の違うコースがあるとき、
   * 測位の所に近いだけのコースではなく、計測線を横切ったコースにする。筑波 2000 / 1000 など)
   */
  private recheckCourse(): void {
    const all = this.fixes;
    const last = all[all.length - 1];
    const cur = this.snap.course;
    if (!last || !cur || this.manualCourse || (this.timer?.getState().laps.length ?? 0) > 0) return;
    // 近く (3 km 以内) に計測線のある別のコースがない所 (袖ヶ浦など) では、選び直さない
    if (!presetsWithLine.some(c => c.id !== cur.id && distanceKm(cur.centerLat, cur.centerLon, c.centerLat, c.centerLon) < 3)) return;
    // 見るのは直近の 2 分ほど (20 Hz で 2400 点) まで (重くならないように)
    const fixes = all.slice(-2400);
    let dist = 0;
    const points = fixes.map((f, i) => {
      if (i > 0) dist += distanceKm(fixes[i - 1].latitude, fixes[i - 1].longitude, f.latitude, f.longitude);
      return { time: (f.tMs - fixes[0].tMs) / 1000, latitude: f.latitude, longitude: f.longitude, speed: f.speedKmh, distance: dist } as TelemetryPoint;
    });
    const found = findMatchingCircuit(last.latitude, last.longitude, points);
    if (found?.controlLine && found.id !== cur.id && distanceKm(last.latitude, last.longitude, found.centerLat, found.centerLon) < 5) {
      this.chooseCourse(found, { replay: true });
    }
  }

  // ---- 測位 ----

  /** 測位を 1 つ受け取る (出どころによらず同じ) */
  private startFusion(): void {
    this.stopFusion();
    if (this.snap.source !== 'phone' || !loadPhoneFusion()) return;
    this.fusion = new GpsImuFusion(f => this.handleFix(f));
    this.imu.onCar = (t, l, a, y) => this.fusion?.imu(t, l, a, y);
  }

  private stopFusion(): void {
    this.fusion = null;
    this.imu.onCar = null;
  }

  /** 動画を置く未分類のフォルダ (測位が無かったときだけ使う) */
  /** 内蔵カメラで撮るか。読み込んだログの再生では撮らない (試すときだけ、localStorage の ds_timer_camera_replay を 1 にすると撮る) */
  private cameraOn(): boolean {
    if (this.snap.source !== 'replay') return true;
    try { return localStorage.getItem('ds_timer_camera_replay') === '1'; } catch { return false; }
  }

  private cameraFolder(): string {
    const c = this.snap.course;
    return c ? courseFolder(c.name) || UNSORTED_FOLDER : UNSORTED_FOLDER;
  }

  handleFix(fix: LiveFix): void {
    if (fix.valid && this.cameraOn()) this.camera.noteFix(fix.tMs);
    // 試すとき (ds_timer_camera_replay): 再生は「測る」にならないので、再生が動き出したら録画を始める
    if (fix.valid && this.snap.source === 'replay' && !this.snap.measuring && this.cameraOn()) void this.camera.start();
    if (!fix.valid) return;
    this.snap = { ...this.snap, lastPos: fix, lastFixPerf: performance.now() };
    this.fixes.push(fix);
    // 持つのは直近の 10 分ほど (コースの選び直しに使うだけ。走った測位は全部、記録の保存先にある)。
    // 測る前は少なめにする (長く待っても、コースの選び直し (4800 点まで) が止まらないように)
    if (this.fixes.length > (this.snap.measuring ? 12000 : 4000)) this.fixes.splice(0, 2000);
    // コースを決めていなければ、初めの測位の所で選ぶ。周を数える前は、ときどき選び直す
    if (!this.snap.course) {
      const found = findMatchingCircuit(fix.latitude, fix.longitude);
      if (found?.controlLine && distanceKm(fix.latitude, fix.longitude, found.centerLat, found.centerLon) < 5) this.chooseCourse(found);
    } else if (this.fixes.length % 200 === 0 && this.fixes.length <= 4800) {
      this.recheckCourse();
    }
    // 測定開始を押すまでは、周を数えず記録もしない (ログの再生はいつも数える・記録しない)
    const src = this.snap.source;
    if (src !== 'replay' && !this.snap.measuring) return;
    // 走っている間の記録 (ログの再生は記録しない)
    if (src !== 'replay') {
      const course = () => this.snap.course;
      this.recorder ??= new LiveRunRecorder(src, () => course()?.name ?? '', m => this.set({ saveError: m }),
        () => { const c = course(); return c ? courseFolder(c.name, c.folder, c.id) : ''; });
      this.recorder.add(fix);
    }
    const timer = this.timer;
    if (!timer) return;
    const events = timer.push(fix);
    for (const e of events) {
      if (e.kind === 'lap') {
        this.snap = { ...this.snap, flash: { event: e, until: performance.now() + FLASH_MS } };
        // 周を終えたら、動画に印を付ける
        this.devices.lap();
        // 周を終えたら、すぐ保存する。選んだフォルダへは 3 分に 1 回まで写す
        void this.flush();
        if (Date.now() - this.lastSyncMs > SYNC_INTERVAL_MS) void this.sync();
        if (this.snap.voice) {
          const s = lapSpeech(e);
          speak(s.text, s.lang);
        }
      }
    }
    // 表示は 0.1 秒ごとにまとめて描き直す。周を終えたときだけすぐ
    if (events.length > 0) this.set({ lap: timer.getState() });
  }

  setVoice(on: boolean): void {
    this.set({ voice: on });
  }

  // ---- 測る ----

  /** 測定開始: 周をはじめから数え、次の測位から新しい走行のファイルに書く */
  startMeasuring(): void {
    // 測ると決めたので、位置の機器 (切断ボタンで切っていても)・センサー・カメラにつなぐ
    if (this.snap.source === 'digspice') this.connectSource();
    void this.devices.connect(this.positionKind());
    // 前の走行 (測る前に書いていたもの) は、ここで書き終える (選んだフォルダへ移せるように)
    void closeRunFiles(this.recorder?.filesBase);
    this.recorder = null;
    // 押す前の測位で周を数えないよう、コースの選び直しに使う測位も捨てる
    this.fixes = [];
    this.set({ measuring: true, savedRun: null, epoch: this.snap.epoch + 1 });
    // カメラ (GoPro) の時計を合わせて録画を始める
    this.devices.startRun(new Date());
    // G センサーを読み始める (今の傾きを基準にするので、止まっているうちに押すのがよい)
    void this.imu.start();
    // iPhone の GPS で測るときは、GPS の間を G センサーで埋める (1 Hz → 10 Hz)
    this.startFusion();
    // 内蔵カメラで録画を始める (設定でオンのとき。読み込んだログの再生で試すときは撮らない)
    if (this.cameraOn()) void this.camera.start();
    this.chooseCourse(this.snap.course);
  }

  /** 測定終了: 書いた走行を閉じて保存し、選んだフォルダへ写す。周の表示は次に測り始めるまで残す */
  async stopMeasuring(): Promise<void> {
    if (!this.snap.measuring) return;
    this.set({ measuring: false });
    this.stopFusion();
    // カメラの録画を止め、センサーの値を書き、次の走行の .csv に替える
    // センサーの .csv は、書き終えてから写す (写したあとに残りの行を書くと、選んだフォルダの .csv が欠けるため)
    const sensors = Promise.all([this.devices.stopRun(), this.imu.stop()]).catch(() => {});
    // 今の走行の記録を先に外してから保存する (保存の途中で測定開始を押しても、新しい走行の記録を消さないように)
    const rec = this.recorder;
    this.recorder = null;
    const st = this.timer?.getState();
    await rec?.flush({ lapCount: st?.laps.length ?? 0, bestLapSec: st?.best?.timeSec ?? null }, true);
    if (rec) this.set({ savedRun: { laps: st?.laps.length ?? 0, best: st?.best?.timeSec ?? null } });
    // 録画を止めて、.nmea と同じ所に .mov を置く (選んだフォルダへ写す前に)
    await this.camera.stop(rec?.filesBase ?? null, this.cameraFolder());
    await sensors;
    // 書き終えたので、選んだフォルダへ移す (アプリの中に控えを残さない)
    await closeRunFiles(rec?.filesBase);
    await this.sync();
  }

  /** 周をはじめから数える (出どころを替えた・メニューで数え直した)。それまでの記録は保存して閉じ、次の測位から新しい走行にする */
  resetRun(): void {
    // 録画を止め、センサーの .csv を次の走行に替える (書き終えてから写す)
    const sensors = Promise.all([this.devices.stopRun(), this.imu.newRun()]).catch(() => {});
    // それまでの記録を外して保存してから、写す (外す前に保存し終わらないと、最後の数秒が残らないため)
    const rec = this.recorder;
    this.recorder = null;
    const st = this.timer?.getState();
    const measuring = this.snap.measuring;
    void (rec ? rec.flush({ lapCount: st?.laps.length ?? 0, bestLapSec: st?.best?.timeSec ?? null }, true) : Promise.resolve())
      // 測っている途中なら、録画もそこで区切り、新しい走行として撮り始める
      .then(() => this.camera.stop(rec?.filesBase ?? null, this.cameraFolder()))
      .then(() => { if (measuring && this.snap.measuring && this.cameraOn()) void this.camera.start(); })
      .then(() => sensors).then(() => closeRunFiles(rec?.filesBase)).then(() => this.sync());
    this.fixes = [];
    this.set({ lastPos: null, epoch: this.snap.epoch + 1 });
    this.chooseCourse(this.snap.course);
    // 測っている途中で出どころを替えたときは、新しい走行としてカメラの録画を始め直す
    if (this.snap.measuring) this.devices.startRun(new Date());
    // GPS の間を埋めるのは端末の GPS のときだけ (出どころを替えたら、付け直す)
    if (this.snap.measuring) this.startFusion();
  }

  // ---- 保存 ----

  /** ためた測位を保存する (周の数とベストも一緒に。センサーの .csv も) */
  flush(force = false): Promise<void> {
    const rec = this.recorder;
    if (!rec) return Promise.resolve();
    const st = this.timer?.getState();
    this.devices.flush();
    void this.imu.flush();
    return rec.flush({ lapCount: st?.laps.length ?? 0, bestLapSec: st?.best?.timeSec ?? null }, force);
  }

  /**
   * 保管先に選んだフォルダ (iCloud Drive など) へ、LapTimer/ のファイルを写す (アプリのみ。保管先が この iPhone なら何もしない)。
   * 裏に回ったとき・閉じたとき・周を数え直したとき・周を終えたとき (3 分に 1 回まで) に呼ぶ
   */
  async sync(): Promise<void> {
    this.lastSyncMs = Date.now();
    // 閉じる・裏に回る・数え直すときは、コースを待っている途中の測位も保存する (ブラウザ版も)
    await this.flush(true);
    if (!hasNative()) return;
    try {
      const r = await callNative('system.syncLapFiles', {});
      if (r.kind !== 'folder') return;
      if (r.failed > 0) this.set({ syncNote: { ok: false, text: r.error ?? `${r.failed}` } });
      else if (r.copied + (r.moved ?? 0) > 0) this.set({ syncNote: { ok: true, text: `${r.copied + (r.moved ?? 0)}` } });
    } catch (e) {
      this.set({ syncNote: { ok: false, text: e instanceof Error ? e.message : String(e) } });
    }
  }

  setSaveError(m: string | null): void {
    this.set({ saveError: m });
  }
}
