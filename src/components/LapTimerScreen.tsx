import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Volume2, VolumeX, Menu, MapPin, Bluetooth, Smartphone, PlayCircle, Save, BarChart3, Trash2, FolderOpen, Play, Square } from 'lucide-react';
import { bleLoggerLink } from '../services/bleLoggerLink';
import { useLoggerLink, useStatusLabel } from './BleLoggerCard';
import { LiveLapTimer, formatDelta, formatLapTime, type LiveFix, type LiveLapEvent, type LiveLapState } from '../services/liveLapTimer';
import { CIRCUIT_PRESETS, findMatchingCircuit } from '../services/circuitDatabase';
import { triggerFileDownload } from '../services/nmeaExporter';
import { downloadBlob } from '../services/telemetryVideoExporter';
import { LiveRunRecorder } from '../services/runRecorder';
import { courseFolder } from '../utils/courseNames';
import { LapHistoryPanel } from './LapHistoryPanel';
import { useLapDevices } from '../hooks/useLapDevices';
import { deleteRun, listRuns, loadFixes, type RunMeta } from '../services/liveRunStore';
import { fixesToBon4, fixesToNmea, runFileBase } from '../services/runFiles';
import { callNative, hasNative, toBase64 } from '../native/bridge';
import type { StorageInfo } from '../native/contract';
import { canUseLoggerBle } from '../utils/device';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { OrientationToggle, StopConfirm, loadTimerOrientation, saveTimerOrientation, type TimerOrientation } from './LapTimerControls';
import { circuitLabel, getLang, useT } from '../utils/i18n';
import type { CircuitPreset, TelemetryPoint } from '../types/telemetry';

/** 走っている間に、記録を保存する間隔 (ミリ秒) */
/** 選んだフォルダへ写す、走っている間の最短の間隔 */
const SYNC_INTERVAL_MS = 3 * 60 * 1000;
const SAVE_INTERVAL_MS = 2000;

/**
 * 走りながら使うラップタイマーの画面 (暫定の版。docs/iphone_app_design.md の 5)。
 * 大きな数字で、今の周の経過とベストとの差を出し、周を終えたらタイムと差を数秒大きく出して声でも知らせる。
 * 測位の出どころ: デジスパイス (Bluetooth、20 Hz)・この端末の GPS (1 Hz 前後)・読み込んだログの再生 (試すため)
 */

type Source = 'digspice' | 'phone' | 'replay' | 'racebox';

export interface ReplayLog {
  id: string;
  name: string;
  points: TelemetryPoint[];
  startDate?: Date;
}

interface Props {
  onClose: () => void;
  /** 再生で試せるログ (読み込んだ走行) */
  replayLogs: ReplayLog[];
  /** 記録した測位を、解析の画面で開く (NMEA の文) */
  onOpenLog: (fileName: string, nmeaText: string) => void;
  /** ラップタイムの記録から、走行のファイル (.bon4) を解析で開く */
  onOpenFile?: (file: File) => void;
}

/** 周を終えたあと、そのタイムを大きく出しておく長さ (ミリ秒) */
const FLASH_MS = 6000;
/** 測位が来なくなってから、経過を進め続ける長さ (秒)。途切れの間に経過が止まって見えないように */
const EXTRAPOLATE_SEC = 1;

const presetsWithLine = CIRCUIT_PRESETS.filter(c => c.controlLine);

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * cosLat * 111.32, (lat2 - lat1) * 111.32);
}

/** 差の色 (速いと緑、遅いと赤) */
function deltaClass(d: number | null | undefined): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return 'text-white/60';
  if (d < -0.005) return 'text-emerald-400';
  if (d > 0.005) return 'text-red-400';
  return 'text-white';
}

/** 声で知らせる */
function speak(text: string, lang: string): void {
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

function lapSpeech(e: LiveLapEvent): { text: string; lang: string } {
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

export const LapTimerScreen: React.FC<Props> = ({ onClose, replayLogs, onOpenLog, onOpenFile }) => {
  const t = useT();
  const link = useLoggerLink();
  const statusLabel = useStatusLabel();
  const [source, setSource] = useState<Source>(() => (canUseLoggerBle ? 'digspice' : replayLogs.length > 0 ? 'replay' : 'phone'));
  const [course, setCourse] = useState<CircuitPreset | null>(null);
  const [state, setState] = useState<LiveLapState | null>(null);
  const [flash, setFlash] = useState<{ event: LiveLapEvent; until: number } | null>(null);
  const [voice, setVoice] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  // 測っているか (測定開始のボタンを押してから、測定終了まで)。測っていない間は、位置と速度を出すだけで、周を数えず記録もしない (2026-10-20)
  const [measuring, setMeasuring] = useState(false);
  const measuringRef = useRef(false);
  // 測定終了の確認 (全画面) を出しているか
  const [confirmStop, setConfirmStop] = useState(false);
  // 画面の向き (アプリだけ。測る前に選び、測っている間は固める)
  const [orientation, setOrientation] = useState<TimerOrientation>(loadTimerOrientation);
  const [coursePicker, setCoursePicker] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const [phoneInfo, setPhoneInfo] = useState<{ accuracy: number | null; error: string | null }>({ accuracy: null, error: null });
  const [replayId, setReplayId] = useState(() => replayLogs[0]?.id ?? '');
  const [replaySpeed, setReplaySpeed] = useState(4);
  const [wakeLockOk, setWakeLockOk] = useState<boolean | null>(null);

  const timerRef = useRef<LiveLapTimer | null>(null);
  const courseRef = useRef<CircuitPreset | null>(null);
  const fixesRef = useRef<LiveFix[]>([]);
  /** 走っている間の記録 (runRecorder.ts)。ログの再生では作らない */
  const recorderRef = useRef<LiveRunRecorder | null>(null);
  const sourceRef = useRef<Source>('digspice');
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 記録の保管先 (アプリのみ) と、選んだフォルダへ最後に写した結果 */
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [syncNote, setSyncNote] = useState<{ ok: boolean; text: string } | null>(null);
  const lastSyncMsRef = useRef(0);
  /** 登録した Bluetooth LE の機器 (RaceBox・センサー・カメラ)。測位は handleFix へ (後で決まるので ref を通す) */
  const handleFixRef = useRef<(fix: LiveFix) => void>(() => {});
  const lapDevices = useLapDevices({
    useRacebox: source === 'racebox',
    onFix: f => handleFixRef.current(f),
    runBase: () => recorderRef.current?.current?.fileBase ?? null
  });
  const lapDevicesRef = useRef(lapDevices);
  lapDevicesRef.current = lapDevices;
  /** ラップタイムの記録 (過去の周の一覧) を開いているか */
  const [historyOpen, setHistoryOpen] = useState(false);
  const lastFixPerfRef = useRef(0);
  const lastPosRef = useRef<LiveFix | null>(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  /** 利用者がコースを選んだ (自動で選び直さない) */
  const manualCourseRef = useRef(false);
  /** iPhone の GPS の前の測位 (速さが来ないときに、位置から求める) */
  const prevPhoneRef = useRef<LiveFix | null>(null);
  /** 出した経過 (同じ周の間は戻さない。測位がまとめて届いたときに、表示が戻って見えないように) */
  const shownElapsedRef = useRef<{ lapStartMs: number | null; value: number }>({ lapStartMs: null, value: 0 });

  // Esc で、開いている選ぶ画面・メニュー・ラップタイマーの順に閉じる (開いている間は、後ろの画面の再生のキーは効かない)
  useEscapeKey(true, onClose);
  useEscapeKey(menuOpen, () => setMenuOpen(false));
  useEscapeKey(coursePicker, () => setCoursePicker(false));

  /** コースを決める。replay なら、それまでに届いた測位を新しいコースで数え直す (声は出さない) */
  const chooseCourse = useCallback((c: CircuitPreset | null, replay = false) => {
    courseRef.current = c;
    setCourse(c);
    const timer = c?.controlLine ? new LiveLapTimer({ controlLine: c.controlLine, sectors: c.sectors }) : null;
    // 届いた測位で数え直すのは、測っている間とログの再生だけ (測定開始を押す前の測位では周を数えない)
    if (timer && replay && (measuringRef.current || sourceRef.current === 'replay')) fixesRef.current.forEach(f => timer.push(f));
    timerRef.current = timer;
    setState(timer?.getState() ?? null);
    setFlash(null);
  }, []);

  /**
   * 自動で選んだコースを、周を数える前は、届いた測位で選び直す (同じ敷地に計測線の違うコースがあるとき、
   * 測位の所に近いだけのコースではなく、計測線を横切ったコースにする。筑波 2000 / 1000 など)
   */
  const recheckCourse = useCallback(() => {
    const all = fixesRef.current;
    const last = all[all.length - 1];
    const cur = courseRef.current;
    if (!last || !cur || manualCourseRef.current || (timerRef.current?.getState().laps.length ?? 0) > 0) return;
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
    if (found?.controlLine && found.id !== courseRef.current?.id && distanceKm(last.latitude, last.longitude, found.centerLat, found.centerLon) < 5) {
      chooseCourse(found, true);
    }
  }, [chooseCourse]);

  /** ためた測位を保存する (周の数とベストも一緒に) */
  const flushRecording = useCallback((force = false): Promise<void> => {
    const rec = recorderRef.current;
    if (!rec) return Promise.resolve();
    const st = timerRef.current?.getState();
    // センサーの値の .csv も一緒に書く
    lapDevicesRef.current.flush();
    return rec.flush({ lapCount: st?.laps.length ?? 0, bestLapSec: st?.best?.timeSec ?? null }, force);
  }, []);

  /**
   * 保管先に選んだフォルダ (iCloud Drive など) へ、LapTimer/ のファイルを写す (アプリのみ。保管先が この iPhone なら何もしない)。
   * 裏に回ったとき・閉じたとき・周を数え直したとき・周を終えたとき (3 分に 1 回まで) に呼ぶ
   */
  const syncStorage = useCallback(async (): Promise<void> => {
    lastSyncMsRef.current = Date.now();
    // 閉じる・裏に回る・数え直すときは、コースを待っている途中の測位も保存する (ブラウザ版も)
    await flushRecording(true);
    if (!hasNative()) return;
    try {
      const r = await callNative('system.syncLapFiles', {});
      if (r.kind !== 'folder') return;
      if (r.failed > 0) setSyncNote({ ok: false, text: r.error ?? `${r.failed}` });
      else if (r.copied > 0) setSyncNote({ ok: true, text: `${r.copied}` });
    } catch (e) {
      setSyncNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }, [flushRecording]);
  const syncRef = useRef(syncStorage);
  syncRef.current = syncStorage;

  /** 測位を 1 つ受け取る (出どころによらず同じ) */
  const handleFix = useCallback((fix: LiveFix) => {
    if (!fix.valid) return;
    lastPosRef.current = fix;
    lastFixPerfRef.current = performance.now();
    fixesRef.current.push(fix);
    // 画面で持つのは直近の 10 分ほど (コースの選び直しに使うだけ。走った測位は全部、記録の保存先にある)。
    // 測る前は少なめにする (長く待っても、コースの選び直し (4800 点まで) が止まらないように)
    if (fixesRef.current.length > (measuringRef.current ? 12000 : 4000)) fixesRef.current.splice(0, 2000);
    // コースを決めていなければ、初めの測位の所で選ぶ。周を数える前は、ときどき選び直す
    if (!courseRef.current) {
      const found = findMatchingCircuit(fix.latitude, fix.longitude);
      if (found?.controlLine && distanceKm(fix.latitude, fix.longitude, found.centerLat, found.centerLon) < 5) chooseCourse(found);
    } else if (fixesRef.current.length % 200 === 0 && fixesRef.current.length <= 4800) {
      recheckCourse();
    }
    // 測定開始を押すまでは、周を数えず記録もしない (ログの再生はいつも数える・記録しない)
    const src = sourceRef.current;
    if (src !== 'replay' && !measuringRef.current) return;
    // 走っている間の記録 (ログの再生は記録しない)
    if (src !== 'replay') {
      recorderRef.current ??= new LiveRunRecorder(src, () => courseRef.current?.name ?? '', m => setSaveError(m),
        () => (courseRef.current ? courseFolder(courseRef.current.name, courseRef.current.folder, courseRef.current.id) : ''));
      recorderRef.current.add(fix);
    }
    const timer = timerRef.current;
    if (!timer) return;
    const events = timer.push(fix);
    for (const e of events) {
      if (e.kind === 'lap') {
        setFlash({ event: e, until: performance.now() + FLASH_MS });
        // 周を終えたら、動画に印を付ける
        lapDevicesRef.current.lap();
        // 周を終えたら、すぐ保存する。選んだフォルダへは 3 分に 1 回まで写す
        void flushRecording();
        if (Date.now() - lastSyncMsRef.current > SYNC_INTERVAL_MS) void syncRef.current();
        if (voiceRef.current) {
          const s = lapSpeech(e);
          speak(s.text, s.lang);
        }
      }
    }
    // 表示は 0.1 秒ごとにまとめて描き直す (測位ごと (20 Hz) に描き直すと、車の中で端末が熱くなる)。周を終えたときだけすぐ
    if (events.length > 0) setState(timer.getState());
  }, [chooseCourse, recheckCourse]);
  handleFixRef.current = handleFix;

  /** 測定開始: 周をはじめから数え、次の測位から新しい走行のファイルに書く */
  const startMeasuring = useCallback(() => {
    measuringRef.current = true;
    setMeasuring(true);
    recorderRef.current = null;
    // カメラ (GoPro) の時計を合わせて録画を始める
    lapDevicesRef.current.startRun(new Date());
    // 押す前の測位で周を数えないよう、コースの選び直しに使う測位も捨てる
    fixesRef.current = [];
    shownElapsedRef.current = { lapStartMs: null, value: 0 };
    chooseCourse(courseRef.current);
  }, [chooseCourse]);

  /** 測定終了: 書いた走行を閉じて保存し、選んだフォルダへ写す。周の表示は次に測り始めるまで残す */
  const stopMeasuring = useCallback(async () => {
    if (!measuringRef.current) return;
    measuringRef.current = false;
    setMeasuring(false);
    // カメラの録画を止め、センサーの値を書き、次の走行の .csv に替える
    lapDevicesRef.current.stopRun();
    // 今の走行の記録を先に外してから保存する (保存の途中で測定開始を押しても、新しい走行の記録を消さないように)
    const rec = recorderRef.current;
    recorderRef.current = null;
    const st = timerRef.current?.getState();
    await rec?.flush({ lapCount: st?.laps.length ?? 0, bestLapSec: st?.best?.timeSec ?? null }, true);
    await syncRef.current();
  }, []);

  // 出どころを替えたら、測位と周をはじめからにする (コースはそのまま)。それまでの記録は保存して閉じ、次の測位から新しい走行にする
  const resetRun = useCallback(() => {
    // 録画を止め、センサーの .csv を次の走行に替える
    lapDevicesRef.current.stopRun();
    // それまでの記録を外して保存してから、写す (外す前に保存し終わらないと、最後の数秒が残らないため)
    const rec = recorderRef.current;
    recorderRef.current = null;
    const st = timerRef.current?.getState();
    void (rec ? rec.flush({ lapCount: st?.laps.length ?? 0, bestLapSec: st?.best?.timeSec ?? null }, true) : Promise.resolve()).then(() => syncRef.current());
    fixesRef.current = [];
    lastPosRef.current = null;
    prevPhoneRef.current = null;
    shownElapsedRef.current = { lapStartMs: null, value: 0 };
    chooseCourse(courseRef.current);
    // 測っている途中で出どころを替えたときは、新しい走行としてカメラの録画を始め直す
    if (measuringRef.current) lapDevicesRef.current.startRun(new Date());
  }, [chooseCourse]);

  // ---- 測位の出どころ ----
  useEffect(() => {
    resetRun();
    if (source === 'digspice') {
      // ラップタイマーを開いたのは使うつもりなので、切断ボタンで切っていてもつなぐ
      void bleLoggerLink.startAndConnect(true);
      return bleLoggerLink.onFix(fix => handleFix({
        tMs: fix.timestamp.getTime(),
        latitude: fix.latitude,
        longitude: fix.longitude,
        speedKmh: fix.speedKmh,
        altitude: fix.altitude,
        valid: fix.valid
      }));
    }
    if (source === 'phone') {
      if (!('geolocation' in navigator)) {
        setPhoneInfo({ accuracy: null, error: t('この端末では位置を使えません', 'Location is not available on this device') });
        return;
      }
      setPhoneInfo({ accuracy: null, error: null });
      const id = navigator.geolocation.watchPosition(
        pos => {
          setPhoneInfo({ accuracy: pos.coords.accuracy, error: null });
          // 速さが来ない (null・負) ときは、前の測位からの位置と時刻で求める (iPhone はよく来ない)
          const prev = prevPhoneRef.current;
          const reported = pos.coords.speed;
          let speedKmh = reported !== null && reported >= 0 ? reported * 3.6 : 0;
          if ((reported === null || reported < 0) && prev && pos.timestamp > prev.tMs) {
            speedKmh = (distanceKm(prev.latitude, prev.longitude, pos.coords.latitude, pos.coords.longitude) / ((pos.timestamp - prev.tMs) / 3600000));
          }
          const fix: LiveFix = {
            tMs: pos.timestamp,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            speedKmh,
            altitude: pos.coords.altitude ?? undefined,
            // 誤差の大きい測位 (屋内・測位の始め) は使わない
            valid: pos.coords.accuracy <= 30
          };
          if (fix.valid) prevPhoneRef.current = fix;
          handleFix(fix);
        },
        err => setPhoneInfo({
          accuracy: null,
          error: err.code === err.PERMISSION_DENIED
            ? t('位置の許可がありません (アプリでは、位置を使う設定の入った版に入れ直すと使えます)', 'Location permission denied (in the app, reinstall a build that includes location access)')
            : err.message
        }),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
      return () => navigator.geolocation.clearWatch(id);
    }
    // RaceBox の測位は、機器の部品 (useLapDevices) が handleFix へ渡す
    if (source === 'racebox') return;
    // ログの再生: 読み込んだ走行の点を、時刻のとおり (速さの倍率をかけて) 渡す
    const log = replayLogs.find(l => l.id === replayId);
    if (!log || log.points.length < 2) return;
    const base = log.startDate?.getTime() ?? Date.now();
    const pts = log.points;
    const startPerf = performance.now();
    const t0 = pts[0].time;
    let i = 0;
    const iv = setInterval(() => {
      const simTime = t0 + ((performance.now() - startPerf) / 1000) * replaySpeed;
      while (i < pts.length && pts[i].time <= simTime) {
        const p = pts[i];
        handleFix({ tMs: base + p.time * 1000, latitude: p.latitude, longitude: p.longitude, speedKmh: p.speed, altitude: p.altitude, valid: true });
        i++;
      }
      if (i >= pts.length) clearInterval(iv);
    }, 50);
    return () => clearInterval(iv);
    // replayLogs は、開いている間は変わらない前提 (変わっても再生中のログは続ける)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, replayId, replaySpeed, handleFix, resetRun]);

  sourceRef.current = source;

  // ---- 走っている間の記録を、2 秒ごと・裏に回ったとき・閉じたときに保存する ----
  useEffect(() => {
    const iv = setInterval(() => { void flushRecording(); }, SAVE_INTERVAL_MS);
    const onHide = () => { if (document.visibilityState === 'hidden') void syncRef.current(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      void syncRef.current();
    };
  }, [flushRecording]);

  // ---- 経過を進める (測位の間も、表示の時計で滑らかに) ----
  useEffect(() => {
    const iv = setInterval(() => {
      setNow(performance.now());
      setState(timerRef.current?.getState() ?? null);
    }, 100);
    return () => clearInterval(iv);
  }, []);

  // 測っていないときは、終了の確認を出さない (出どころを替えたときなど)
  useEffect(() => { if (!measuring) setConfirmStop(false); }, [measuring]);
  const cancelStop = useCallback(() => setConfirmStop(false), []);
  const confirmStopYes = useCallback(() => { setConfirmStop(false); void stopMeasuring(); }, [stopMeasuring]);

  // ---- 画面の向き (アプリ) ----
  // 測っている間は今の向きに固める (コーナーの横 G で向きが変わらないように)。閉じたらふつうに戻す。前のアプリは not-supported を返すので何もしない
  useEffect(() => {
    if (!hasNative()) return;
    void callNative('system.setOrientation', { mode: measuring ? 'hold' : orientation }).catch(() => {});
  }, [measuring, orientation]);
  useEffect(() => () => {
    if (hasNative()) void callNative('system.setOrientation', { mode: 'system' }).catch(() => {});
  }, []);
  const changeOrientation = useCallback((v: TimerOrientation) => { setOrientation(v); saveTimerOrientation(v); }, []);

  // ---- 画面を消さない ----
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    let nativeOn = false;
    const request = async () => {
      // iPhone のアプリ: 画面の自動ロックを止める (isIdleTimerDisabled)。古いアプリは not-supported を返すので、下の Wake Lock にする
      if (hasNative()) {
        try {
          await callNative('system.keepAwake', { on: true });
          // 頼んでいる間に閉じたら、すぐ戻す
          if (cancelled) { void callNative('system.keepAwake', { on: false }).catch(() => {}); return; }
          nativeOn = true;
          setWakeLockOk(true);
          return;
        } catch {
          // 下へ
        }
      }
      try {
        const wl = (navigator as unknown as { wakeLock?: { request: (k: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (!wl) { setWakeLockOk(false); return; }
        lock = await wl.request('screen');
        if (cancelled) { void lock.release(); return; }
        setWakeLockOk(true);
      } catch {
        setWakeLockOk(false);
      }
    };
    void request();
    // ほかのアプリから戻ったときに、もう一度頼む (隠れると外れる)
    const onVisible = () => { if (document.visibilityState === 'visible') void request(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
      if (nativeOn) void callNative('system.keepAwake', { on: false }).catch(() => {});
    };
  }, []);

  // ---- 表示する値 ----
  const sincePerf = (now - lastFixPerfRef.current) / 1000;
  const lastFix = state?.lastFix ?? lastPosRef.current;
  const rawElapsed = state?.lapStartMs != null && state.lastFix
    ? (state.lastFix.tMs - state.lapStartMs) / 1000 + Math.min(EXTRAPOLATE_SEC, Math.max(0, sincePerf)) * (source === 'replay' ? replaySpeed : 1)
    : null;
  // 同じ周の間は、出した経過より戻さない
  let elapsed = rawElapsed;
  if (rawElapsed !== null && state) {
    const shown = shownElapsedRef.current;
    if (shown.lapStartMs === state.lapStartMs) elapsed = Math.max(shown.value, rawElapsed);
    shownElapsedRef.current = { lapStartMs: state.lapStartMs, value: elapsed! };
  }
  const flashing = flash && now < flash.until ? flash.event : null;
  const lastLap = state?.laps[state.laps.length - 1] ?? null;
  const prevBestForLast = useMemo(() => {
    if (!state || state.laps.length < 2) return null;
    const before = state.laps.slice(0, -1);
    return Math.min(...before.map(l => l.timeSec));
  }, [state]);
  const lastDiff = lastLap && prevBestForLast !== null ? lastLap.timeSec - prevBestForLast : null;

  // 出どころの状態
  const sourceStatus = (() => {
    if (source === 'digspice') {
      const ok = link.status === 'fixing';
      return { ok, text: link.status === 'none' ? t('デジスパイスを登録してください (ロガー設定)', 'Register a DigSpice (Logger settings)') : statusLabel(link.status, link.rateHz) };
    }
    if (source === 'racebox') {
      const st = lapDevices.statuses.find(x => x.device.kind === 'racebox');
      return { ok: !!st?.ok, text: st ? `${st.device.displayName}: ${st.state}${st.text ? ` · ${st.text}` : ''}` : t('RaceBox を登録してください (ロガー設定)', 'Register a RaceBox (Logger settings)') };
    }
    if (source === 'phone') {
      if (phoneInfo.error) return { ok: false, text: phoneInfo.error };
      const acc = phoneInfo.accuracy;
      return { ok: acc !== null && acc <= 30, text: acc === null ? t('iPhone の GPS: 測位待ち', 'Phone GPS: waiting') : t(`iPhone の GPS ±${Math.round(acc)} m (1 Hz 前後・粗い)`, `Phone GPS ±${Math.round(acc)} m (~1 Hz, coarse)`) };
    }
    const log = replayLogs.find(l => l.id === replayId);
    return { ok: !!log, text: log ? t(`ログの再生 ×${replaySpeed}: ${log.name}`, `Replay ×${replaySpeed}: ${log.name}`) : t('再生するログがありません', 'No log to replay') };
  })();

  const nearbyCourses = useMemo(() => {
    const p = lastPosRef.current;
    const list = presetsWithLine.map(c => ({ c, d: p ? distanceKm(p.latitude, p.longitude, c.centerLat, c.centerLon) : Infinity }));
    return list.sort((a, b) => a.d - b.d || a.c.name.localeCompare(b.c.name));
    // 開いたときの位置で並べる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coursePicker]);

  // ---- 走行の記録の一覧 (メニューを開いたときに読む) ----
  const refreshRuns = useCallback(async () => {
    await flushRecording();
    try {
      setRuns(await listRuns());
    } catch {
      setRuns([]);
    }
  }, [flushRecording]);
  useEffect(() => { if (menuOpen) void refreshRuns(); }, [menuOpen, refreshRuns]);
  // 保管先は、メニューを開いたときに読む (アプリのみ。前のアプリは知らないので出さない)
  useEffect(() => {
    if (!menuOpen || !hasNative()) return;
    callNative('system.storageInfo', {}).then(setStorage, () => setStorage(null));
  }, [menuOpen]);

  const chooseStorage = async (kind: 'local' | 'folder') => {
    try {
      const info = kind === 'folder' ? await callNative('system.pickStorageFolder', {}) : await callNative('system.setStorageLocal', {});
      setStorage(info);
      setSyncNote(null);
      if (info.kind === 'folder') await syncStorage();
    } catch (e) {
      // フォルダを選ぶのをやめたときは何もしない
      const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
      if (msg !== 'cancelled') setSyncNote({ ok: false, text: msg });
    }
  };

  /** 走行を解析で開く・NMEA / bon4 で保存する・消す */
  const runAction = async (run: RunMeta, action: 'open' | 'nmea' | 'bon4' | 'delete') => {
    if (action === 'delete') {
      if (!window.confirm(t('この走行の記録を消しますか? (「ファイル」アプリに書いたファイルは残ります)', 'Delete this run? (Files written to the Files app are kept)'))) return;
      if (recorderRef.current?.current?.id === run.id) recorderRef.current = null;
      await deleteRun(run.id);
      await refreshRuns();
      return;
    }
    await flushRecording();
    // アプリで書いたファイルがあれば、それを渡す (走っている間に書き足したもの)
    if (action !== 'open' && hasNative() && run.fileBase) {
      try { await callNative('system.shareFile', { path: `${run.fileBase}.${action}` }); return; } catch { /* 下で作り直す */ }
    }
    const fixes = await loadFixes(run.id);
    if (fixes.length < 2) return;
    const base = runFileBase(run.startedMs);
    if (action === 'open') { onOpenLog(`${base}.nmea`, fixesToNmea(fixes)); return; }
    const bytes = action === 'nmea' ? new TextEncoder().encode(fixesToNmea(fixes)) : fixesToBon4(fixes);
    if (hasNative()) {
      // アプリでは、データベースの記録からファイルを作って共有の画面で渡す (WKWebView ではダウンロードできないため)
      try {
        const path = `exports/${base}.${action}`;
        await callNative('system.appendFile', { path, b64: toBase64(bytes), truncate: true });
        await callNative('system.shareFile', { path });
        return;
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    if (action === 'nmea') triggerFileDownload(`${base}.nmea`, new TextDecoder().decode(bytes), 'text/plain');
    else downloadBlob(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), `${base}.bon4`);
  };

  const sectorCount = state?.sectorCount ?? 0;
  const bestSectors = state?.referenceSectorsSec ?? [];

  return (
    <div
      className="fixed inset-0 z-[90] bg-black text-white flex flex-col select-none"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
      data-testid="lap-timer"
    >
      {/* 上の段: 出どころの状態・コース・声・メニュー・閉じる */}
      <header className="flex items-center gap-2 px-3 py-2 text-xs sm:text-sm shrink-0 min-w-0">
        <button
          type="button"
          // デジスパイスにつないでいないときは、押すとつなぐ
          onClick={() => { if (source === 'digspice' && link.status === 'idle') void bleLoggerLink.connect(); else setMenuOpen(o => !o); }}
          // 幅が足りないときは、こちら (出どころの状態) を縮める (コースのボタンが「コ…」にならないように)
          className={`flex items-center gap-1 px-2 py-1 rounded-full border whitespace-nowrap overflow-hidden text-ellipsis min-w-0 ${sourceStatus.ok ? 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10' : 'border-amber-500/50 text-amber-300 bg-amber-500/10'}`}
          data-testid="lap-timer-source"
        >
          {source === 'digspice' ? <Bluetooth size={14} className="shrink-0" /> : source === 'phone' ? <Smartphone size={14} className="shrink-0" /> : <PlayCircle size={14} className="shrink-0" />}
          <span className="truncate">{sourceStatus.text}{source === 'digspice' && link.status === 'idle' ? t(' (押すとつなぐ)', ' (tap to connect)') : ''}</span>
        </button>
        <button onClick={() => setCoursePicker(true)} className="flex items-center gap-1 px-2 py-1 rounded-full border border-white/20 text-white/80 whitespace-nowrap shrink-0 max-w-[40vw]" data-testid="lap-timer-course">
          <MapPin size={14} className="shrink-0" />
          <span className="truncate">{course ? circuitLabel(course.name) : t('コース: 自動', 'Course: auto')}</span>
        </button>
        {/* 右のボタンの並びは右に寄せる (余った幅は出どころの状態の表示に回す) */}
        {wakeLockOk === false && (
          <span className="ml-auto text-amber-300/80 text-[11px] leading-tight max-w-[30vw]" data-testid="lap-timer-wake-warning">
            {t('画面が消えます: 設定の自動ロックを「なし」に', 'Screen may sleep: set Auto-Lock to Never')}
          </span>
        )}
        <button onClick={() => setVoice(v => !v)} className={`p-2 rounded-full border border-white/20 shrink-0 ${wakeLockOk === false ? '' : 'ml-auto'}`} aria-label={voice ? t('声を止める', 'Mute voice') : t('声で知らせる', 'Voice on')} title={voice ? t('声を止める', 'Mute voice') : t('声で知らせる', 'Voice on')}>
          {voice ? <Volume2 size={18} /> : <VolumeX size={18} className="text-white/50" />}
        </button>
        <button onClick={() => setMenuOpen(o => !o)} className="p-2 rounded-full border border-white/20 shrink-0" aria-label={t('メニュー', 'Menu')} title={t('メニュー', 'Menu')}>
          <Menu size={18} />
        </button>
        <button onClick={onClose} className="p-2 rounded-full border border-white/20 shrink-0" aria-label={t('閉じる', 'Close')} title={t('閉じる', 'Close')} data-testid="lap-timer-close">
          <X size={18} />
        </button>
      </header>

      {/* 真ん中: 大きな数字 */}
      {/* センサー・カメラの様子 (登録した機器があるときだけ) */}
      {lapDevices.statuses.some(x => x.device.kind !== 'racebox') && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-1 text-[11px]" data-testid="lap-timer-devices">
          {lapDevices.statuses.filter(x => x.device.kind !== 'racebox').map(x => (
            <span key={x.device.id} className={`px-2 py-0.5 rounded-full border ${x.ok ? 'border-emerald-500/60 text-emerald-300' : 'border-amber-500/60 text-amber-300'}`}>
              {x.device.displayName}{x.text ? ` · ${x.text}` : ` · ${x.state}`}
            </span>
          ))}
        </div>
      )}
      <main className="flex-1 min-h-0 flex flex-col landscape:flex-row items-stretch gap-2 px-3 pb-3">
        <section className="flex-1 min-w-0 min-h-0 flex flex-col items-center justify-center" data-testid="lap-timer-main">
          {!measuring && source !== 'replay' ? (
            <div className="text-center space-y-2" data-testid="lap-timer-idle">
              <div className="font-bold" style={{ fontSize: 'min(7vw, 9vh)' }}>{course ? circuitLabel(course.name) : t('コースを決めています', 'Finding the course')}</div>
              <div className="font-mono text-white/70 tabular-nums" style={{ fontSize: 'min(9vw, 12vh)' }}>
                {lastFix ? `${Math.round(lastFix.speedKmh)} km/h` : '--- km/h'}
              </div>
              <div className="text-white/60 text-sm">{t('下の「測定開始」を押すと、周を数えて記録します', 'Tap Start below to time laps and record')}</div>
            </div>
          ) : !course ? (
            <div className="text-center space-y-3">
              <div className="text-2xl font-bold">{t('コースを決めています', 'Finding the course')}</div>
              <div className="text-white/60 text-sm">{t('測位が届くと、近くのコースを選びます。違うときは上のコースを押して選んでください。', 'The nearest course is chosen when GPS arrives. Tap the course above to change it.')}</div>
            </div>
          ) : flashing ? (
            <>
              <div className="text-white/70 font-bold tracking-widest" style={{ fontSize: 'min(5vw, 6vh)' }}>
                {t(`${flashing.lap.number} 周目`, `LAP ${flashing.lap.number}`)}{flashing.isBest && flashing.diffToBestSec !== null ? ` · ${t('ベスト', 'BEST')}` : ''}
              </div>
              <div className="font-mono font-bold tabular-nums leading-none" style={{ fontSize: 'min(19vw, 30vh)' }} data-testid="lap-timer-flash">
                {formatLapTime(flashing.lap.timeSec, 2)}
              </div>
              <div className={`font-mono font-bold tabular-nums leading-tight ${deltaClass(flashing.diffToBestSec)}`} style={{ fontSize: 'min(11vw, 16vh)' }}>
                {flashing.diffToBestSec === null ? '' : formatDelta(flashing.diffToBestSec)}
              </div>
            </>
          ) : state?.lapNumber == null ? (
            <div className="text-center space-y-2">
              <div className="font-bold" style={{ fontSize: 'min(7vw, 9vh)' }}>{t('計測線を待っています', 'Waiting for the line')}</div>
              <div className="font-mono text-white/70 tabular-nums" style={{ fontSize: 'min(9vw, 12vh)' }}>
                {lastFix ? `${Math.round(lastFix.speedKmh)} km/h` : '--- km/h'}
              </div>
            </div>
          ) : (
            <>
              <div className="text-white/60 font-bold tracking-widest" style={{ fontSize: 'min(5vw, 6vh)' }}>
                {t(`${state.lapNumber} 周目`, `LAP ${state.lapNumber}`)}
              </div>
              <div className="font-mono font-bold tabular-nums leading-none" style={{ fontSize: 'min(19vw, 30vh)' }} data-testid="lap-timer-elapsed">
                {elapsed !== null ? formatLapTime(elapsed, 1) : '--:--'}
              </div>
              <div className={`font-mono font-bold tabular-nums leading-tight ${deltaClass(state.deltaSec)}`} style={{ fontSize: 'min(11vw, 16vh)' }} data-testid="lap-timer-delta">
                {state.deltaSec !== null ? formatDelta(state.deltaSec) : ' '}
              </div>
            </>
          )}
        </section>

        {/* 横: 前の周・ベスト・セクター・速度 */}
        <aside className="shrink-0 landscape:w-[34vw] grid grid-cols-2 landscape:grid-cols-1 gap-2 content-center font-mono tabular-nums">
          <div className="rounded-xl bg-white/5 px-3 py-2">
            <div className="text-[11px] text-white/50 font-sans">{t('前の周', 'Last')}</div>
            <div className="text-2xl sm:text-3xl font-bold">{lastLap ? formatLapTime(lastLap.timeSec, 2) : '--:--'}</div>
            <div className={`text-lg ${deltaClass(lastDiff)}`}>{lastDiff !== null ? formatDelta(lastDiff) : ' '}</div>
          </div>
          <div className="rounded-xl bg-white/5 px-3 py-2">
            <div className="text-[11px] text-white/50 font-sans">{t('ベスト', 'Best')}{state?.best ? ` (${t(`${state.best.number} 周目`, `L${state.best.number}`)})` : ''}</div>
            <div className="text-2xl sm:text-3xl font-bold text-amber-300">{state?.best ? formatLapTime(state.best.timeSec, 2) : '--:--'}</div>
            <div className="text-lg text-white/60"><span className="text-[11px] font-sans text-white/40 mr-1">{t('速度', 'Speed')}</span>{lastFix ? `${Math.round(lastFix.speedKmh)} km/h` : '---'}</div>
          </div>
          {sectorCount > 0 && (
            <div className="col-span-2 landscape:col-span-1 rounded-xl bg-white/5 px-3 py-2 flex gap-2" data-testid="lap-timer-sectors">
              {Array.from({ length: sectorCount }, (_, i) => {
                // 周を終えて大きく出している間は、終えた周のセクターを出しておく
                const cur = flashing
                  ? (flashing.lap.sectorsSec[i] !== undefined ? { timeSec: flashing.lap.sectorsSec[i], diffSec: null } : undefined)
                  : state?.currentSectors[i];
                return (
                  <div key={i} className="flex-1 min-w-0">
                    <div className="text-[11px] text-white/50 font-sans">S{i + 1}</div>
                    <div className="text-base sm:text-lg">{cur ? (Number.isFinite(cur.timeSec) ? cur.timeSec.toFixed(2) : '--') : bestSectors[i] !== undefined ? <span className="text-white/30">{bestSectors[i].toFixed(2)}</span> : '--'}</div>
                    <div className={`text-sm ${deltaClass(cur?.diffSec)}`}>{cur && cur.diffSec !== null ? formatDelta(cur.diffSec) : ' '}</div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </main>

      {/* 測定開始 / 測定終了 (ログの再生のときは出さない) */}
      {source !== 'replay' && (
        <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-3">
          {/* 画面の向きは測る前だけ (アプリのみ) */}
          {!measuring && hasNative() && <OrientationToggle value={orientation} onChange={changeOrientation} />}
          <button
            onClick={() => {
              if (!measuring) startMeasuring();
              // 走っている間に誤って押しても止まらないよう、終了は全画面で確かめる
              else setConfirmStop(true);
            }}
            className={`w-full flex items-center justify-center gap-3 rounded-2xl font-bold ${measuring ? 'min-h-[72px] landscape:min-h-[56px] text-2xl border-[3px] border-red-500 text-red-300 active:bg-red-900/40' : 'min-h-[88px] landscape:min-h-[64px] text-3xl bg-emerald-600 active:bg-emerald-700'}`}
            data-testid="lap-timer-start-stop"
          >
            {measuring ? <><Square size={24} fill="currentColor" />{t('測定終了', 'Stop')}</> : <><Play size={28} fill="currentColor" />{t('測定開始', 'Start')}</>}
          </button>
        </div>
      )}
      {confirmStop && measuring && (
        <StopConfirm lapCount={state?.laps.length ?? 0} onYes={confirmStopYes} onNo={cancelStop} />
      )}

      {/* メニュー: 出どころ・再生の設定・記録 */}
      {/* メニューの外を押したら閉じる (透明な受け皿をメニューの後ろに敷く) */}
      {menuOpen && <div className="absolute inset-0 z-[9]" onClick={() => setMenuOpen(false)} aria-hidden="true" data-testid="lap-timer-menu-backdrop" />}
      {menuOpen && (
        <div className="absolute right-2 top-14 z-10 w-[min(92vw,360px)] max-h-[80vh] overflow-y-auto rounded-2xl bg-neutral-900 border border-white/15 p-3 space-y-3 text-sm shadow-2xl">
          <div>
            <div className="text-white/50 text-xs mb-1">{t('測位の出どころ', 'Position source')}</div>
            <div className="grid grid-cols-1 gap-1">
              {canUseLoggerBle && (
                <button onClick={() => { setSource('digspice'); setMenuOpen(false); }} className={`text-left px-3 py-2 rounded-lg ${source === 'digspice' ? 'bg-red-600' : 'bg-white/5'}`}>
                  {t('デジスパイス (Bluetooth・20 Hz)', 'DigSpice (Bluetooth, 20 Hz)')}
                </button>
              )}
              {lapDevices.racebox && (
                <button onClick={() => { setSource('racebox'); setMenuOpen(false); }} className={`text-left px-3 py-2 rounded-lg ${source === 'racebox' ? 'bg-red-600' : 'bg-white/5'}`}>
                  {t(`RaceBox (${lapDevices.racebox.displayName}・25 Hz)`, `RaceBox (${lapDevices.racebox.displayName}, 25 Hz)`)}
                </button>
              )}
              <button onClick={() => { setSource('phone'); setMenuOpen(false); }} className={`text-left px-3 py-2 rounded-lg ${source === 'phone' ? 'bg-red-600' : 'bg-white/5'}`}>
                {t('この端末の GPS (1 Hz 前後・粗い)', 'This device GPS (~1 Hz, coarse)')}
              </button>
              <button onClick={() => { setSource('replay'); setMenuOpen(false); }} disabled={replayLogs.length === 0} className={`text-left px-3 py-2 rounded-lg disabled:opacity-40 ${source === 'replay' ? 'bg-red-600' : 'bg-white/5'}`}>
                {t('読み込んだログを再生して試す', 'Try with a loaded log (replay)')}
              </button>
            </div>
          </div>
          {source === 'replay' && replayLogs.length > 0 && (
            <div className="space-y-2">
              <select value={replayId} onChange={e => setReplayId(e.target.value)} className="w-full bg-white/5 rounded-lg px-2 py-2" aria-label={t('再生するログ', 'Log to replay')}>
                {replayLogs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <div className="flex gap-1">
                {[1, 4, 16].map(x => (
                  <button key={x} onClick={() => setReplaySpeed(x)} className={`flex-1 px-2 py-1.5 rounded-lg ${replaySpeed === x ? 'bg-red-600' : 'bg-white/5'}`}>×{x}</button>
                ))}
              </div>
            </div>
          )}
          <div data-testid="lap-timer-runs">
            <div className="text-white/50 text-xs mb-1">{t('走行の記録 (走っている間に 2 秒ごとに保存)', 'Runs (saved every 2 s while driving)')}</div>
            {saveError && <div className="text-amber-300 text-[11px] mb-1">{t(`保存でエラー: ${saveError}`, `Save error: ${saveError}`)}</div>}
            {runs.length === 0 ? (
              <div className="text-white/40 text-xs">{t('まだありません', 'None yet')}</div>
            ) : (
              <div className="space-y-1.5">
                {runs.slice(0, 20).map(r => {
                  const d = new Date(r.startedMs);
                  // 記録中 (または、たった今まで書いていた) の走行は消せない
                  const recording = recorderRef.current?.current?.id === r.id || Date.now() - r.updatedMs < 10000;
                  return (
                    <div key={r.id} className="rounded-lg bg-white/5 px-2.5 py-2">
                      <div className="flex items-baseline gap-2 text-xs">
                        <span className="font-mono">{`${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}</span>
                        <span className="truncate text-white/70 flex-1 min-w-0">{r.courseName ? circuitLabel(r.courseName) : '—'}</span>
                        {recording && <span className="text-red-400 text-[10px] whitespace-nowrap">{t('記録中', 'Recording')}</span>}
                      </div>
                      <div className="text-[11px] text-white/50 font-mono">
                        {t(`${r.lapCount} 周`, `${r.lapCount} laps`)}{r.bestLapSec !== null ? ` · ${t('ベスト', 'best')} ${formatLapTime(r.bestLapSec, 3)}` : ''}{` · ${Math.round(r.fixCount / 20 / 60) || '<1'} min`}
                      </div>
                      <div className="flex gap-1 mt-1.5">
                        <button onClick={() => { void runAction(r, 'open'); }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-white/10 text-xs"><BarChart3 size={12} />{t('解析', 'Analyse')}</button>
                        <button onClick={() => { void runAction(r, 'nmea'); }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-white/10 text-xs"><Save size={12} />NMEA</button>
                        <button onClick={() => { void runAction(r, 'bon4'); }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-white/10 text-xs"><Save size={12} />bon4</button>
                        <button onClick={() => { void runAction(r, 'delete'); }} disabled={recording} aria-label={t('消す', 'Delete')} title={t('消す', 'Delete')} className="px-2 py-1.5 rounded bg-white/5 text-white/60 disabled:opacity-30"><Trash2 size={12} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {hasNative() && (
              <p className="text-[10px] text-white/40 mt-1">{t('「ファイル」アプリの このiPhone内 → このアプリ → LapTimer → サーキット名 にも、走っている間に書いています (.nmea と .bon4)。', 'Also written while driving to Files → On My iPhone → this app → LapTimer → circuit name (.nmea and .bon4).')}</p>
            )}
          </div>
          {hasNative() && (
            <button onClick={() => { void flushRecording(true).then(() => { setHistoryOpen(true); setMenuOpen(false); }); }} className="w-full text-left px-3 py-2 rounded-lg bg-white/5" data-testid="lap-timer-history">
              {t('ラップタイムの記録 (過去の周の一覧)', 'Lap time records (past laps)')}
            </button>
          )}
          {hasNative() && storage && (
            <div data-testid="lap-timer-storage">
              <div className="text-white/50 text-xs mb-1">{t('記録の保管先', 'Where runs are kept')}</div>
              <div className="grid grid-cols-1 gap-1">
                <button onClick={() => { void chooseStorage('local'); }} className={`text-left px-3 py-2 rounded-lg ${storage.kind === 'local' ? 'bg-red-600' : 'bg-white/5'}`}>
                  {t('この iPhone', 'This iPhone')}
                </button>
                <button onClick={() => { void chooseStorage('folder'); }} className={`text-left px-3 py-2 rounded-lg flex items-center gap-2 ${storage.kind === 'folder' ? 'bg-red-600' : 'bg-white/5'}`}>
                  <FolderOpen size={14} className="shrink-0" />
                  <span className="truncate">
                    {storage.kind === 'folder' && storage.folderName
                      ? t(`フォルダ: ${storage.folderName} (選び直す)`, `Folder: ${storage.folderName} (change)`)
                      : t('フォルダを選ぶ (iCloud Drive など)', 'Choose a folder (iCloud Drive etc.)')}
                  </span>
                </button>
              </div>
              {syncNote && (
                <div className={`text-[11px] mt-1 ${syncNote.ok ? 'text-white/50' : 'text-amber-300'}`}>
                  {syncNote.ok ? t(`フォルダへ ${syncNote.text} 個のファイルを写しました`, `Copied ${syncNote.text} files to the folder`) : t(`フォルダへ写せませんでした: ${syncNote.text}`, `Could not copy to the folder: ${syncNote.text}`)}
                </div>
              )}
              <p className="text-[10px] text-white/40 mt-1">
                {t('走っている間は、いつもこの iPhone に書きます (電波がなくても消えないように)。フォルダを選ぶと、アプリを閉じたとき・裏に回したとき・周を数え直したとき (走っている間は 3 分に 1 回まで) に、フォルダ → サーキット名 へ写します。',
                  'While driving, runs are always written to this iPhone (so nothing is lost without signal). With a folder chosen, they are copied to folder → circuit name when the app is closed or sent to the background, when laps are reset, and at most every 3 minutes while driving.')}
              </p>
            </div>
          )}
          <button onClick={() => { resetRun(); setMenuOpen(false); }} className="w-full px-3 py-2 rounded-lg bg-white/5 text-white/70">
            {t('周をはじめから数える (新しい走行として記録する)', 'Reset laps (start a new run)')}
          </button>
          <p className="text-[11px] text-white/40 leading-relaxed">
            {t('走っている間は、画面を消さずに、このアプリを前に出しておいてください (画面が消えると周を数えません)。',
              'Keep the screen on and this app in front while driving (laps are not counted while the screen is off).')}
          </p>
        </div>
      )}

      {historyOpen && <LapHistoryPanel onClose={() => setHistoryOpen(false)} onOpenRun={onOpenFile} />}

      {/* コースを選ぶ */}
      {coursePicker && (
        <div className="absolute inset-0 z-20 bg-black/90 flex flex-col p-3" role="dialog" aria-label={t('コースを選ぶ', 'Choose course')}>
          <div className="flex items-center gap-2 mb-2">
            <div className="font-bold flex-1">{t('コースを選ぶ (近い順)', 'Choose course (nearest first)')}</div>
            <button onClick={() => setCoursePicker(false)} className="p-2 rounded-full border border-white/20" aria-label={t('閉じる', 'Close')}><X size={18} /></button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-1">
            <button onClick={() => { manualCourseRef.current = false; chooseCourse(null); setCoursePicker(false); }} className="w-full text-left px-3 py-2 rounded-lg bg-white/5">
              {t('自動 (測位の所の近くのコース)', 'Auto (nearest to GPS)')}
            </button>
            {nearbyCourses.map(({ c, d }) => (
              <button key={c.id} onClick={() => { manualCourseRef.current = true; chooseCourse(c, true); setCoursePicker(false); }} className={`w-full text-left px-3 py-2 rounded-lg ${course?.id === c.id ? 'bg-red-600' : 'bg-white/5'}`}>
                {circuitLabel(c.name)}{Number.isFinite(d) ? <span className="text-white/40 ml-2 text-xs">{d < 10 ? d.toFixed(1) : Math.round(d)} km</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
