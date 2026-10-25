import React, { useEffect, useState } from 'react';
import { Video } from 'lucide-react';
import { useT } from '../utils/i18n';
import type { CameraLens, CameraPreset } from '../native/contract';
import { cameraAvailable, isoChoices, listLenses, loadCameraSettings, saveCameraSettings, type CameraSettings } from '../services/timer/phoneCamera';

const PRESET_LABEL: Record<CameraPreset, string> = { '1080p30': '1080p · 30fps', '1080p60': '1080p · 60fps', '2160p30': '4K · 30fps', '2160p60': '4K · 60fps' };

/**
 * ラップタイマーのメニューの「内蔵カメラ」(2026-10-25)。測定開始で録画を始め、終了で .nmea と同じフォルダに .mov を置く。
 * 向きはラップタイマーの画面の向きに合わせる (ここでは選ばない)
 */
export const TimerCameraSettings: React.FC = () => {
  const t = useT();
  const [ok, setOk] = useState(false);
  const [lenses, setLenses] = useState<CameraLens[]>([]);
  const [s, setS] = useState<CameraSettings>(loadCameraSettings);

  useEffect(() => {
    let alive = true;
    void cameraAvailable().then(async yes => {
      if (!alive || !yes) return;
      setOk(true);
      const l = await listLenses();
      if (alive) setLenses(l);
    });
    return () => { alive = false; };
  }, []);

  if (!ok) return null;
  const lens = lenses.find(l => l.id === s.lensId) ?? lenses.find(l => l.kind === 'wide') ?? lenses[0];
  const presets = lens?.presets.length ? lens.presets : (['1080p30'] as CameraPreset[]);
  const update = (patch: Partial<CameraSettings>) => {
    const next = { ...s, ...patch };
    // レンズを替えて、その画質が無ければ撮れる画質に
    const l = lenses.find(x => x.id === next.lensId) ?? lens;
    if (l && l.presets.length && !l.presets.includes(next.preset)) next.preset = l.presets[0];
    setS(next);
    saveCameraSettings(next);
  };
  const lensName = (l: CameraLens) => {
    if (l.kind === 'front') return t('前 (自分側)', 'Front');
    const z = `${l.zoom}×`;
    return l.kind === 'ultraWide' ? t(`超広角 ${z}`, `Ultra wide ${z}`) : l.kind === 'tele' ? t(`望遠 ${z}`, `Telephoto ${z}`) : t(`広角 ${z}`, `Wide ${z}`);
  };
  const pill = (on: boolean) => `px-2.5 py-1.5 rounded-lg text-xs ${on ? 'bg-red-600 text-white' : 'bg-surface-2 text-slate-300'}`;

  return (
    <div data-testid="lap-timer-camera">
      <div className="text-slate-400 text-xs mb-1 flex items-center gap-1"><Video size={12} />{t('内蔵カメラ', 'Built-in camera')}</div>
      <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2 cursor-pointer">
        <input type="checkbox" checked={s.enabled} onChange={e => update({ enabled: e.target.checked })} data-testid="lap-timer-camera-on" />
        <span className="flex-1">{t('測っている間、録画する', 'Record while measuring')}</span>
      </label>
      {s.enabled && (
        <div className="mt-2 space-y-2 pl-1">
          {lenses.length > 0 && (
            <div>
              <div className="text-[11px] text-slate-500 mb-1">{t('レンズ', 'Lens')}</div>
              <div className="flex flex-wrap gap-1">
                {lenses.map(l => <button key={l.id} onClick={() => update({ lensId: l.id })} className={pill(l.id === lens?.id)}>{lensName(l)}</button>)}
              </div>
            </div>
          )}
          <div>
            <div className="text-[11px] text-slate-500 mb-1">{t('画質', 'Quality')}</div>
            <div className="flex flex-wrap gap-1">
              {presets.map(p => <button key={p} onClick={() => update({ preset: p })} className={pill(p === s.preset)}>{PRESET_LABEL[p]}</button>)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500 mb-1">{t('ISO 感度 (決めると、シャッターの速さで明るさを合わせます)', 'ISO (when fixed, shutter speed keeps the exposure)')}</div>
            <div className="flex flex-wrap gap-1">
              <button onClick={() => update({ iso: null })} className={pill(s.iso === null)}>{t('自動', 'Auto')}</button>
              {isoChoices(lens).map(v => <button key={v} onClick={() => update({ iso: v })} className={pill(s.iso === v)}>{v}</button>)}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={s.audio} onChange={e => update({ audio: e.target.checked })} />
            {t('音も録る (エンジンの音)', 'Record sound (engine)')}
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={s.preview} onChange={e => update({ preview: e.target.checked })} />
            {t('撮り始めの 5 秒だけ、映像を小さく出す', 'Show a small preview for the first 5 seconds')}
          </label>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            {t('向きはラップタイマーの画面の向きに合わせます。動画は走行のログ (.nmea) と同じフォルダに .mov で置き、走行の画面から開くと同期済みで出ます。熱くなりすぎたら録画だけ止めて、ログの記録は続けます。',
              'The video follows the lap timer orientation. It is saved as .mov next to the run log (.nmea) and opens already synced from Runs. If the phone gets too hot, only the recording stops; the log keeps going.')}
          </p>
        </div>
      )}
    </div>
  );
};
