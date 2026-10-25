/**
 * 動画だけの参考ラップの画面 (LATER-17 の案 1。PLAN-31 の残り。2026-10-25)。
 * - VideoRefPicker: 参考ラップにする動画を選ぶ (どの走行にも付いていない動画)
 * - VideoLapMarker: 動画を再生しながら、計測線・セクターの線を通ったところで印を打つ
 * - VideoLapCompare: 参考ラップの周と自分の周の動画を、周の始まりをそろえて並べ、タイムを比べる
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Flag, Pause, Play, Undo2, X } from 'lucide-react';
import { useT } from '../utils/i18n';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { formatLapTime } from '../services/liveLapTimer';
import type { RunFileInfo, RunStore } from '../services/runStore';
import type { RunItem } from '../services/runOpener';
import { lapsFromMarks, ownLapInVideo, saveVideoLaps, videoLapsOf, type VideoLapMark, type VideoRef } from '../services/videoLaps';

const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
/** 動画の 1 コマ (30 fps とみなす) */
const FRAME = 1 / 30;

/**
 * iPhone (WebKit) は、一度再生するまで止めた動画のコマを描かない (黒いまま)。音を消して一瞬再生して止め、コマを出す。
 * 終わったら then (止めた位置を決め直すなど)
 */
function primeFrame(v: HTMLVideoElement, then?: () => void): void {
  if (v.dataset.primed) { then?.(); return; }
  v.dataset.primed = '1';
  v.muted = true;
  const at = v.currentTime;
  void v.play().then(() => { v.pause(); v.currentTime = at; then?.(); }, () => then?.());
}

const Shell: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; testid: string; wide?: boolean }> = ({ title, onClose, children, testid, wide }) => {
  const t = useT();
  useEscapeKey(true, onClose);
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-2 sm:p-4" role="dialog" aria-modal="true" data-testid={testid}>
      <div className={`w-full ${wide ? 'max-w-6xl' : 'max-w-3xl'} max-h-[95dvh] flex flex-col rounded-2xl bg-surface-1 border border-line-2 shadow-2xl`}>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line-2">
          <div className="flex-1 min-w-0 text-sm font-bold text-slate-100 truncate">{title}</div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-surface-3 text-slate-400 cursor-pointer" aria-label={t('閉じる', 'Close')} data-testid={`${testid}-close`}><X size={18} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

/** 動画の URL の頭がそろったか (Android はアプリに聞くまで分からない)。そろうまで動画の src を出さない */
function useVideoBase(store: RunStore): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void store.supportsVideos().catch(() => false).then(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [store]);
  return ready;
}

/** 参考ラップにする動画を選ぶ */
export const VideoRefPicker: React.FC<{ candidates: RunFileInfo[] | null; onPick: (f: RunFileInfo) => void; onClose: () => void }> = ({ candidates, onPick, onClose }) => {
  const t = useT();
  return (
    <Shell title={t('参考ラップにする動画を選ぶ', 'Choose a video for a reference lap')} onClose={onClose} testid="video-ref-picker">
      <div className="p-4 space-y-2 text-xs">
        <p className="text-slate-400">
          {t('GPS もログもない動画 (速い人の車載動画など) を、再生しながら計測線で印を打って参考ラップにします。動画は保管場所のサーキットのフォルダ (か日付のフォルダ) に入れておいてください。走行に付けた動画は出ません。',
            'Turn a video without GPS or a log (e.g. a fast driver’s onboard) into a reference lap by marking the timing line while it plays. Put the video in a circuit folder (or its date folder) of your storage. Videos attached to runs are not listed.')}
        </p>
        {candidates === null && <p className="text-slate-500">{t('探しています…', 'Looking…')}</p>}
        {candidates?.length === 0 && <p className="text-amber-500">{t('使える動画がありません。', 'No videos found.')}</p>}
        {candidates?.map(f => (
          <button key={f.path} onClick={() => onPick(f)} className="w-full text-left flex gap-2 px-3 py-2 rounded-lg bg-surface-2 border border-line-2 hover:border-sky-500 cursor-pointer" data-testid="video-ref-candidate">
            <span className="flex-1 min-w-0 truncate text-slate-200">{f.path}</span>
            <span className="shrink-0 text-slate-500">{size(f.size)}{f.local === false ? ' · iCloud' : ''}</span>
          </button>
        ))}
      </div>
    </Shell>
  );
};

/** 動画を再生しながら印を打つ */
export const VideoLapMarker: React.FC<{
  store: RunStore;
  path: string;
  existing?: VideoRef | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ store, path, existing, onClose, onSaved }) => {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const base = useVideoBase(store);
  const [marks, setMarks] = useState<VideoLapMark[]>(() => videoLapsOf(existing?.row)?.marks ?? []);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  // 今の位置と再生中かは、0.1 秒ごとに読む (iPhone では動画の時刻の知らせが届かないことがあるため)
  useEffect(() => {
    const id = setInterval(() => {
      const v = video.current;
      if (!v) return;
      setNow(v.currentTime);
      setPlaying(!v.paused);
    }, 100);
    return () => clearInterval(id);
  }, []);
  const [name, setName] = useState(existing?.row.name ?? '');
  const [driver, setDriver] = useState(existing?.row.reference?.driver ?? '');
  const [car, setCar] = useState(existing?.row.reference?.car ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const laps = useMemo(() => lapsFromMarks(marks), [marks]);
  // 保存していない印があれば、閉じる前に確かめる (打ち直すのは手間なので)
  const snapshot = () => JSON.stringify({ marks, name: name.trim(), driver: driver.trim(), car: car.trim() });
  const initial = useRef<string | null>(null);
  initial.current ??= snapshot();
  const close = () => {
    if (snapshot() !== initial.current && !window.confirm(t('保存していない変更 (印・名前など) があります。閉じますか？', 'You have unsaved changes (marks, name…). Close anyway?'))) return;
    onClose();
  };
  const best = laps.length ? Math.min(...laps.map(l => l.time)) : null;

  const add = (kind: VideoLapMark['kind']) => {
    const v = video.current;
    if (!v) return;
    const tNow = Math.round(v.currentTime * 1000) / 1000;
    // 計測線の続けての押し間違い (3 秒以内に 2 つ) は打たない。打つと次の周のタイムが黙って変わるため
    const near = marks.find(x => x.kind === 'line' && kind === 'line' && Math.abs(x.t - tNow) < 3 && Math.abs(x.t - tNow) >= 0.05);
    if (near) { setError(t(`計測線の印が近すぎます (${formatLapTime(near.t)} から 3 秒以内)。打ち直すときは、前の印を消してから`, `Too close to the timing-line mark at ${formatLapTime(near.t)} (within 3 s). Delete that mark first to redo it.`)); return; }
    setError(null);
    // 同じ所に 2 回打たない
    setMarks(m => (m.some(x => Math.abs(x.t - tNow) < 0.05) ? m : [...m, { t: tNow, kind }].sort((a, b) => a.t - b.t)));
  };
  const seek = (sec: number) => { const v = video.current; if (v) v.currentTime = Math.max(0, Math.min(v.duration || sec, sec)); };
  const step = (d: number) => { const v = video.current; if (v) { v.pause(); seek(v.currentTime + d); } };
  const toggle = () => { const v = video.current; if (v) { if (v.paused) void v.play(); else v.pause(); } };

  // キー: L / Enter 計測線、S セクター、空白 再生・止める、← → 1 コマ (Shift で 1 秒)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 入力欄では何もしない。ボタンにいるときの Enter・空白は、そのボタンを押す (印を打たない)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return;
      if (e.key === 'l' || e.key === 'L' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add('line'); }
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); e.stopPropagation(); add('sector'); }
      else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? -1 : -FRAME); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? 1 : FRAME); }
    };
    // 動画の操作部品 (controls) が矢印・空白を先に取らないよう、捕まえる段階で受ける
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveVideoLaps(store, path, marks, { name, driver, car });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const btn = 'inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg bg-surface-3 border border-line-2 text-slate-200 text-xs cursor-pointer hover:border-sky-500';
  return (
    <Shell title={t(`参考ラップの印を打つ: ${nameOf(path)}`, `Mark laps: ${nameOf(path)}`)} onClose={close} testid="video-lap-marker" wide>
      <div className="p-3 grid gap-3 lg:grid-cols-[1fr_280px]">
        <div className="space-y-2 min-w-0">
          <video ref={video} src={base ? store.videoUrl(path) : undefined} controls playsInline preload="auto" className="w-full max-h-[55dvh] bg-black rounded-lg"
            // 印を直すときは、最初の印から
            // コマを出してから、印を直すときは最初の印へ (iPhone は再生するまでコマを読まないので、長さが分かった時点で)
            onLoadedMetadata={e => { const v = e.currentTarget; primeFrame(v, () => { const first = marks[0]; if (first && v.currentTime < 0.5) v.currentTime = first.t; }); }}
            muted data-testid="video-lap-marker-video" />
          <div className="flex flex-wrap items-center gap-1.5">
            <button className={btn} onClick={() => step(-1)} aria-label={t('1 秒戻す', 'Back 1 s')}>−1s</button>
            <button className={btn} onClick={() => step(-FRAME)} aria-label={t('1 コマ戻す', 'Back 1 frame')}><ChevronLeft size={14} /></button>
            <button className={btn} onClick={toggle} aria-label={playing ? t('止める', 'Pause') : t('再生', 'Play')}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
            <button className={btn} onClick={() => step(FRAME)} aria-label={t('1 コマ進める', 'Forward 1 frame')}><ChevronRight size={14} /></button>
            <button className={btn} onClick={() => step(1)} aria-label={t('1 秒進める', 'Forward 1 s')}>+1s</button>
            <span className="text-xs font-mono text-slate-400 px-1">{formatLapTime(now, 2)}</span>
            <div className="flex-1" />
            <button onClick={() => add('line')} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold cursor-pointer" data-testid="video-lap-mark-line">
              <Flag size={14} />{t('計測線 (L)', 'Timing line (L)')}
            </button>
            <button onClick={() => add('sector')} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold cursor-pointer" data-testid="video-lap-mark-sector">
              {t('セクター (S)', 'Sector (S)')}
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            {t('計測線を通ったコマで「計測線」を押します (止めて ← → の 1 コマ送りで合わせると正確)。計測線から次の計測線までが 1 周。途中で「セクター」を押すとセクタータイムも出ます。',
              'Press "Timing line" on the frame where the car crosses the line (pause and use ← → to step frames for accuracy). Line to line is one lap; "Sector" marks split it.')}
          </p>
        </div>
        <div className="space-y-2 text-xs min-w-0">
          <div className="grid grid-cols-1 gap-1.5">
            <input value={name} onChange={e => setName(e.target.value.slice(0, 60))} placeholder={t('名前 (例 ◯◯さんのベスト)', 'Name (e.g. Pro’s best)')} className="bg-surface-2 border border-line-3 rounded px-2 py-1.5 text-slate-200 outline-none focus:border-sky-500" data-testid="video-lap-name" />
            <input value={driver} onChange={e => setDriver(e.target.value.slice(0, 40))} placeholder={t('誰の走行か', 'Driver')} className="bg-surface-2 border border-line-3 rounded px-2 py-1.5 text-slate-200 outline-none focus:border-sky-500" data-testid="video-lap-driver" />
            <input value={car} onChange={e => setCar(e.target.value.slice(0, 40))} placeholder={t('車', 'Car')} className="bg-surface-2 border border-line-3 rounded px-2 py-1.5 text-slate-200 outline-none focus:border-sky-500" />
          </div>
          <div className="font-bold text-slate-300">{t(`周 ${laps.length}`, `Laps ${laps.length}`)}</div>
          <div className="space-y-0.5" data-testid="video-lap-laps">
            {laps.map(l => (
              <button key={l.n} onClick={() => seek(l.start)} className="w-full flex gap-2 px-2 py-1.5 rounded hover:bg-surface-3 cursor-pointer text-left">
                <span className="text-slate-500 w-8">L{l.n}</span>
                <span className={`font-mono ${l.time === best ? 'text-purple-400 font-bold' : 'text-slate-200'}`}>{formatLapTime(l.time)}</span>
                {l.sectors.length > 0 && <span className="text-slate-500 truncate">{l.sectors.map(s => s.toFixed(2)).join(' / ')}</span>}
              </button>
            ))}
          </div>
          <div className="font-bold text-slate-300 pt-1">{t(`印 ${marks.length}`, `Marks ${marks.length}`)}</div>
          <div className="space-y-0.5 max-h-40 overflow-y-auto" data-testid="video-lap-marks">
            {marks.map((m, i) => (
              <div key={`${m.t}-${i}`} className="flex items-center gap-2">
                <button onClick={() => seek(m.t)} className="flex-1 text-left px-2 py-1.5 rounded hover:bg-surface-3 cursor-pointer">
                  <span className={m.kind === 'line' ? 'text-red-400' : 'text-amber-400'}>{m.kind === 'line' ? t('計測線', 'Line') : t('セクター', 'Sector')}</span>
                  <span className="font-mono text-slate-400 ml-2">{formatLapTime(m.t)}</span>
                </button>
                <button onClick={() => setMarks(ms => ms.filter((_, k) => k !== i))} className="p-2 text-slate-500 hover:text-red-400 cursor-pointer" aria-label={t('消す', 'Delete')}><X size={14} /></button>
              </div>
            ))}
          </div>
          {marks.length > 0 && (
            <button onClick={() => setMarks(m => { const last = m.reduce((a, x) => (Math.abs(x.t - now) < Math.abs(a.t - now) ? x : a), m[0]); return m.filter(x => x !== last); })} className={btn}>
              <Undo2 size={12} />{t('今の位置にいちばん近い印を消す', 'Remove the mark nearest here')}
            </button>
          )}
          {error && <p className="text-amber-500">{error}</p>}
          <button onClick={() => void save()} disabled={saving || laps.length === 0} className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-bold cursor-pointer disabled:opacity-50" data-testid="video-lap-save">
            {saving ? t('保存しています…', 'Saving…') : t('参考ラップとして保存', 'Save as reference lap')}
          </button>
          {laps.length === 0 && <p className="text-[11px] text-slate-500">{t('計測線の印が 2 つ以上 (1 周) あると保存できます。', 'Mark the timing line at least twice (one lap) to save.')}</p>}
        </div>
      </div>
    </Shell>
  );
};

interface OwnLap { run: RunItem; n: number; part?: number; time: number; sectors: number[]; startMs: number; video: { path: string; sec: number } }

/** 参考ラップの周と、自分の周の動画を並べて比べる */
export const VideoLapCompare: React.FC<{ store: RunStore; videoRef: VideoRef; runs: RunItem[]; onClose: () => void }> = ({ store, videoRef, runs, onClose }) => {
  const t = useT();
  const refLaps = videoRef.laps;
  const [refN, setRefN] = useState(() => (refLaps.length ? refLaps.reduce((a, b) => (b.time < a.time ? b : a)).n : 1));
  // 自分の周: 同じサーキットのフォルダの、自分の走行で、同期した動画に映っている周
  const ownLaps = useMemo<OwnLap[]>(() => {
    const out: OwnLap[] = [];
    for (const r of runs) {
      if (r.folder !== videoRef.folder || r.entry?.reference) continue;
      for (const l of r.laps) {
        if (l.hidden) continue;
        const v = ownLapInVideo(r, l);
        if (v) out.push({ run: r, n: l.n, ...(l.part ? { part: l.part } : {}), time: l.time, sectors: l.sectors, startMs: l.startMs, video: { path: v.path, sec: v.sec } });
      }
    }
    out.sort((a, b) => a.time - b.time);
    // ピットに入った周・出た周など、とても遅い周は出さない (いちばん速い周の 1.3 倍まで)
    return out.filter(o => o.time <= out[0].time * 1.3);
  }, [runs, videoRef.folder]);
  const [ownIdx, setOwnIdx] = useState(0);
  const refLap = refLaps.find(l => l.n === refN) ?? refLaps[0];
  const own = ownLaps[ownIdx] ?? null;
  const refVideo = useRef<HTMLVideoElement>(null);
  const base = useVideoBase(store);
  const ownVideo = useRef<HTMLVideoElement>(null);
  const [tau, setTau] = useState(0);
  const [playing, setPlaying] = useState(false);
  const span = Math.max(refLap?.time ?? 0, own?.time ?? 0);

  /** 両方の動画を、周の始まりから tau 秒の所へ */
  const seekBoth = (sec: number) => {
    const s = Math.max(0, Math.min(span, sec));
    setTau(s);
    if (refVideo.current && refLap) refVideo.current.currentTime = refLap.start + Math.min(s, refLap.time);
    if (ownVideo.current && own) ownVideo.current.currentTime = own.video.sec + Math.min(s, own.time);
  };
  // 周を替えたら、始まりへ
  useEffect(() => { refVideo.current?.pause(); ownVideo.current?.pause(); setPlaying(false); clock.current = null; const id = setTimeout(() => seekBoth(0), 50); return () => clearTimeout(id); }, [refN, ownIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // 再生中: 時計で周の中の位置を進め、2 つの動画をそれぞれの周の中でそろえる (止まっていれば再生し、ずれが 0.15 秒を超えたら合わせ直す)。
  // 周の短いほうは、その周の終わりで止める (次の周の映像を出さない)
  const clock = useRef<{ tau0: number; t0: number } | null>(null);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const follow = (v: HTMLVideoElement | null, start: number, time: number, s: number) => {
      if (!v) return;
      if (s < time) {
        const want = start + s;
        if (Math.abs(v.currentTime - want) > 0.15) v.currentTime = want;
        if (v.paused) void v.play().catch(() => undefined);
      } else if (!v.paused) {
        v.pause();
        v.currentTime = start + time;
      }
    };
    const tick = () => {
      const c = clock.current;
      if (!c) return;
      const s = c.tau0 + (performance.now() - c.t0) / 1000;
      if (s >= span) {
        refVideo.current?.pause(); ownVideo.current?.pause();
        setTau(span); setPlaying(false); clock.current = null;
        return;
      }
      setTau(s);
      if (refLap) follow(refVideo.current, refLap.start, refLap.time, s);
      if (own) follow(ownVideo.current, own.video.sec, own.time, s);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, refLap, own, span]);

  const toggle = () => {
    if (playing) { refVideo.current?.pause(); ownVideo.current?.pause(); setPlaying(false); clock.current = null; return; }
    const from = tau >= span ? 0 : Math.max(0, tau);
    seekBoth(from);
    clock.current = { tau0: from, t0: performance.now() };
    setPlaying(true);
  };

  const diff = (a: number, b: number) => { const d = b - a; return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(3)}`; };
  const sameSectors = !!refLap && !!own && refLap.sectors.length > 0 && refLap.sectors.length === own.sectors.length;
  const runLabel = (o: OwnLap) => {
    const d = o.run.startMs !== null ? new Date(o.run.startMs) : null;
    const day = d ? `${d.getMonth() + 1}/${d.getDate()} ` : '';
    return `${formatLapTime(o.time)} · ${day}${o.run.entry?.name ?? ''} L${o.part ? `${o.part}-` : ''}${o.n}`.replace(/  +/g, ' ');
  };

  return (
    <Shell title={t(`参考ラップと比べる: ${videoRef.row.name ?? nameOf(videoRef.file)}`, `Compare with reference: ${videoRef.row.name ?? nameOf(videoRef.file)}`)} onClose={onClose} testid="video-lap-compare" wide>
      <div className="p-3 space-y-3 text-xs">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 text-slate-400">{t('参考ラップ', 'Reference')}</span>
            <select value={refN} onChange={e => setRefN(+e.target.value)} className="flex-1 min-w-0 bg-surface-2 border border-line-3 rounded px-2 py-1 text-slate-200" data-testid="video-lap-compare-ref">
              {refLaps.map(l => <option key={l.n} value={l.n}>L{l.n} {formatLapTime(l.time)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 text-slate-400">{t('自分の周', 'My lap')}</span>
            {ownLaps.length > 0 ? (
              <select value={ownIdx} onChange={e => setOwnIdx(+e.target.value)} className="flex-1 min-w-0 bg-surface-2 border border-line-3 rounded px-2 py-1 text-slate-200" data-testid="video-lap-compare-own">
                {ownLaps.map((o, i) => <option key={`${o.run.folder}/${o.run.file}/${o.part ?? 0}/${o.n}`} value={i}>{runLabel(o)}</option>)}
              </select>
            ) : (
              <span className="text-amber-500">{t('このサーキットに、動画を同期した自分の走行がありません', 'No runs with a synced video at this circuit')}</span>
            )}
          </label>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1 min-w-0">
            <div className="text-slate-400">{t('参考ラップ', 'Reference')} {videoRef.row.reference?.driver ? `· ${videoRef.row.reference.driver}` : ''}</div>
            <video ref={refVideo} src={base ? store.videoUrl(videoRef.path) : undefined} playsInline muted preload="auto" onLoadedMetadata={e => { const v = e.currentTarget; primeFrame(v, () => { if (refLap && !playing) v.currentTime = refLap.start + Math.min(tau, refLap.time); }); }} className="w-full aspect-video bg-black rounded-lg" data-testid="video-lap-compare-ref-video" />
          </div>
          <div className="space-y-1 min-w-0">
            <div className="text-slate-400">{t('自分', 'Mine')}</div>
            {own
              ? <video key={own.video.path} ref={ownVideo} src={base ? store.videoUrl(own.video.path) : undefined} playsInline muted preload="auto" onLoadedMetadata={e => { const v = e.currentTarget; primeFrame(v, () => { if (own && !playing) v.currentTime = own.video.sec + Math.min(tau, own.time); }); }} className="w-full aspect-video bg-black rounded-lg" data-testid="video-lap-compare-own-video" />
              : <div className="w-full aspect-video bg-black/50 rounded-lg" />}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggle} className="p-2 rounded-lg bg-red-600 hover:bg-red-500 text-white cursor-pointer" aria-label={playing ? t('止める', 'Pause') : t('再生', 'Play')} data-testid="video-lap-compare-play">
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <input type="range" min={0} max={span || 1} step={0.01} value={Math.min(tau, span)} onChange={e => { refVideo.current?.pause(); ownVideo.current?.pause(); setPlaying(false); clock.current = null; seekBoth(+e.target.value); }} className="flex-1" aria-label={t('周の中の位置', 'Position in lap')} />
          <span className="font-mono text-slate-300 w-20 text-right">{formatLapTime(Math.max(0, tau), 2)}</span>
        </div>
        {refLap && (
          <table className="w-full text-left font-mono" data-testid="video-lap-compare-table">
            <thead className="text-slate-500">
              <tr><th className="font-normal py-1" /><th className="font-normal">{t('タイム', 'Time')}</th>{(sameSectors ? refLap.sectors : []).map((_, i) => <th key={i} className="font-normal">S{i + 1}</th>)}</tr>
            </thead>
            <tbody>
              <tr><td className="text-slate-400 font-sans pr-2">{t('参考', 'Ref')}</td><td className="text-slate-200">{formatLapTime(refLap.time)}</td>{(sameSectors ? refLap.sectors : []).map((s, i) => <td key={i} className="text-slate-300">{s.toFixed(3)}</td>)}</tr>
              {own && <tr><td className="text-slate-400 font-sans pr-2">{t('自分', 'Mine')}</td><td className="text-slate-200">{formatLapTime(own.time)}</td>{(sameSectors ? own.sectors : []).map((s, i) => <td key={i} className="text-slate-300">{s.toFixed(3)}</td>)}</tr>}
              {own && <tr><td className="text-slate-400 font-sans pr-2">{t('差', 'Gap')}</td><td className={own.time > refLap.time ? 'text-red-400' : 'text-emerald-400'}>{diff(refLap.time, own.time)}</td>{(sameSectors ? own.sectors : []).map((s, i) => <td key={i} className={s > refLap.sectors[i] ? 'text-red-400' : 'text-emerald-400'}>{diff(refLap.sectors[i], s)}</td>)}</tr>}
            </tbody>
          </table>
        )}
        {refLap && own && !sameSectors && refLap.sectors.length > 0 && (
          <p className="text-[11px] text-slate-500">{t('セクターの数が自分の走行と違うので、周のタイムだけ比べます。', 'The number of sectors differs, so only lap times are compared.')}</p>
        )}
        <p className="text-[11px] text-slate-500">{t('位置・速度はないので、周の始まりからの時間で動画をそろえています。', 'There is no position or speed, so the videos are aligned by time from the lap start.')}</p>
      </div>
    </Shell>
  );
};
