import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { X, Volume2, VolumeX, Menu, MapPin, Bluetooth, Smartphone, PlayCircle, Save, BarChart3, Trash2, Play, Square } from 'lucide-react';
import { useLoggerLink, useStatusLabel } from './BleLoggerCard';
import { formatDelta, formatLapTime } from '../services/liveLapTimer';
import { CIRCUIT_PRESETS } from '../services/circuitDatabase';
import { triggerFileDownload } from '../services/nmeaExporter';
import { downloadBlob } from '../services/telemetryVideoExporter';
import { LapHistoryPanel } from './LapHistoryPanel';
import { deleteRun, listRuns, loadFixes, type RunMeta } from '../services/liveRunStore';
import { fixesToBon4, fixesToNmea, runFileBase } from '../services/runFiles';
import { callNative, hasNative, toBase64 } from '../native/bridge';
import { canUseLoggerBle } from '../utils/device';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { getPositionSource } from '../services/positionSource';
import { navStore } from '../app/navStore';
import { distanceKm } from '../services/timer/positionFeeds';
import { TimerRuntime } from '../services/timer/timerRuntime';
import { OrientationToggle, StopConfirm, loadTimerOrientation, saveTimerOrientation, type TimerOrientation } from './LapTimerControls';
import { circuitLabel, getLang, useT } from '../utils/i18n';
import type { TelemetryPoint } from '../types/telemetry';

/**
 * 走りながら使うラップタイマーの画面 (暫定の版。docs/iphone_app_design.md の 5)。
 * 大きな数字で、今の周の経過とベストとの差を出し、周を終えたらタイムと差を数秒大きく出して声でも知らせる。
 * 測位の出どころ: デジスパイス (Bluetooth、20 Hz)・この端末の GPS (1 Hz 前後)・読み込んだログの再生 (試すため)
 */

type Source = 'digspice' | 'phone' | 'replay' | 'racebox' | 'drogger';

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
  /**
   * タブの 1 つとして出す (iPhone のアプリ)。閉じるボタンを出さず、測っていない間は画面の中 (タブバーの上) に収める。
   * 測っている間は、これまでどおり画面いっぱい (タブバーも隠す)
   */
  embedded?: boolean;
  /** 測り始めた・終えた (外枠が、測っている間はほかの画面へ行けないようにする) */
  onMeasuringChange?: (on: boolean) => void;
}

/** 測位が来なくなってから、経過を進め続ける長さ (秒)。途切れの間に経過が止まって見えないように */
const EXTRAPOLATE_SEC = 1;

const presetsWithLine = CIRCUIT_PRESETS.filter(c => c.controlLine);

/** 差の色 (速いと緑、遅いと赤) */
function deltaClass(d: number | null | undefined): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return 'text-slate-400';
  if (d < -0.005) return 'text-emerald-500';
  if (d > 0.005) return 'text-red-500';
  return 'text-fg';
}

export const LapTimerScreen: React.FC<Props> = ({ onClose, replayLogs, onOpenLog, onOpenFile, embedded = false, onMeasuringChange }) => {
  const t = useT();
  const link = useLoggerLink();
  const statusLabel = useStatusLabel();
  // ラップタイマーの中身 (services/timer/timerRuntime.ts)。今は画面を開いている間だけ作る (閉じたら片付ける。前と同じ動き)
  const replayLogsRef = useRef(replayLogs);
  replayLogsRef.current = replayLogs;
  const rtRef = useRef<TimerRuntime | null>(null);
  rtRef.current ??= new TimerRuntime({
    replayLogs: () => replayLogsRef.current,
    phoneMessages: () => ({
      unavailable: getLang() === 'ja' ? 'この端末では位置を使えません' : 'Location is not available on this device',
      denied: getLang() === 'ja'
        ? '位置の許可がありません (アプリでは、位置を使う設定の入った版に入れ直すと使えます)'
        : 'Location permission denied (in the app, reinstall a build that includes location access)'
    })
  }, (() => {
    // 位置の出どころ。前に選んだものを覚えておき、画面の上の印にも同じものを出す (services/positionSource.ts)
    const saved = getPositionSource();
    if (saved && (saved !== 'digspice' || canUseLoggerBle)) return saved;
    return canUseLoggerBle ? 'digspice' : replayLogs.length > 0 ? 'replay' : 'phone';
  })());
  const rt = rtRef.current;
  useEffect(() => {
    rt.start();
    return () => rt.dispose();
  }, [rt]);
  const snap = useSyncExternalStore(rt.subscribe, rt.getSnapshot);
  const { source, course, flash, voice, measuring, savedRun, saveError, syncNote, phoneInfo, replayId, replaySpeed, pastBest } = snap;
  const state = snap.lap;
  const setSource = (s: Source) => rt.setSource(s);
  const setVoice = (v: boolean | ((cur: boolean) => boolean)) => rt.setVoice(typeof v === 'function' ? v(snap.voice) : v);
  const setReplayId = (id: string) => rt.setReplay(id);
  const setReplaySpeed = (s: number) => rt.setReplaySpeed(s);
  const lapDevices = { statuses: snap.devices, racebox: rt.devices.racebox, drogger: rt.devices.drogger };
  const flushRecording = useCallback((force = false) => rt.flush(force), [rt]);
  const startMeasuring = () => rt.startMeasuring();
  const stopMeasuring = useCallback(() => rt.stopMeasuring(), [rt]);
  const resetRun = () => rt.resetRun();
  const setSaveError = (m: string | null) => rt.setSaveError(m);

  const [menuOpen, setMenuOpen] = useState(false);
  // 測定終了の確認 (全画面) を出しているか
  const [confirmStop, setConfirmStop] = useState(false);
  // 画面の向き (アプリだけ。測る前に選び、測っている間は固める)
  const [orientation, setOrientation] = useState<TimerOrientation>(loadTimerOrientation);
  const [coursePicker, setCoursePicker] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const [wakeLockOk, setWakeLockOk] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  /** ラップタイムの記録 (過去の周の一覧) を開いているか */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 出した経過 (同じ周の間は戻さない。測位がまとめて届いたときに、表示が戻って見えないように) */
  const shownElapsedRef = useRef<{ epoch: number; lapStartMs: number | null; value: number }>({ epoch: 0, lapStartMs: null, value: 0 });
  const measuringRef = useRef(measuring);
  measuringRef.current = measuring;

  // 閉じる: 測っている間は、先に測定終了の確認を出す (誤って閉じて記録が止まらないように)
  const requestClose = () => { if (measuringRef.current) setConfirmStop(true); else onClose(); };
  // タブの 1 つとして出すときは Esc で閉じない (ほかの画面のキー操作を止めないように)
  useEscapeKey(!embedded, requestClose);
  useEscapeKey(menuOpen, () => setMenuOpen(false));
  useEscapeKey(coursePicker, () => setCoursePicker(false));

  // ---- 経過を進める (測位の間も、表示の時計で滑らかに)。周の様子も 0.1 秒ごとに読み直す ----
  useEffect(() => {
    const iv = setInterval(() => {
      setNow(performance.now());
      rt.refresh();
    }, 100);
    return () => clearInterval(iv);
  }, [rt]);

  // 外枠に知らせる (閉じたときも、測っていないことにする)
  const onMeasuringChangeRef = useRef(onMeasuringChange);
  onMeasuringChangeRef.current = onMeasuringChange;
  useEffect(() => { onMeasuringChangeRef.current?.(measuring); }, [measuring]);
  useEffect(() => () => onMeasuringChangeRef.current?.(false), []);
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
  const sincePerf = (now - snap.lastFixPerf) / 1000;
  const lastFix = state?.lastFix ?? snap.lastPos;
  const rawElapsed = state?.lapStartMs != null && state.lastFix
    ? (state.lastFix.tMs - state.lapStartMs) / 1000 + Math.min(EXTRAPOLATE_SEC, Math.max(0, sincePerf)) * (source === 'replay' ? replaySpeed : 1)
    : null;
  // 同じ周の間は、出した経過より戻さない
  let elapsed = rawElapsed;
  if (rawElapsed !== null && state) {
    const shown = shownElapsedRef.current;
    // 周をはじめから数え直したら (epoch が替わったら)、出した経過の覚えを捨てる
    if (shown.epoch === snap.epoch && shown.lapStartMs === state.lapStartMs) elapsed = Math.max(shown.value, rawElapsed);
    shownElapsedRef.current = { epoch: snap.epoch, lapStartMs: state.lapStartMs, value: elapsed! };
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
  // 選んだ出どころの機器を登録していない (測位が来ない)
  const needsRegister = (source === 'digspice' && link.status === 'none') || (source === 'racebox' && !lapDevices.racebox) || (source === 'drogger' && !lapDevices.drogger);
  const sourceStatus = (() => {
    if (source === 'digspice') {
      const ok = link.status === 'fixing';
      return { ok, text: link.status === 'none' ? t('デジスパイスを登録してください (ロガー設定)', 'Register a DigSpice (Logger settings)') : statusLabel(link.status, link.rateHz) };
    }
    if (source === 'drogger' || source === 'racebox') {
      const dev = source === 'drogger' ? lapDevices.drogger : lapDevices.racebox;
      const st = lapDevices.statuses.find(x => x.device.kind === source);
      if (!dev) return { ok: false, text: source === 'drogger' ? t('Drogger を登録してください (機器)', 'Register a Drogger (Devices)') : t('RaceBox を登録してください (機器)', 'Register a RaceBox (Devices)') };
      // つないでいなければ「未接続」(押すとつなぐ)
      return { ok: !!st?.ok, text: st ? `${st.device.displayName}: ${st.state}${st.text ? ` · ${st.text}` : ''}` : `${dev.displayName}: ${t('未接続', 'Not connected')}` };
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
    const p = snap.lastPos;
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
  /** 走行を解析で開く・NMEA / bon4 で保存する・消す */
  const runAction = async (run: RunMeta, action: 'open' | 'nmea' | 'bon4' | 'delete') => {
    if (action === 'delete') {
      if (!window.confirm(t('この走行の記録を消しますか? (「ファイル」アプリに書いたファイルは残ります)', 'Delete this run? (Files written to the Files app are kept)'))) return;
      rt.forgetRun(run.id);
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
      className={`${embedded && !measuring ? 'absolute inset-0 z-[30]' : 'fixed inset-0 z-[90]'} bg-surface-0 text-fg flex flex-col select-none`}
      style={embedded && !measuring ? { paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' } : { paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
      data-testid="lap-timer"
    >
      {/* 上の段: 出どころの状態・コース・声・メニュー・閉じる */}
      <header className="flex items-center gap-2 px-3 py-2 text-xs sm:text-sm shrink-0 min-w-0">
        <button
          type="button"
          // デジスパイスにつないでいないときは、押すとつなぐ。登録していなければ機器の画面へ。測っている間は押せない (走りながら誤って押さないように)
          disabled={measuring}
          onClick={() => {
            if (needsRegister) navStore.go('logger');
            else if ((source === 'digspice' && link.status === 'idle') || ((source === 'racebox' || source === 'drogger') && !lapDevices.statuses.some(x => x.device.kind === source))) {
              rt.connectSource();
            } else setMenuOpen(o => !o);
          }}
          // 幅が足りないときは、こちら (出どころの状態) を縮める (コースのボタンが「コ…」にならないように)
          className={`flex items-center gap-1 px-2 py-1 rounded-full border whitespace-nowrap overflow-hidden text-ellipsis min-w-0 ${sourceStatus.ok ? 'border-emerald-500/50 text-emerald-500 bg-emerald-500/10' : 'border-amber-500/50 text-amber-500 bg-amber-500/10'}`}
          data-testid="lap-timer-source"
        >
          {source === 'digspice' || source === 'racebox' || source === 'drogger' ? <Bluetooth size={14} className="shrink-0" /> : source === 'phone' ? <Smartphone size={14} className="shrink-0" /> : <PlayCircle size={14} className="shrink-0" />}
          <span className="truncate">{sourceStatus.text}{(source === 'digspice' && link.status === 'idle') || ((source === 'racebox' || source === 'drogger') && (source === 'racebox' ? lapDevices.racebox : lapDevices.drogger) && !lapDevices.statuses.some(x => x.device.kind === source)) ? t(' (押すとつなぐ)', ' (tap to connect)') : ''}</span>
        </button>
        <button onClick={() => setCoursePicker(true)} disabled={measuring} className="flex items-center gap-1 px-2 py-1 rounded-full border border-line-3 text-slate-200 whitespace-nowrap shrink-0 max-w-[40vw] disabled:opacity-60" data-testid="lap-timer-course">
          <MapPin size={14} className="shrink-0" />
          <span className="truncate">{course ? circuitLabel(course.name) : t('コース: 自動', 'Course: auto')}</span>
        </button>
        {/* 右のボタンの並びは右に寄せる (余った幅は出どころの状態の表示に回す) */}
        {wakeLockOk === false && (
          <span className="ml-auto text-amber-500/80 text-[11px] leading-tight max-w-[30vw]" data-testid="lap-timer-wake-warning">
            {t('画面が消えます: 設定の自動ロックを「なし」に', 'Screen may sleep: set Auto-Lock to Never')}
          </span>
        )}
        <button onClick={() => setVoice(v => !v)} className={`p-2 rounded-full border border-line-3 shrink-0 ${wakeLockOk === false ? '' : 'ml-auto'}`} aria-label={voice ? t('声を止める', 'Mute voice') : t('声で知らせる', 'Voice on')} title={voice ? t('声を止める', 'Mute voice') : t('声で知らせる', 'Voice on')}>
          {voice ? <Volume2 size={18} /> : <VolumeX size={18} className="text-slate-400" />}
        </button>
        {/* 測っている間は、押せるのは声と測定終了だけ (メニューから出どころを替えると周が消えるため) */}
        <button onClick={() => setMenuOpen(o => !o)} disabled={measuring} className="p-2 rounded-full border border-line-3 shrink-0 disabled:opacity-40" aria-label={t('メニュー', 'Menu')} title={t('メニュー', 'Menu')}>
          <Menu size={18} />
        </button>
        {!embedded && (
          <button onClick={requestClose} className="p-2 rounded-full border border-line-3 shrink-0" aria-label={t('閉じる', 'Close')} title={t('閉じる', 'Close')} data-testid="lap-timer-close">
            <X size={18} />
          </button>
        )}
      </header>

      {/* 真ん中: 大きな数字 */}
      {/* センサー・カメラの様子 (登録した機器があるときだけ) */}
      {lapDevices.statuses.some(x => x.device.kind !== 'racebox' && x.device.kind !== 'drogger') && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-1 text-[11px]" data-testid="lap-timer-devices">
          {lapDevices.statuses.filter(x => x.device.kind !== 'racebox' && x.device.kind !== 'drogger').map(x => (
            <span key={x.device.id} className={`px-2 py-0.5 rounded-full border ${x.ok ? 'border-emerald-500/60 text-emerald-500' : 'border-amber-500/60 text-amber-500'}`}>
              {x.device.displayName}{x.text ? ` · ${x.text}` : ` · ${x.state}`}
            </span>
          ))}
        </div>
      )}
      <main className="flex-1 min-h-0 flex flex-col landscape:flex-row items-stretch gap-2 px-3 pb-3">
        <section className="flex-1 min-w-0 min-h-0 flex flex-col items-center justify-center" data-testid="lap-timer-main">
          {!measuring && source !== 'replay' ? (
            <div className="text-center space-y-2" data-testid="lap-timer-idle">
              <div className="font-bold" style={{ fontSize: needsRegister ? 'min(5.5vw, 7vh)' : 'min(7vw, 9vh)' }}>
                {needsRegister ? t('位置の機器を登録してください', 'Register a position device') : course ? circuitLabel(course.name) : t('コースを決めています', 'Finding the course')}
              </div>
              {needsRegister && (
                <div className="text-slate-400 text-sm">{t('上の印を押すと機器の画面へ。この iPhone の GPS で測るときは、メニューで選んでください。', 'Tap the badge above to register one, or choose this iPhone’s GPS in the menu.')}</div>
              )}
              <div className="font-mono text-slate-300 tabular-nums" style={{ fontSize: 'min(9vw, 12vh)' }}>
                {lastFix ? `${Math.round(lastFix.speedKmh)} km/h` : '--- km/h'}
              </div>
              {pastBest && !needsRegister && (
                <div className="text-slate-300 text-base" data-testid="lap-timer-past-best">
                  {t('これまでのベスト', 'Best so far')} <span className="font-mono font-bold text-amber-500">{formatLapTime(pastBest.time, 2)}</span>
                  <span className="text-slate-500 text-sm"> ({new Date(pastBest.startMs).getMonth() + 1}/{new Date(pastBest.startMs).getDate()})</span>
                </div>
              )}
              <div className="text-slate-400 text-sm">{t('下の「測定開始」を押すと、周を数えて記録します', 'Tap Start below to time laps and record')}</div>
              {/* 測り終えたあと: 保存したことと、走行を見る入口 */}
              {savedRun && (
                <div className="mt-3 inline-flex items-center gap-3 px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/40 text-sm" data-testid="lap-timer-saved">
                  <span className="text-emerald-500 font-bold">
                    {t(`${savedRun.laps} 周の走行を保存しました`, `Saved a run with ${savedRun.laps} laps`)}
                    {savedRun.best !== null ? ` (${t('ベスト', 'best')} ${formatLapTime(savedRun.best, 2)})` : ''}
                  </span>
                  {hasNative() && (
                    <button onClick={() => navStore.go('library')} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold text-xs" data-testid="lap-timer-saved-open">
                      {t('走行で見る', 'View run')}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : !course ? (
            <div className="text-center space-y-3">
              <div className="text-2xl font-bold">{t('コースを決めています', 'Finding the course')}</div>
              <div className="text-slate-400 text-sm">{t('測位が届くと、近くのコースを選びます。違うときは上のコースを押して選んでください。', 'The nearest course is chosen when GPS arrives. Tap the course above to change it.')}</div>
            </div>
          ) : flashing ? (
            <>
              <div className="text-slate-300 font-bold tracking-widest" style={{ fontSize: 'min(5vw, 6vh)' }}>
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
              <div className="font-mono text-slate-300 tabular-nums" style={{ fontSize: 'min(9vw, 12vh)' }}>
                {lastFix ? `${Math.round(lastFix.speedKmh)} km/h` : '--- km/h'}
              </div>
            </div>
          ) : (
            <>
              <div className="text-slate-400 font-bold tracking-widest" style={{ fontSize: 'min(5vw, 6vh)' }}>
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
          <div className="rounded-xl bg-surface-2 px-3 py-2">
            <div className="text-[11px] text-slate-400 font-sans">{t('前の周', 'Last')}</div>
            <div className="text-2xl sm:text-3xl font-bold">{lastLap ? formatLapTime(lastLap.timeSec, 2) : '--:--'}</div>
            <div className={`text-lg ${deltaClass(lastDiff)}`}>{lastDiff !== null ? formatDelta(lastDiff) : ' '}</div>
          </div>
          <div className="rounded-xl bg-surface-2 px-3 py-2">
            <div className="text-[11px] text-slate-400 font-sans">{t('ベスト', 'Best')}{state?.best ? ` (${t(`${state.best.number} 周目`, `L${state.best.number}`)})` : ''}</div>
            <div className="text-2xl sm:text-3xl font-bold text-amber-500">{state?.best ? formatLapTime(state.best.timeSec, 2) : '--:--'}</div>
            <div className="text-lg text-slate-400"><span className="text-[11px] font-sans text-slate-500 mr-1">{t('速度', 'Speed')}</span>{lastFix ? `${Math.round(lastFix.speedKmh)} km/h` : '---'}</div>
          </div>
          {sectorCount > 0 && (
            <div className="col-span-2 landscape:col-span-1 rounded-xl bg-surface-2 px-3 py-2 flex gap-2" data-testid="lap-timer-sectors">
              {Array.from({ length: sectorCount }, (_, i) => {
                // 周を終えて大きく出している間は、終えた周のセクターを出しておく
                const cur = flashing
                  ? (flashing.lap.sectorsSec[i] !== undefined ? { timeSec: flashing.lap.sectorsSec[i], diffSec: null } : undefined)
                  : state?.currentSectors[i];
                return (
                  <div key={i} className="flex-1 min-w-0">
                    <div className="text-[11px] text-slate-400 font-sans">S{i + 1}</div>
                    <div className="text-base sm:text-lg">{cur ? (Number.isFinite(cur.timeSec) ? cur.timeSec.toFixed(2) : '--') : bestSectors[i] !== undefined ? <span className="text-slate-500">{bestSectors[i].toFixed(2)}</span> : '--'}</div>
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
            className={`w-full flex items-center justify-center gap-3 rounded-2xl font-bold ${measuring ? 'min-h-[72px] landscape:min-h-[56px] text-2xl border-[3px] border-red-500 text-red-500 active:bg-red-900/40' : 'min-h-[88px] landscape:min-h-[64px] text-3xl bg-emerald-600 active:bg-emerald-700 text-white'}`}
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
        <div className="absolute right-2 top-14 z-10 w-[min(92vw,360px)] max-h-[80vh] overflow-y-auto rounded-2xl bg-surface-1 border border-line-2 p-3 space-y-3 text-sm shadow-2xl">
          <div>
            <div className="text-slate-400 text-xs mb-1">{t('測位の出どころ', 'Position source')}</div>
            <div className="grid grid-cols-1 gap-1">
              {canUseLoggerBle && (
                <button onClick={() => { setSource('digspice'); setMenuOpen(false); }} className={`text-left px-3 py-2 rounded-lg ${source === 'digspice' ? 'bg-red-600 text-white' : 'bg-surface-2'}`}>
                  {t('デジスパイス (Bluetooth・20 Hz)', 'DigSpice (Bluetooth, 20 Hz)')}
                </button>
              )}
              {lapDevices.racebox && (
                <button onClick={() => { setSource('racebox'); setMenuOpen(false); }} className={`text-left px-3 py-2 rounded-lg ${source === 'racebox' ? 'bg-red-600 text-white' : 'bg-surface-2'}`}>
                  {t(`RaceBox (${lapDevices.racebox.displayName}・25 Hz)`, `RaceBox (${lapDevices.racebox.displayName}, 25 Hz)`)}
                </button>
              )}
              {lapDevices.drogger && (
                <button onClick={() => { setSource('drogger'); setMenuOpen(false); }} className={`text-left px-3 py-2 rounded-lg ${source === 'drogger' ? 'bg-red-600 text-white' : 'bg-surface-2'}`}>
                  {t(`Drogger (${lapDevices.drogger.displayName})`, `Drogger (${lapDevices.drogger.displayName})`)}
                </button>
              )}
              <button onClick={() => { setSource('phone'); setMenuOpen(false); }} className={`text-left px-3 py-2 rounded-lg ${source === 'phone' ? 'bg-red-600 text-white' : 'bg-surface-2'}`}>
                {t('この端末の GPS (1 Hz 前後・粗い)', 'This device GPS (~1 Hz, coarse)')}
              </button>
              <button onClick={() => { setSource('replay'); setMenuOpen(false); }} disabled={replayLogs.length === 0} className={`text-left px-3 py-2 rounded-lg disabled:opacity-40 ${source === 'replay' ? 'bg-red-600 text-white' : 'bg-surface-2'}`}>
                {t('読み込んだログを再生して試す', 'Try with a loaded log (replay)')}
              </button>
            </div>
          </div>
          {source === 'replay' && replayLogs.length > 0 && (
            <div className="space-y-2">
              <select value={replayId} onChange={e => setReplayId(e.target.value)} className="w-full bg-surface-2 rounded-lg px-2 py-2" aria-label={t('再生するログ', 'Log to replay')}>
                {replayLogs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <div className="flex gap-1">
                {[1, 4, 16].map(x => (
                  <button key={x} onClick={() => setReplaySpeed(x)} className={`flex-1 px-2 py-1.5 rounded-lg ${replaySpeed === x ? 'bg-red-600 text-white' : 'bg-surface-2'}`}>×{x}</button>
                ))}
              </div>
            </div>
          )}
          <div data-testid="lap-timer-runs">
            <div className="text-slate-400 text-xs mb-1">{t('走行の記録 (走っている間に 2 秒ごとに保存)', 'Runs (saved every 2 s while driving)')}</div>
            {saveError && <div className="text-amber-500 text-[11px] mb-1">{t(`保存でエラー: ${saveError}`, `Save error: ${saveError}`)}</div>}
            {runs.length === 0 ? (
              <div className="text-slate-500 text-xs">{t('まだありません', 'None yet')}</div>
            ) : (
              <div className="space-y-1.5">
                {runs.slice(0, 20).map(r => {
                  const d = new Date(r.startedMs);
                  // 記録中 (または、たった今まで書いていた) の走行は消せない
                  const recording = rt.currentRunId === r.id || Date.now() - r.updatedMs < 10000;
                  return (
                    <div key={r.id} className="rounded-lg bg-surface-2 px-2.5 py-2">
                      <div className="flex items-baseline gap-2 text-xs">
                        <span className="font-mono">{`${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}</span>
                        <span className="truncate text-slate-300 flex-1 min-w-0">{r.courseName ? circuitLabel(r.courseName) : '—'}</span>
                        {recording && <span className="text-red-500 text-[10px] whitespace-nowrap">{t('記録中', 'Recording')}</span>}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono">
                        {t(`${r.lapCount} 周`, `${r.lapCount} laps`)}{r.bestLapSec !== null ? ` · ${t('ベスト', 'best')} ${formatLapTime(r.bestLapSec, 3)}` : ''}{` · ${Math.round(r.fixCount / 20 / 60) || '<1'} min`}
                      </div>
                      <div className="flex gap-1 mt-1.5">
                        <button onClick={() => { void runAction(r, 'open'); }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-surface-3 text-xs"><BarChart3 size={12} />{t('解析', 'Analyse')}</button>
                        <button onClick={() => { void runAction(r, 'nmea'); }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-surface-3 text-xs"><Save size={12} />NMEA</button>
                        <button onClick={() => { void runAction(r, 'bon4'); }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-surface-3 text-xs"><Save size={12} />bon4</button>
                        <button onClick={() => { void runAction(r, 'delete'); }} disabled={recording} aria-label={t('消す', 'Delete')} title={t('消す', 'Delete')} className="px-2 py-1.5 rounded bg-surface-2 text-slate-400 disabled:opacity-30"><Trash2 size={12} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {hasNative() && (
              <p className="text-[10px] text-slate-500 mt-1">{t('「ファイル」アプリの このiPhone内 → このアプリ → LapTimer → サーキット名 にも、走っている間に書いています (.nmea と .bon4)。', 'Also written while driving to Files → On My iPhone → this app → LapTimer → circuit name (.nmea and .bon4).')}</p>
            )}
          </div>
          {/* ラップタイムの記録と保管場所は、走行のタブと設定へ移した (2026-10-21)。機器の登録への入口だけ置く */}
          {hasNative() && (
            <button onClick={() => { setMenuOpen(false); navStore.go('logger'); }} disabled={measuring} className="w-full text-left px-3 py-2 rounded-lg bg-surface-2 disabled:opacity-40" data-testid="lap-timer-devices-link">
              {t('機器の登録 (デジスパイス・RaceBox・センサー・カメラ)', 'Register devices (DigSpice, RaceBox, sensors, cameras)')}
            </button>
          )}
          {syncNote && (
            <div className={`text-[11px] ${syncNote.ok ? 'text-slate-400' : 'text-amber-500'}`}>
              {syncNote.ok ? t(`フォルダへ ${syncNote.text} 個のファイルを写しました`, `Copied ${syncNote.text} files to the folder`) : t(`フォルダへ写せませんでした: ${syncNote.text}`, `Could not copy to the folder: ${syncNote.text}`)}
            </div>
          )}
          <button onClick={() => { resetRun(); setMenuOpen(false); }} className="w-full px-3 py-2 rounded-lg bg-surface-2 text-slate-300">
            {t('周をはじめから数える (新しい走行として記録する)', 'Reset laps (start a new run)')}
          </button>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            {t('走っている間は、画面を消さずに、このアプリを前に出しておいてください (画面が消えると周を数えません)。',
              'Keep the screen on and this app in front while driving (laps are not counted while the screen is off).')}
          </p>
        </div>
      )}

      {historyOpen && <LapHistoryPanel onClose={() => setHistoryOpen(false)} onOpenRun={onOpenFile} />}

      {/* コースを選ぶ */}
      {coursePicker && (
        <div className="absolute inset-0 z-20 bg-surface-0/95 flex flex-col p-3" role="dialog" aria-label={t('コースを選ぶ', 'Choose course')}>
          <div className="flex items-center gap-2 mb-2">
            <div className="font-bold flex-1">{t('コースを選ぶ (近い順)', 'Choose course (nearest first)')}</div>
            <button onClick={() => setCoursePicker(false)} className="p-2 rounded-full border border-line-3" aria-label={t('閉じる', 'Close')}><X size={18} /></button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-1">
            <button onClick={() => { rt.chooseCourse(null, { manual: false }); setCoursePicker(false); }} className="w-full text-left px-3 py-2 rounded-lg bg-surface-2">
              {t('自動 (測位の所の近くのコース)', 'Auto (nearest to GPS)')}
            </button>
            {nearbyCourses.map(({ c, d }) => (
              <button key={c.id} onClick={() => { rt.chooseCourse(c, { replay: true, manual: true }); setCoursePicker(false); }} className={`w-full text-left px-3 py-2 rounded-lg ${course?.id === c.id ? 'bg-red-600 text-white' : 'bg-surface-2'}`}>
                {circuitLabel(c.name)}{Number.isFinite(d) ? <span className="text-slate-500 ml-2 text-xs">{d < 10 ? d.toFixed(1) : Math.round(d)} km</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
