/**
 * メーターの配置エディタ (PLAN-08 の 3。パソコンだけ)。
 * - OverlayEditLayer: 動画の上 (メーターを描く四角と同じ所) に、部品の枠を出す。つかんで動かし、右下の角で大きさを変える。
 *   映像の 1% ごとに吸い付く。外側 5% の安全な枠 (編集ソフト・テレビで切れない範囲) を線で出す
 * - OverlayEditPanel: 並びの選び・部品の一覧 (足す・消す・出す / 出さない)・選んだ部品の設定・保存
 */
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Save, Trash2, X, Download, Upload, ArrowLeftRight } from 'lucide-react';
import { useT } from '../../utils/i18n';
import {
  BUILTIN_LAYOUTS, CHANNELS, PART_LABELS, partChannels, partLabel,
  type ChannelId, type OverlayLayout, type OverlayPart, type OverlayPartType
} from '../../services/overlayLayout';

/** 吸い付く目盛り (映像の割合) */
const SNAP = 0.01;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** 部品の最小の大きさ (映像の割合) */
const MIN_SIZE = 0.02;

export const OverlayEditLayer: React.FC<{
  parts: OverlayPart[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (parts: OverlayPart[]) => void;
}> = ({ parts, selected, onSelect, onChange }) => {
  const t = useT();
  const ja = t('ja', 'en') === 'ja';
  const hostRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: OverlayPart; pointerId: number } | null>(null);
  const begin = (e: React.PointerEvent, part: OverlayPart, mode: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(part.id);
    drag.current = { id: part.id, mode, startX: e.clientX, startY: e.clientY, orig: part, pointerId: e.pointerId };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const host = hostRef.current;
    if (!d || !host || e.pointerId !== d.pointerId) return;
    const r = host.getBoundingClientRect();
    const dx = (e.clientX - d.startX) / r.width, dy = (e.clientY - d.startY) / r.height;
    const o = d.orig;
    const next = d.mode === 'move'
      ? { ...o, x: clamp(snap(o.x + dx), 0, 1 - o.w), y: clamp(snap(o.y + dy), 0, 1 - o.h) }
      : { ...o, w: clamp(snap(o.w + dx), MIN_SIZE, 1 - o.x), h: clamp(snap(o.h + dy), MIN_SIZE, 1 - o.y) };
    onChange(parts.map(p => (p.id === d.id ? next : p)));
  };
  const end = (e: React.PointerEvent) => {
    if (drag.current && e.pointerId === drag.current.pointerId) drag.current = null;
  };
  // キー: 矢印で選んだ部品を 1% 動かす、Shift + 矢印で大きさを変える
  const latest = useRef({ parts, selected, onChange });
  latest.current = { parts, selected, onChange };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { parts: ps, selected: sel, onChange: change } = latest.current;
      if (!sel || !/^Arrow/.test(e.key)) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const p = ps.find(x => x.id === sel);
      if (!p) return;
      e.preventDefault();
      const dx = e.key === 'ArrowLeft' ? -SNAP : e.key === 'ArrowRight' ? SNAP : 0;
      const dy = e.key === 'ArrowUp' ? -SNAP : e.key === 'ArrowDown' ? SNAP : 0;
      const next = e.shiftKey
        ? { ...p, w: clamp(snap(p.w + dx), MIN_SIZE, 1 - p.x), h: clamp(snap(p.h + dy), MIN_SIZE, 1 - p.y) }
        : { ...p, x: clamp(snap(p.x + dx), 0, 1 - p.w), y: clamp(snap(p.y + dy), 0, 1 - p.h) };
      change(ps.map(x => (x.id === sel ? next : x)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div
      ref={hostRef}
      className="absolute inset-0 z-[16] cursor-default"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerDown={() => onSelect(null)}
      // 枠を押したときの click を、下の動画の枠 (押すと大きく出す) へ伝えない
      onClick={e => e.stopPropagation()}
      data-testid="overlay-edit-layer"
    >
      {/* 安全な枠 (外側 5%) */}
      <div className="absolute pointer-events-none border border-dashed border-white/25" style={{ left: '5%', top: '5%', right: '5%', bottom: '5%' }} />
      {parts.map(p => {
        const on = p.id === selected;
        return (
          <div
            key={p.id}
            onPointerDown={e => begin(e, p, 'move')}
            className={`absolute cursor-move border ${on ? 'border-sky-400 bg-sky-400/10' : 'border-white/40 hover:border-white/80'}`}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` }}
            title={partLabel(p, ja)}
            role="button"
            aria-label={t(`${partLabel(p, ja)} (矢印で動かす・Shift + 矢印で大きさ)`, `${partLabel(p, ja)} (arrows move, Shift + arrows resize)`)}
            aria-pressed={on}
            data-testid={`overlay-edit-part-${p.id}`}
          >
            {on && (
              <span className="absolute -top-5 left-0 text-[10px] whitespace-nowrap bg-sky-600 text-white px-1 rounded pointer-events-none">
                {partLabel(p, ja)}
              </span>
            )}
            <span
              onPointerDown={e => begin(e, p, 'resize')}
              className={`absolute -right-2 -bottom-2 w-4 h-4 rounded-sm cursor-nwse-resize ${on ? 'bg-sky-400' : 'bg-white/70'}`}
              data-testid={`overlay-edit-resize-${p.id}`}
            />
          </div>
        );
      })}
    </div>
  );
};

/** 足せる部品と、その既定の形 (映像の真ん中あたりに置く) */
function newPart(type: OverlayPartType, id: string, channel: ChannelId): OverlayPart {
  const base = { id, x: 0.4, y: 0.4, w: 0.15, h: 0.12 };
  switch (type) {
    case 'bar': return { ...base, type, channel, w: 0.03, h: 0.18 };
    case 'value': return { ...base, type, channel, w: 0.1, h: 0.07 };
    case 'graph': return { ...base, type, channels: [channel], window: 'lap', compare: true, x: 0.2, y: 0.8, w: 0.6, h: 0.17 };
    case 'steering': return { ...base, type, w: 0.1, h: 0.17 };
    case 'map': return { ...base, type, compare: true, w: 0.2, h: 0.32 };
    case 'zoomMap': return { ...base, type, spanM: 140, headingUp: false, compare: true, photo: true, w: 0.2, h: 0.3 };
    case 'delta': return { ...base, type, maxSec: 1, w: 0.24, h: 0.06 };
    case 'gmeter': return { ...base, type, w: 0.13, h: 0.18 };
    case 'lapPanel': return { ...base, type, w: 0.245, h: 0.4 };
    default: return { ...base, type } as OverlayPart;
  }
}

const ADDABLE: OverlayPartType[] = ['bar', 'value', 'steering', 'graph', 'map', 'zoomMap', 'delta', 'speed', 'gmeter', 'lapPanel', 'lapClock'];

export const OverlayEditPanel: React.FC<{
  draft: OverlayLayout;
  /** 元の並び (同梱か自分の並び) */
  baseId: string;
  custom: OverlayLayout[];
  channels: Set<ChannelId>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (parts: OverlayPart[]) => void;
  onPickBase: (id: string) => void;
  onSave: (name: string) => Promise<string | null>;
  onDelete: () => Promise<void>;
  onExport?: () => void;
  onImport?: (file: File) => void;
  onClose: () => void;
}> = ({ draft, baseId, custom, channels, selected, onSelect, onChange, onPickBase, onSave, onDelete, onExport, onImport, onClose }) => {
  const t = useT();
  const ja = t('ja', 'en') === 'ja';
  const [name, setName] = useState(baseId.startsWith('user:') ? draft.name[0] : '');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [addType, setAddType] = useState<OverlayPartType>('bar');
  // 欄を左右どちらに出すか (下に隠れた部品を動かせるように)
  const [side, setSide] = useState<'right' | 'left'>('right');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const firstChannel = (['throttle', 'brake', 'speed'] as ChannelId[]).find(c => channels.has(c)) ?? 'speed';
  const sel = draft.parts.find(p => p.id === selected) ?? null;
  const update = (patch: Partial<OverlayPart>) => sel && onChange(draft.parts.map(p => (p.id === sel.id ? { ...p, ...patch } as OverlayPart : p)));
  const add = () => {
    let i = draft.parts.length + 1;
    while (draft.parts.some(p => p.id === `p${i}`)) i++;
    const part = newPart(addType, `p${i}`, firstChannel);
    onChange([...draft.parts, part]);
    onSelect(part.id);
  };
  const channelSelect = (value: ChannelId, set: (c: ChannelId) => void, testId: string) => (
    <select value={value} onChange={e => set(e.target.value as ChannelId)} className="w-full bg-surface-1 border border-line-3 text-xs px-2 py-1 rounded text-slate-200" data-testid={testId}>
      {Object.values(CHANNELS).map(c => (
        <option key={c.id} value={c.id} disabled={!channels.has(c.id)}>{c.label[ja ? 0 : 1]}{channels.has(c.id) ? '' : t(' (このログに無い)', ' (not in this log)')}</option>
      ))}
    </select>
  );
  const save = async () => {
    const n = name.trim();
    if (!n) { setNote({ ok: false, text: t('名前を付けてください', 'Enter a name') }); return; }
    // 同じファイルの名前になるほかの並び (大文字・小文字、空白と _ の違いだけのもの) は、上書きしてよいか聞く
    const stem = (v: string) => v.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(0, 40).toLowerCase();
    const clash = custom.find(l => l.id !== baseId && stem(l.id.slice(5)) === stem(n));
    if (clash && !window.confirm(t(`「${clash.name[0]}」と同じファイルになります。上書きしますか？`, `This overwrites "${clash.name[0]}". Continue?`))) return;
    const e = await onSave(n);
    setNote(e ? { ok: false, text: e } : { ok: true, text: t(`「${n}」を保存しました`, `Saved "${n}"`) });
  };
  const input = 'w-full bg-surface-1 border border-line-3 text-xs px-2 py-1 rounded text-slate-200 outline-none focus:border-sky-500';
  return (
    <div className={`absolute top-2 bottom-2 ${side === 'right' ? 'right-2' : 'left-2'} z-30 w-72 max-w-[45%] flex flex-col bg-surface-1/95 border border-line-2 rounded-xl shadow-2xl text-xs`} data-testid="overlay-edit-panel" onPointerDown={e => e.stopPropagation()}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line-2">
        <span className="font-bold text-slate-100 flex-1">{t('メーターの配置', 'Meter layout')}</span>
        <button onClick={() => setSide(s => (s === 'right' ? 'left' : 'right'))} className="p-1 rounded hover:bg-surface-3 text-slate-400 cursor-pointer" title={t('この欄を反対側へ (下に隠れた部品を動かすとき)', 'Move this panel to the other side (to reach parts under it)')} data-testid="overlay-edit-side"><ArrowLeftRight size={14} /></button>
        <button onClick={onClose} className="p-1 rounded hover:bg-surface-3 text-slate-400 cursor-pointer" aria-label={t('閉じる', 'Close')} data-testid="overlay-edit-close"><X size={14} /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3">
        <label className="block space-y-1">
          <span className="text-[10px] text-slate-400">{t('元にする並び', 'Start from')}</span>
          <select value={baseId} onChange={e => onPickBase(e.target.value)} className={input} data-testid="overlay-edit-base">
            {BUILTIN_LAYOUTS.map(l => <option key={l.id} value={l.id}>{t(l.name[0], l.name[1])}</option>)}
            {custom.map(l => <option key={l.id} value={l.id}>{l.name[0]}</option>)}
          </select>
        </label>
        <div className="space-y-1">
          <span className="text-[10px] text-slate-400">{t('部品 (押すと選ぶ。動画の上でつかんで動かし、右下の角で大きさを変える)', 'Parts (click to select; drag on the video to move, drag the corner to resize)')}</span>
          <div className="space-y-0.5" data-testid="overlay-edit-parts">
            {draft.parts.map(p => {
              const missing = partChannels(p).some(c => !channels.has(c));
              return (
                <div key={p.id} className={`flex items-center gap-1 rounded px-1.5 py-1 cursor-pointer ${p.id === selected ? 'bg-sky-600/20 border border-sky-500/50' : 'hover:bg-surface-3 border border-transparent'}`} onClick={() => onSelect(p.id)}>
                  <span className={`flex-1 min-w-0 truncate ${missing ? 'text-slate-500' : 'text-slate-200'}`}>{partLabel(p, ja)}{missing ? t(' (このログに無い)', ' (not in this log)') : ''}</span>
                  <button onClick={e => { e.stopPropagation(); onChange(draft.parts.filter(x => x.id !== p.id)); if (p.id === selected) onSelect(null); }} className="p-0.5 text-slate-500 hover:text-red-400 cursor-pointer" aria-label={t(`${partLabel(p, ja)} を消す`, `Remove ${partLabel(p, ja)}`)}><Trash2 size={12} /></button>
                </div>
              );
            })}
          </div>
          <div className="flex gap-1 pt-1">
            <select value={addType} onChange={e => setAddType(e.target.value as OverlayPartType)} className={input} data-testid="overlay-edit-add-type">
              {ADDABLE.map(type => <option key={type} value={type}>{PART_LABELS[type][ja ? 0 : 1]}</option>)}
            </select>
            <button onClick={add} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded bg-surface-3 border border-line-3 text-slate-200 cursor-pointer" data-testid="overlay-edit-add"><Plus size={12} />{t('足す', 'Add')}</button>
          </div>
        </div>
        {sel && (
          <div className="space-y-1.5 border-t border-line-2 pt-2" data-testid="overlay-edit-props">
            <div className="font-bold text-slate-300">{partLabel(sel, ja)}</div>
            {(sel.type === 'bar' || sel.type === 'value') && channelSelect(sel.channel, c => update({ channel: c, label: undefined } as Partial<OverlayPart>), 'overlay-edit-channel')}
            {sel.type === 'graph' && (
              <>
                {[0, 1, 2].map(i => (
                  <select key={i} value={sel.channels[i] ?? ''} onChange={e => {
                    const next = [...sel.channels];
                    if (e.target.value) next[i] = e.target.value as ChannelId; else next.splice(i, 1);
                    if (next.length) update({ channels: next.filter(Boolean) } as Partial<OverlayPart>);
                  }} className={input} data-testid={`overlay-edit-graph-${i}`}>
                    {i > 0 && <option value="">{t('なし', 'None')}</option>}
                    {Object.values(CHANNELS).map(c => <option key={c.id} value={c.id} disabled={!channels.has(c.id)}>{c.label[ja ? 0 : 1]}</option>)}
                  </select>
                ))}
                <label className="flex items-center gap-2 text-slate-300">
                  {t('横軸', 'X axis')}
                  <select value={sel.window === 'lap' || sel.window === undefined ? 'lap' : String(sel.window)} onChange={e => update({ window: e.target.value === 'lap' ? 'lap' : Number(e.target.value) } as Partial<OverlayPart>)} className={input}>
                    <option value="lap">{t('周全体', 'Whole lap')}</option>
                    {[10, 20, 30].map(s => <option key={s} value={s}>{t(`前後 ${s} 秒`, `${s} s around now`)}</option>)}
                  </select>
                </label>
              </>
            )}
            {sel.type === 'zoomMap' && (
              <>
                <label className="block">{t('横幅に入る距離 (m)', 'Width shown (m)')}<input type="number" min={20} max={2000} value={sel.spanM ?? 140} onChange={e => update({ spanM: Math.max(20, Math.min(2000, Number(e.target.value) || 140)) } as Partial<OverlayPart>)} className={input} /></label>
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={sel.headingUp === true} onChange={e => update({ headingUp: e.target.checked } as Partial<OverlayPart>)} />
                  {t('進む向きを上にする (地図の左右が車の左右になる)', 'Direction of travel up (map left/right = car left/right)')}
                </label>
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={sel.photo !== false} onChange={e => update({ photo: e.target.checked } as Partial<OverlayPart>)} />
                  {t('航空写真 (国土地理院。インターネットが要る)', 'Aerial photo (GSI; needs internet)')}
                </label>
              </>
            )}
            {(sel.type === 'graph' || sel.type === 'map' || sel.type === 'zoomMap') && (
              <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                <input type="checkbox" checked={!!sel.compare} onChange={e => update({ compare: e.target.checked } as Partial<OverlayPart>)} />
                {t('比べる周も出す', 'Show the compared lap')}
              </label>
            )}
            {sel.type === 'bar' && (
              <>
                <div className="flex gap-1">
                  <label className="flex-1">{t('最小', 'Min')}<input type="number" value={sel.min ?? CHANNELS[sel.channel].min} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v < (sel.max ?? CHANNELS[sel.channel].max)) update({ min: v } as Partial<OverlayPart>); }} className={input} /></label>
                  <label className="flex-1">{t('最大', 'Max')}<input type="number" value={sel.max ?? CHANNELS[sel.channel].max} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v > (sel.min ?? CHANNELS[sel.channel].min)) update({ max: v } as Partial<OverlayPart>); }} className={input} /></label>
                </div>
                <div className="flex gap-2 items-center">
                  <label className="flex items-center gap-1">{t('色', 'Color')}<input type="color" value={sel.color ?? '#38bdf8'} onChange={e => update({ color: e.target.value } as Partial<OverlayPart>)} /></label>
                  <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={!!sel.horizontal} onChange={e => update({ horizontal: e.target.checked } as Partial<OverlayPart>)} />{t('横向き', 'Horizontal')}</label>
                </div>
              </>
            )}
            {(sel.type === 'bar' || sel.type === 'value') && (
              <label className="block">{t('札', 'Label')}<input value={sel.label ?? ''} placeholder={CHANNELS[sel.channel].short} onChange={e => update({ label: e.target.value.slice(0, 12) || undefined } as Partial<OverlayPart>)} className={input} /></label>
            )}
            {sel.type === 'steering' && (
              <label className="block">{t('絵の振れの上限 (度)', 'Max rotation (deg)')}<input type="number" value={sel.maxDeg ?? 540} onChange={e => update({ maxDeg: Math.max(30, Math.min(1080, Number(e.target.value) || 540)) } as Partial<OverlayPart>)} className={input} /></label>
            )}
            {sel.type === 'delta' && (
              <label className="block">{t('振れの上限 (秒)', 'Full scale (s)')}<input type="number" step="0.1" value={sel.maxSec ?? 1} onChange={e => update({ maxSec: Math.max(0.1, Math.min(10, Number(e.target.value) || 1)) } as Partial<OverlayPart>)} className={input} /></label>
            )}
            <label className="block">{t('不透明度', 'Opacity')}<input type="range" min={0.2} max={1} step={0.05} value={sel.opacity ?? 1} onChange={e => update({ opacity: Number(e.target.value) } as Partial<OverlayPart>)} className="w-full" /></label>
            <div className="text-[10px] text-slate-500 font-mono">x {sel.x.toFixed(2)} · y {sel.y.toFixed(2)} · w {sel.w.toFixed(2)} · h {sel.h.toFixed(2)}</div>
          </div>
        )}
      </div>
      <div className="border-t border-line-2 px-3 py-2 space-y-1.5">
        <div className="flex gap-1">
          <input value={name} onChange={e => setName(e.target.value.slice(0, 40))} placeholder={t('並びの名前', 'Layout name')} className={input} data-testid="overlay-edit-name" />
          <button onClick={() => void save()} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer" data-testid="overlay-edit-save"><Save size={12} />{t('保存', 'Save')}</button>
        </div>
        <div className="flex gap-1 flex-wrap">
          {baseId.startsWith('user:') && (
            <button onClick={() => { if (window.confirm(t(`「${draft.name[0]}」を消しますか？`, `Delete "${draft.name[0]}"?`))) void onDelete(); }} className="flex items-center gap-1 px-2 py-1 rounded border border-line-3 text-slate-400 hover:text-red-400 cursor-pointer" data-testid="overlay-edit-delete"><Trash2 size={12} />{t('この並びを消す', 'Delete layout')}</button>
          )}
          {onExport && <button onClick={onExport} className="flex items-center gap-1 px-2 py-1 rounded border border-line-3 text-slate-300 cursor-pointer"><Download size={12} />{t('書き出す', 'Export')}</button>}
          {onImport && (
            <>
              <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 px-2 py-1 rounded border border-line-3 text-slate-300 cursor-pointer"><Upload size={12} />{t('読み込む', 'Import')}</button>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }} />
            </>
          )}
        </div>
        {note && <p className={`text-[11px] ${note.ok ? 'text-slate-400' : 'text-amber-500'}`}>{note.text}</p>}
      </div>
    </div>
  );
};
