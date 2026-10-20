import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Volume2, VolumeX, Menu, MapPin, Bluetooth, Smartphone, PlayCircle, Save, BarChart3 } from 'lucide-react';
import { bleLoggerLink } from '../services/bleLoggerLink';
import { useLoggerLink, useStatusLabel } from './BleLoggerCard';
import { LiveLapTimer, formatDelta, formatLapTime, type LiveFix, type LiveLapEvent, type LiveLapState } from '../services/liveLapTimer';
import { CIRCUIT_PRESETS, findMatchingCircuit } from '../services/circuitDatabase';
import { convertToNmea, type ConvertedPoint } from '../services/logConverter';
import { triggerFileDownload } from '../services/nmeaExporter';
import { callNative, hasNative } from '../native/bridge';
import { canUseLoggerBle } from '../utils/device';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { circuitLabel, getLang, useT } from '../utils/i18n';
import type { CircuitPreset, TelemetryPoint } from '../types/telemetry';

/**
 * 走りながら使うラップタイマーの画面 (暫定の版。docs/iphone_app_design.md の 5)。
 * 大きな数字で、今の周の経過とベストとの差を出し、周を終えたらタイムと差を数秒大きく出して声でも知らせる。
 * 測位の出どころ: デジスパイス (Bluetooth、20 Hz)・この端末の GPS (1 Hz 前後)・読み込んだログの再生 (試すため)
 */

type Source = 'digspice' | 'phone' | 'replay';

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

/** 記録した測位を、書き出しの形にする */
function toConvertedPoints(fixes: LiveFix[]): ConvertedPoint[] {
  const out: ConvertedPoint[] = [];
  let dist = 0;
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    const prev = fixes[i - 1];
    if (prev) dist += distanceKm(prev.latitude, prev.longitude, f.latitude, f.longitude);
    const next = fixes[i + 1] ?? f;
    const from = prev ?? f;
    const to = fixes[i + 1] ? next : f;
    const dLon = (to.longitude - from.longitude) * Math.cos((f.latitude * Math.PI) / 180);
    const dLat = to.latitude - from.latitude;
    const heading = dLon === 0 && dLat === 0 ? 0 : ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
    out.push({
      time: new Date(f.tMs),
      elapsed: (f.tMs - fixes[0].tMs) / 1000,
      latitude: f.latitude,
      longitude: f.longitude,
      altitude: f.altitude ?? null,
      speed: f.speedKmh,
      heading,
      satellites: null,
      distance: dist,
      source: undefined as unknown as TelemetryPoint
    });
  }
  return out;
}

export const LapTimerScreen: React.FC<Props> = ({ onClose, replayLogs, onOpenLog }) => {
  const t = useT();
  const link = useLoggerLink();
  const statusLabel = useStatusLabel();
  const [source, setSource] = useState<Source>(() => (canUseLoggerBle ? 'digspice' : replayLogs.length > 0 ? 'replay' : 'phone'));
  const [course, setCourse] = useState<CircuitPreset | null>(null);
  const [state, setState] = useState<LiveLapState | null>(null);
  const [flash, setFlash] = useState<{ event: LiveLapEvent; until: number } | null>(null);
  const [voice, setVoice] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [coursePicker, setCoursePicker] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const [phoneInfo, setPhoneInfo] = useState<{ accuracy: number | null; error: string | null }>({ accuracy: null, error: null });
  const [replayId, setReplayId] = useState(() => replayLogs[0]?.id ?? '');
  const [replaySpeed, setReplaySpeed] = useState(4);
  const [wakeLockOk, setWakeLockOk] = useState<boolean | null>(null);

  const timerRef = useRef<LiveLapTimer | null>(null);
  const courseRef = useRef<CircuitPreset | null>(null);
  const fixesRef = useRef<LiveFix[]>([]);
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
    if (timer && replay) fixesRef.current.forEach(f => timer.push(f));
    timerRef.current = timer;
    setState(timer?.getState() ?? null);
    setFlash(null);
  }, []);

  /**
   * 自動で選んだコースを、周を数える前は、届いた測位で選び直す (同じ敷地に計測線の違うコースがあるとき、
   * 測位の所に近いだけのコースではなく、計測線を横切ったコースにする。筑波 2000 / 1000 など)
   */
  const recheckCourse = useCallback(() => {
    const fixes = fixesRef.current;
    const last = fixes[fixes.length - 1];
    if (!last || manualCourseRef.current || (timerRef.current?.getState().laps.length ?? 0) > 0) return;
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

  /** 測位を 1 つ受け取る (出どころによらず同じ) */
  const handleFix = useCallback((fix: LiveFix) => {
    if (!fix.valid) return;
    lastPosRef.current = fix;
    lastFixPerfRef.current = performance.now();
    fixesRef.current.push(fix);
    // コースを決めていなければ、初めの測位の所で選ぶ。周を数える前は、ときどき選び直す
    if (!courseRef.current) {
      const found = findMatchingCircuit(fix.latitude, fix.longitude);
      if (found?.controlLine && distanceKm(fix.latitude, fix.longitude, found.centerLat, found.centerLon) < 5) chooseCourse(found);
    } else if (fixesRef.current.length % 200 === 0) {
      recheckCourse();
    }
    const timer = timerRef.current;
    if (!timer) return;
    const events = timer.push(fix);
    for (const e of events) {
      if (e.kind === 'lap') {
        setFlash({ event: e, until: performance.now() + FLASH_MS });
        if (voiceRef.current) {
          const s = lapSpeech(e);
          speak(s.text, s.lang);
        }
      }
    }
    // 表示は 0.1 秒ごとにまとめて描き直す (測位ごと (20 Hz) に描き直すと、車の中で端末が熱くなる)。周を終えたときだけすぐ
    if (events.length > 0) setState(timer.getState());
  }, [chooseCourse, recheckCourse]);

  // 出どころを替えたら、測位と周をはじめからにする (コースはそのまま)
  const resetRun = useCallback(() => {
    fixesRef.current = [];
    lastPosRef.current = null;
    prevPhoneRef.current = null;
    shownElapsedRef.current = { lapStartMs: null, value: 0 };
    chooseCourse(courseRef.current);
  }, [chooseCourse]);

  // ---- 測位の出どころ ----
  useEffect(() => {
    resetRun();
    if (source === 'digspice') {
      void bleLoggerLink.startAndConnect();
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

  // ---- 経過を進める (測位の間も、表示の時計で滑らかに) ----
  useEffect(() => {
    const iv = setInterval(() => {
      setNow(performance.now());
      setState(timerRef.current?.getState() ?? null);
    }, 100);
    return () => clearInterval(iv);
  }, []);

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
          nativeOn = true;
          if (!cancelled) setWakeLockOk(true);
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

  const saveLog = async (open: boolean) => {
    const fixes = fixesRef.current;
    if (fixes.length < 2) return;
    const d = new Date(fixes[0].tMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const name = `laptimer_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.nmea`;
    const text = convertToNmea(toConvertedPoints(fixes));
    if (open) { onOpenLog(name, text); return; }
    if (hasNative()) {
      try { await callNative('system.shareText', { fileName: name, text }); return; } catch { /* 下のダウンロードにする */ }
    }
    triggerFileDownload(name, text, 'text/plain');
  };

  const sectorCount = state?.sectorCount ?? 0;
  const bestSectors = state?.best?.sectorsSec ?? [];

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
          className={`flex items-center gap-1 px-2 py-1 rounded-full border whitespace-nowrap overflow-hidden text-ellipsis min-w-0 ${sourceStatus.ok ? 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10' : 'border-amber-500/50 text-amber-300 bg-amber-500/10'}`}
          data-testid="lap-timer-source"
        >
          {source === 'digspice' ? <Bluetooth size={14} className="shrink-0" /> : source === 'phone' ? <Smartphone size={14} className="shrink-0" /> : <PlayCircle size={14} className="shrink-0" />}
          <span className="truncate">{sourceStatus.text}{source === 'digspice' && link.status === 'idle' ? t(' (押すとつなぐ)', ' (tap to connect)') : ''}</span>
        </button>
        <button onClick={() => setCoursePicker(true)} className="flex items-center gap-1 px-2 py-1 rounded-full border border-white/20 text-white/80 whitespace-nowrap min-w-0" data-testid="lap-timer-course">
          <MapPin size={14} className="shrink-0" />
          <span className="truncate max-w-[40vw]">{course ? circuitLabel(course.name) : t('コース: 自動', 'Course: auto')}</span>
        </button>
        <div className="flex-1" />
        {wakeLockOk === false && (
          <span className="text-amber-300/80 text-[11px] leading-tight max-w-[30vw]" data-testid="lap-timer-wake-warning">
            {t('画面が消えます: 設定の自動ロックを「なし」に', 'Screen may sleep: set Auto-Lock to Never')}
          </span>
        )}
        <button onClick={() => setVoice(v => !v)} className="p-2 rounded-full border border-white/20" aria-label={voice ? t('声を止める', 'Mute voice') : t('声で知らせる', 'Voice on')} title={voice ? t('声を止める', 'Mute voice') : t('声で知らせる', 'Voice on')}>
          {voice ? <Volume2 size={18} /> : <VolumeX size={18} className="text-white/50" />}
        </button>
        <button onClick={() => setMenuOpen(o => !o)} className="p-2 rounded-full border border-white/20" aria-label={t('メニュー', 'Menu')} title={t('メニュー', 'Menu')}>
          <Menu size={18} />
        </button>
        <button onClick={onClose} className="p-2 rounded-full border border-white/20" aria-label={t('閉じる', 'Close')} title={t('閉じる', 'Close')} data-testid="lap-timer-close">
          <X size={18} />
        </button>
      </header>

      {/* 真ん中: 大きな数字 */}
      <main className="flex-1 min-h-0 flex flex-col landscape:flex-row items-stretch gap-2 px-3 pb-3">
        <section className="flex-1 min-w-0 min-h-0 flex flex-col items-center justify-center" data-testid="lap-timer-main">
          {!course ? (
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
                const cur = state?.currentSectors[i];
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

      {/* メニュー: 出どころ・再生の設定・記録 */}
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
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => { void saveLog(true); }} disabled={fixesRef.current.length < 2} className="flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40">
              <BarChart3 size={14} />{t('解析で開く', 'Analyse')}
            </button>
            <button onClick={() => { void saveLog(false); }} disabled={fixesRef.current.length < 2} className="flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-white/10 disabled:opacity-40">
              <Save size={14} />{t('保存 (NMEA)', 'Save (NMEA)')}
            </button>
          </div>
          <button onClick={() => { resetRun(); setMenuOpen(false); }} className="w-full px-3 py-2 rounded-lg bg-white/5 text-white/70">
            {t('周の記録をはじめからにする', 'Reset laps')}
          </button>
          <p className="text-[11px] text-white/40 leading-relaxed">
            {t('走っている間は、画面を消さずに、このアプリを前に出しておいてください (画面が消えると周を数えません)。',
              'Keep the screen on and this app in front while driving (laps are not counted while the screen is off).')}
          </p>
        </div>
      )}

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
