import React, { useEffect, useRef, useState } from 'react';
import { Video } from 'lucide-react';
import { useT } from '../utils/i18n';
import type { CameraLens, CameraPreset } from '../native/contract';
import { callNative, onNative } from '../native/bridge';
import { EV_CHOICES, cameraAvailable, dualPlan, frontParams, listLenses, loadCameraSettings, saveCameraSettings, type CameraSettings } from '../services/timer/phoneCamera';

// クラスの名前は、Tailwind が見つけられるよう組み立てずにそのまま書く
// 横向きのスマートフォン: 画面の左に固定 (前も撮るときは、2 つの映像を横に並べる)
const LAND = '[@media(orientation:landscape)_and_(max-height:500px)]:bg-black';
const LAND_WRAP = '[@media(orientation:landscape)_and_(max-height:500px)]:fixed [@media(orientation:landscape)_and_(max-height:500px)]:left-[max(0.75rem,calc(env(safe-area-inset-left)+0.5rem))] [@media(orientation:landscape)_and_(max-height:500px)]:top-16 [@media(orientation:landscape)_and_(max-height:500px)]:w-[min(42vw,calc(100vw-400px-env(safe-area-inset-left)))] [@media(orientation:landscape)_and_(max-height:500px)]:z-20 [@media(orientation:landscape)_and_(max-height:500px)]:bg-surface-1/95 [@media(orientation:landscape)_and_(max-height:500px)]:p-1.5 [@media(orientation:landscape)_and_(max-height:500px)]:rounded-xl [@media(orientation:landscape)_and_(max-height:500px)]:shadow-2xl';
// 縦のスマートフォン: メニューの下 (右下、下のタブの上) に縦長の窓。幅は min(36vw,170px)、高さはその 16/9。
// 前も撮るときは、2 つを横に並べて窓を広げる (1 つずつは小さくなる)
const PORT_WRAP = '[@media(orientation:portrait)_and_(max-width:500px)]:fixed [@media(orientation:portrait)_and_(max-width:500px)]:right-2 [@media(orientation:portrait)_and_(max-width:500px)]:bottom-[calc(env(safe-area-inset-bottom)+4rem)] [@media(orientation:portrait)_and_(max-width:500px)]:z-20 [@media(orientation:portrait)_and_(max-width:500px)]:bg-surface-1/95 [@media(orientation:portrait)_and_(max-width:500px)]:p-1.5 [@media(orientation:portrait)_and_(max-width:500px)]:rounded-xl [@media(orientation:portrait)_and_(max-width:500px)]:shadow-2xl [@media(orientation:portrait)_and_(max-width:500px)]:border [@media(orientation:portrait)_and_(max-width:500px)]:border-line-2';
const PORT_W_SINGLE = '[@media(orientation:portrait)_and_(max-width:500px)]:w-[min(36vw,170px)]';
const PORT_W_DUAL = '[@media(orientation:portrait)_and_(max-width:500px)]:w-[min(58vw,270px)]';
const PORT_BOX = '[@media(orientation:portrait)_and_(max-width:500px)]:aspect-[9/16] [@media(orientation:portrait)_and_(max-width:500px)]:bg-black';
const PORT_SMALL = '[@media(orientation:portrait)_and_(max-width:500px)]:text-[10px] [@media(orientation:landscape)_and_(max-height:500px)]:text-[10px]';
const PORT_HIDE = '[@media(orientation:portrait)_and_(max-width:500px)]:hidden [@media(orientation:landscape)_and_(max-height:500px)]:hidden';
/** 縦のスマートフォンで、カメラの窓が出ている間のメニューの高さ (窓と重ならないように。前も撮るときは窓が低い) */
export const CAMERA_FLOAT_MENU = '[@media(orientation:portrait)_and_(max-width:500px)]:has-[[data-camera-float=single]]:max-h-[calc(100svh-3.5rem-min(64vw,302px)-7.75rem-env(safe-area-inset-bottom))] [@media(orientation:portrait)_and_(max-width:500px)]:has-[[data-camera-float=dual]]:max-h-[calc(100svh-3.5rem-min(52vw,240px)-7.75rem-env(safe-area-inset-bottom))]';

const PRESET_LABEL: Record<CameraPreset, string> = { '1080p30': '1080p · 30fps', '1080p60': '1080p · 60fps', '2160p30': '4K · 30fps', '2160p60': '4K · 60fps' };

type Exposure = { iso: number; shutterSec: number };
type Rect = { x: number; y: number; w: number; h: number };

/**
 * ラップタイマーのメニューの「内蔵カメラ」(2026-10-25)。測定開始で録画を始め、終了で .nmea と同じフォルダに .mov を置く。
 * 向きはラップタイマーの画面の向きに合わせる (ここでは選ばない)。
 * 前と後ろを同時に撮れる端末では、前のカメラ (自分側) も一緒に撮れる (画質・ISO は前と後ろで別々)
 */
export const TimerCameraSettings: React.FC = () => {
  const t = useT();
  const [ok, setOk] = useState(false);
  const [lenses, setLenses] = useState<CameraLens[]>([]);
  const [multiCam, setMultiCam] = useState(false);
  const [s, setS] = useState<CameraSettings>(loadCameraSettings);
  // 撮る前の確かめ: 枠に今の映像を出し、ISO・シャッターの速さを出す
  const boxRef = useRef<HTMLDivElement | null>(null);
  const frontBoxRef = useRef<HTMLDivElement | null>(null);
  const [exposure, setExposure] = useState<{ main?: Exposure; front?: Exposure }>({});
  const [liveError, setLiveError] = useState('');

  useEffect(() => {
    let alive = true;
    void cameraAvailable().then(async yes => {
      if (!alive || !yes) return;
      setOk(true);
      // 起動直後は、カメラの一覧がまだ空のことがある (Android) ので、空なら少し待って聞き直す
      let l = await listLenses();
      for (let i = 0; i < 3 && alive && l.lenses.length === 0; i++) {
        await new Promise(r => setTimeout(r, 1500));
        l = await listLenses();
      }
      if (!alive) return;
      setLenses(l.lenses);
      setMultiCam(l.multiCam);
    });
    return () => { alive = false; };
  }, []);

  const plan = dualPlan(s, lenses, multiCam);
  const dual = !!frontParams(s, plan);

  // 映像を出す (設定を開いている間、録画をオンにしているとき)。枠が動いたら (メニューを動かした) 置き直す。
  // レンズ・画質を替えたときは、消さずに新しい設定で出し直す (消して出すと、カメラを止めて組み直すので、重なると映像が消えたままになった)
  const live = ok && s.enabled;
  const lensKey = `${s.lensId}|${s.preset}|${dual ? s.front.preset : '-'}`;
  const placeRef = useRef<() => void>(() => {});
  const lensesRef = useRef({ lenses, multiCam });
  lensesRef.current = { lenses, multiCam };
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let raf = 0;
    let allowed = false;
    const rectOf = (box: HTMLDivElement | null): Rect | null => {
      const r = box?.getBoundingClientRect();
      if (!box || !r) return null;
      // メニューを動かして枠が少しでも隠れたら、映像は消す (アプリが画面の上に重ねるので、メニューの外にはみ出すため)
      // スマートフォンでは、枠はメニューの外に固定して出すので、隠れることはない
      const wrap = box.closest('[data-camera-float]');
      const fixed = !!wrap && getComputedStyle(wrap).position === 'fixed';
      const clip = fixed ? null : box.closest('.overflow-y-auto')?.getBoundingClientRect();
      const inside = !clip || (r.top >= clip.top - 1 && r.bottom <= clip.bottom + 1);
      return inside ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 };
    };
    const place = () => {
      const main = rectOf(boxRef.current);
      if (!main || !alive || !allowed) return;
      const cur = loadCameraSettings();
      const p = dualPlan(cur, lensesRef.current.lenses, lensesRef.current.multiCam);
      const fp = frontParams(cur, p);
      const frontRect = fp ? rectOf(frontBoxRef.current) : null;
      void callNative('camera.preview', {
        show: true,
        lensId: fp && p ? p.back.id : cur.lensId,
        preset: fp && p && !p.backPresets.includes(cur.preset) ? p.backPresets[0] : cur.preset,
        iso: null,
        ev: cur.ev,
        focusFar: cur.focusFar,
        rect: main,
        front: fp && frontRect ? { ...fp, rect: frontRect } : null
      }).then(() => setLiveError(''), e => setLiveError(e instanceof Error ? e.message : String(e)));
    };
    placeRef.current = place;
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
    void callNative('camera.permission', { request: true, audio: false }).then(p => {
      if (!alive) return;
      if (p.camera !== 'granted') { setLiveError('permission'); return; }
      allowed = true;
      place();
    }).catch(() => {});
    const off = onNative('camera.exposure', e => setExposure(prev => ({ ...prev, [e.which ?? 'main']: { iso: e.iso, shutterSec: e.shutterSec } })));
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      alive = false;
      placeRef.current = () => {};
      cancelAnimationFrame(raf);
      off();
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      void callNative('camera.preview', { show: false }).catch(() => {});
    };
  }, [live]);
  // レンズ・画質・前のカメラを替えた: 出し直す (少し待って、続けて押されたら最後のものだけ。枠の大きさが変わるのを待つ)
  useEffect(() => {
    if (!live) return;
    if (!dual) setExposure(prev => ({ main: prev.main }));
    const id = setTimeout(() => placeRef.current(), 150);
    return () => clearTimeout(id);
  }, [live, lensKey, dual]);

  if (!ok) return null;
  // 前も撮るときは、後ろのカメラは同時に撮れるレンズ・画質だけ
  const backLenses = dual && plan ? lenses.filter(l => l.position === 'back' && (l.multiCamPresets?.length ?? 0) > 0) : lenses;
  const lens = dual && plan ? plan.back : lenses.find(l => l.id === s.lensId) ?? lenses.find(l => l.kind === 'wide') ?? lenses[0];
  const presets = dual && plan ? plan.backPresets : lens?.presets.length ? lens.presets : (['1080p30'] as CameraPreset[]);
  const preset = presets.includes(s.preset) ? s.preset : presets[0];
  const frontPreset = plan && plan.frontPresets.includes(s.front.preset) ? s.front.preset : plan?.frontPresets[0];
  const save = (next: CameraSettings) => { setS(next); saveCameraSettings(next); };
  const update = (patch: Partial<CameraSettings>) => {
    const next = { ...s, ...patch };
    // レンズを替えて、その画質が無ければ撮れる画質に
    const l = lenses.find(x => x.id === next.lensId) ?? lens;
    if (l && l.presets.length && !l.presets.includes(next.preset)) next.preset = l.presets[0];
    save(next);
    // 明るさの補正だけ変えたときは、映像を出し直さずにその場で変える
    if (patch.ev !== undefined && Object.keys(patch).length === 1) void callNative('camera.setEv', { ev: next.ev, which: 'main' }).catch(() => {});
    // ピントの固定を替えたときは、組み直して出し直す
    if (patch.focusFar !== undefined) setTimeout(() => placeRef.current(), 50);
  };
  const updateFront = (patch: Partial<CameraSettings['front']>) => {
    const next = { ...s, front: { ...s.front, ...patch } };
    // 前を撮るなら、後ろのレンズ・画質を同時に撮れるものに
    if (next.front.enabled) {
      const p = dualPlan(next, lenses, multiCam);
      if (p) {
        next.lensId = p.back.id;
        if (!p.backPresets.includes(next.preset)) next.preset = p.backPresets[0];
      }
    }
    save(next);
    if (patch.ev !== undefined && Object.keys(patch).length === 1) void callNative('camera.setEv', { ev: patch.ev, which: 'front' }).catch(() => {});
  };
  const shutter = (sec: number) => (sec > 0 && sec < 0.5 ? `1/${Math.round(1 / sec)}` : `${sec.toFixed(2)}`);
  const lensName = (l: CameraLens) => {
    if (l.kind === 'front') return t('前 (自分側)', 'Front');
    const z = `${l.zoom}×`;
    return l.kind === 'ultraWide' ? t(`超広角 ${z}`, `Ultra wide ${z}`) : l.kind === 'tele' ? t(`望遠 ${z}`, `Telephoto ${z}`) : t(`広角 ${z}`, `Wide ${z}`);
  };
  const pill = (on: boolean) => `px-2.5 py-1.5 rounded-lg text-xs ${on ? 'bg-red-600 text-white' : 'bg-surface-2 text-slate-300'}`;
  const errorText = liveError === 'permission' ? t('カメラの許可がありません (設定アプリで許可してください)', 'No camera access (allow it in Settings)')
    : liveError.includes('multicam-cost') ? t('前と後ろを一緒に撮るには重すぎます。画質を下げてください', 'Too heavy to record both cameras. Lower the quality')
    : liveError ? t('映像を出せません', 'Cannot show the camera') : '';
  const box = (ref: React.RefObject<HTMLDivElement | null>, which: 'main' | 'front', label: string) => {
    const e = exposure[which];
    return (
      <div className="flex-1 min-w-0 space-y-1">
        <div ref={ref} className={`w-full aspect-video rounded-lg bg-black/60 border border-line-3 flex items-center justify-center text-center text-[11px] text-slate-500 ${LAND} ${PORT_BOX}`} data-testid={which === 'main' ? 'lap-timer-camera-live' : 'lap-timer-camera-live-front'}>
          {errorText || label}
        </div>
        {e && (
          <div className={`text-[11px] ${PORT_SMALL} text-slate-400 font-mono truncate`} data-testid={which === 'main' ? 'lap-timer-camera-exposure' : 'lap-timer-camera-exposure-front'}>
            ISO {Math.round(e.iso)}<span className={PORT_HIDE}> ・</span> <span className={PORT_HIDE}>{t('シャッター', 'Shutter')} </span>{shutter(e.shutterSec)}<span className={PORT_HIDE}> {t('秒', 's')}</span>
          </div>
        )}
      </div>
    );
  };
  // 明るさの補正 (EV)。0 が自動のまま、マイナスで暗め
  const evLabel = (v: number) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`);
  const evRow = (cur: number, set: (v: number) => void, testId: string) => (
    <div className="flex flex-wrap gap-1" data-testid={testId}>
      {EV_CHOICES.map(v => <button key={v} onClick={() => set(v)} className={pill(cur === v)}>{evLabel(v)}</button>)}
    </div>
  );

  return (
    <div data-testid="lap-timer-camera">
      <div className="text-slate-400 text-xs mb-1 flex items-center gap-1"><Video size={12} />{t('内蔵カメラ', 'Built-in camera')}</div>
      <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2 cursor-pointer">
        <input type="checkbox" checked={s.enabled} onChange={e => update({ enabled: e.target.checked })} data-testid="lap-timer-camera-on" />
        <span className="flex-1">{t('測っている間、録画する', 'Record while measuring')}</span>
      </label>
      {s.enabled && (
        <div className="mt-2 space-y-2 pl-1">
          {/* 今の映像 (アプリが枠の上に重ねて出す)。ここで ISO を変えると、その場で映像に出る */}
          {/* 横向きのスマートフォンは高さが足りず、ISO のボタンまで動かすと枠が隠れるので、映像と ISO・シャッターの速さは画面の左の空いた所に固定して出す。
              縦のスマートフォンは、メニューの下に縦長の窓で出す (メニューはその分短くする。LapTimerScreen の CAMERA_FLOAT_MENU) */}
          <div className={`flex gap-1.5 ${LAND_WRAP} ${PORT_WRAP} ${dual ? PORT_W_DUAL : PORT_W_SINGLE}`} data-camera-float={dual ? 'dual' : 'single'} data-testid="lap-timer-camera-live-wrap">
            {box(boxRef, 'main', dual ? t('後ろ', 'Back') : t('カメラの映像', 'Camera view'))}
            {dual && box(frontBoxRef, 'front', t('前', 'Front'))}
          </div>
          {dual && <div className="text-[11px] text-slate-300 font-medium">{t('後ろのカメラ', 'Back camera')}</div>}
          {backLenses.length > 0 && (
            <div>
              <div className="text-[11px] text-slate-500 mb-1">{t('レンズ', 'Lens')}</div>
              <div className="flex flex-wrap gap-1">
                {backLenses.map(l => <button key={l.id} onClick={() => update({ lensId: l.id })} className={pill(l.id === lens?.id)}>{lensName(l)}</button>)}
              </div>
            </div>
          )}
          <div>
            <div className="text-[11px] text-slate-500 mb-1">{t('画質', 'Quality')}</div>
            <div className="flex flex-wrap gap-1">
              {presets.map(p => <button key={p} onClick={() => update({ preset: p })} className={pill(p === preset)}>{PRESET_LABEL[p]}</button>)}
            </div>
          </div>
          {/* 明るさの補正 (2026-10-25 に ISO から替えた)。露出は自動のまま、全体を暗め・明るめにする */}
          <div>
            <div className="text-[11px] text-slate-500 mb-1">{t('明るさの補正 (マイナスで暗め。車内に合って窓の外が白く飛ぶときは −1〜−2)', 'Brightness (EV). Use −1 to −2 if the view outside the windows is blown out')}</div>
            {evRow(s.ev ?? 0, v => update({ ev: v }), 'lap-timer-camera-ev')}
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={s.focusFar !== false} onChange={e => update({ focusFar: e.target.checked })} data-testid="lap-timer-camera-focus-far" />
            {t('ピントを遠くに合わせて固定する (車載向け。車内の物にピントが移らない)', 'Lock focus far away (for onboard; focus never jumps to the cabin)')}
          </label>
          {plan && (
            <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2 cursor-pointer">
              <input type="checkbox" checked={s.front.enabled} onChange={e => updateFront({ enabled: e.target.checked })} data-testid="lap-timer-camera-front-on" />
              <span className="flex-1">
                {t('前のカメラ (自分側) も一緒に録画する', 'Also record the front camera')}
                <span className="block text-[10px] text-slate-500">{t('画質は 2 つとも同時に撮れるもの (1080p まで) になり、熱くなりやすくなります', 'Both use quality that can run together (up to 1080p); the phone gets hotter')}</span>
              </span>
            </label>
          )}
          {dual && plan && (
            <div className="space-y-2 pl-2 border-l-2 border-line-3" data-testid="lap-timer-camera-front">
              <div className="text-[11px] text-slate-300 font-medium">{t('前のカメラ', 'Front camera')}</div>
              <div>
                <div className="text-[11px] text-slate-500 mb-1">{t('画質', 'Quality')}</div>
                <div className="flex flex-wrap gap-1">
                  {plan.frontPresets.map(p => <button key={p} onClick={() => updateFront({ preset: p })} className={pill(p === frontPreset)}>{PRESET_LABEL[p]}</button>)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500 mb-1">{t('明るさの補正', 'Brightness (EV)')}</div>
                {evRow(s.front.ev ?? 0, v => updateFront({ ev: v }), 'lap-timer-camera-front-ev')}
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={s.audio} onChange={e => update({ audio: e.target.checked })} />
            {t('音も録る (エンジンの音)', 'Record sound (engine)')}
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={s.preview} onChange={e => update({ preview: e.target.checked })} />
            {t('撮り始めの 5 秒だけ、映像を小さく出す', 'Show a small preview for the first 5 seconds')}
          </label>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            {t('向きはラップタイマーの画面の向きに合わせます。動画は走行のログ (.nmea) と同じフォルダに .mov で置き、走行の画面から開くと同期済みで出ます (前のカメラは _front.mov)。熱くなりすぎたら録画だけ止めて、ログの記録は続けます。',
              'The video follows the lap timer orientation. It is saved as .mov next to the run log (.nmea) and opens already synced from Runs (front camera: _front.mov). If the phone gets too hot, only the recording stops; the log keeps going.')}
          </p>
        </div>
      )}
    </div>
  );
};
