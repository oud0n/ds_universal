/**
 * 設定の「CSV の形式」(PLAN-36)。形式の定義と計算式の一覧。作る・直すのはパソコンだけ (スマートフォンは一覧を見るだけ)
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileSpreadsheet, Plus, Trash2, Save, X, Upload, Calculator } from 'lucide-react';
import { useT } from '../utils/i18n';
import { useCompactLayout } from '../hooks/useCompactLayout';
import { deleteCsvFormat, safeName, saveCalcChannels, saveCsvFormat, useCsvFormats } from '../services/csvFormatStore';
import { guessDelimiter, sensorKeyOf, splitRow, validTimezone, type ColumnSpec, type ColumnTarget, type CsvFormat, type TimeAs } from '../services/csvFormats';
import { BUILTIN_VALUE_NAMES, exprVars, parseExpr, type CalcChannel } from '../services/calcChannels';
import { CUSTOM_KEY_RE } from '../services/overlayLayout';

export const CsvFormatSettings: React.FC = () => {
  const t = useT();
  const compact = useCompactLayout();
  const { formats, calc } = useCsvFormats();
  const [editing, setEditing] = useState<CsvFormat | 'new' | null>(null);
  const [calcOpen, setCalcOpen] = useState(false);
  return (
    <section className="space-y-2" data-testid="csv-format-settings">
      <h3 className="text-xs text-slate-500 px-1">{t('CSV の形式・計算式', 'CSV formats and formulas')}</h3>
      <div className="rounded-xl bg-surface-1 border border-line-2 p-3 space-y-2 text-xs text-slate-300">
        <p className="text-[11px] text-slate-500">
          {t('ほかの機器・アプリの CSV の列が何の値かを決めておくと、ファイルを開くとき・走行を開くとき (走行の横の <走行>.<名前>.csv) に自動で読みます。作る・直すのはパソコンで。',
            'Define what each column of other devices\' CSV files means, and they are read automatically when you open the file or the run (the <run>.<name>.csv next to it). Create and edit them on a computer.')}
        </p>
        {formats.length === 0 && <p className="text-slate-500">{t('まだありません', 'None yet')}</p>}
        {formats.map(f => (
          <div key={f.id} className="flex items-center gap-2" data-testid="csv-format-row">
            <FileSpreadsheet size={14} className="text-slate-400 shrink-0" />
            <span className="flex-1 truncate">{f.name}</span>
            <span className="text-[10px] text-slate-500">{f.kind === 'sensor' ? `*.${f.sensorKey}.csv` : t('走行の CSV', 'Run CSV')}</span>
            {!compact && <button onClick={() => setEditing(f)} className="px-2 py-0.5 rounded border border-line-3 cursor-pointer" data-testid="csv-format-edit">{t('直す', 'Edit')}</button>}
          </div>
        ))}
        {calc.length > 0 && <p className="text-[11px] text-slate-400">{t(`計算式: ${calc.map(c => c.label).join('・')}`, `Formulas: ${calc.map(c => c.label).join(', ')}`)}</p>}
        {!compact ? (
          <div className="flex gap-2 pt-1">
            <button onClick={() => setEditing('new')} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer" data-testid="csv-format-new"><Plus size={13} />{t('CSV の形式を作る', 'New CSV format')}</button>
            <button onClick={() => setCalcOpen(true)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-3 border border-line-3 cursor-pointer" data-testid="calc-open"><Calculator size={13} />{t('計算式', 'Formulas')}</button>
          </div>
        ) : (
          <p className="text-[11px] text-slate-500">{t('作る・直すのは、パソコン (デスクトップ版・ブラウザ版) の設定で。', 'Create and edit on a computer (desktop app or browser).')}</p>
        )}
      </div>
      {editing && <CsvFormatEditor initial={editing === 'new' ? null : editing} others={formats} onClose={() => setEditing(null)} />}
      {calcOpen && <CalcEditor initial={calc} onClose={() => setCalcOpen(false)} />}
    </section>
  );
};

/** 列の行き先の選び */
const TARGETS: Array<[ColumnTarget | '' | 'custom', string, string]> = [
  ['', '使わない', 'Not used'],
  ['lat', '緯度', 'Latitude'],
  ['lon', '経度', 'Longitude'],
  ['alt', '標高 (m)', 'Altitude (m)'],
  ['speed', '速度', 'Speed'],
  ['heading', '進む向き (度)', 'Heading (deg)'],
  ['satellites', '衛星の数', 'Satellites'],
  ['throttle', 'アクセル (%)', 'Throttle (%)'],
  ['brake', 'ブレーキ (%)', 'Brake (%)'],
  ['steering', 'ステアリング角 (度)', 'Steering (deg)'],
  ['rpm', '回転数 (rpm)', 'RPM'],
  ['gear', 'ギア', 'Gear'],
  ['custom', '自分で名前を付ける', 'Custom value']
];
const TIMEZONES = ['Asia/Tokyo', 'UTC', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles'];

/** 見出しの名前から、列の行き先を当てる (今の CSV の読み方と同じ見分け方) */
function guessTarget(name: string): ColumnSpec {
  const h = name.toLowerCase();
  const base = h.replace(/\s*[([].*$/, '').trim();
  if (h.includes('緯度') || /\blat/.test(h)) return { target: 'lat' };
  if (h.includes('経度') || /\blon|lng/.test(h)) return { target: 'lon' };
  if (h.includes('標高') || /\balt/.test(h)) return { target: 'alt' };
  if (h.includes('速度') || /speed|spd|km\/h/.test(h)) return { target: 'speed', speedUnit: h.includes('m/s') ? 'm/s' : h.includes('mph') ? 'mph' : 'km/h' };
  if (h.includes('方位') || ['heading', 'heading_deg', 'bearing', 'course'].includes(base)) return { target: 'heading' };
  if (h.includes('衛星') || ['satellites', 'sats'].includes(base)) return { target: 'satellites' };
  if (/throttle|tps|アクセル/.test(h)) return { target: 'throttle' };
  if (/brake|ブレーキ/.test(h)) return { target: 'brake' };
  if (/steer|ステア/.test(h)) return { target: 'steering' };
  if (/rpm|回転/.test(h)) return { target: 'rpm' };
  if (/^gear|ギア/.test(h)) return { target: 'gear' };
  return { ignore: true };
}

/** 見出しの行を当てる (文字の列がいちばん多い、先頭のほうの行) */
function guessHeaderRow(lines: string[], d: CsvFormat['delimiter']): number {
  let best = 0, bestScore = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const cells = splitRow(lines[i], d);
    const words = cells.filter(c => c.trim() && !/^[-+]?\d+([.,]\d+)?$/.test(c.trim())).length;
    if (cells.length >= 2 && words > bestScore) { best = i; bestScore = words; }
    if (bestScore >= 3 && words < bestScore) break;
  }
  return best;
}

const keyFromName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'value';

/** CSV の形式を作る・直す (パソコン) */
const CsvFormatEditor: React.FC<{ initial: CsvFormat | null; others: CsvFormat[]; onClose: () => void }> = ({ initial, others, onClose }) => {
  const t = useT();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [f, setF] = useState<CsvFormat>(initial ?? { version: 1, id: '', name: '', kind: 'log', header: [], headerRow: 0, delimiter: ',', time: null, columns: {} });
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const lines = useMemo(() => (text ? text.split(/\r?\n/).slice(0, 400) : []), [text]);
  // 見出し (ファイルがあればその行、無ければ保存した見出しと列)
  const header = text ? splitRow(lines[f.headerRow] ?? '', f.delimiter).map(c => c.trim()) : [...new Set([...f.header, ...Object.keys(f.columns)])];
  const samples = text ? lines.slice(f.headerRow + 1).filter(l => l.trim()).slice(0, 4).map(l => splitRow(l, f.delimiter)) : [];

  const loadFile = async (file: File) => {
    const txt = await file.text();
    const d = guessDelimiter(txt);
    const ls = txt.split(/\r?\n/);
    const hr = guessHeaderRow(ls, d);
    const cols = splitRow(ls[hr] ?? '', d).map(c => c.trim()).filter(Boolean);
    const key = sensorKeyOf(file.name);
    const guessed = Object.fromEntries(cols.map(c => [c, f.columns[c] ?? guessTarget(c)]));
    const hasPos = Object.values(guessed).some(s => s.target === 'lat');
    const timeCol = cols.find(c => /^(time|秒|time_utc_ms|timestamp|utc|elapsed)/i.test(c)) ?? null;
    // 列の番号は、空の見出しも数えた元の並びで探す (cols は空の見出しを除いてあるので、ずれる)
    const firstVal = timeCol ? splitRow(ls[hr + 1] ?? '', d)[splitRow(ls[hr] ?? '', d).map(c => c.trim()).indexOf(timeCol)] ?? '' : '';
    const as: TimeAs = /utc_ms|_ms$/i.test(timeCol ?? '') ? (Number(firstVal) > 1e12 ? 'utcMs' : 'ms') : /^\s*-?\d+([.,]\d+)?\s*$/.test(firstVal) ? (Number(firstVal) > 1e12 ? 'utcMs' : 'seconds') : 'clock';
    setText(txt);
    setFileName(file.name);
    setF(prev => ({
      ...prev,
      name: prev.name || file.name.replace(/\.[^.]+$/, ''),
      kind: key && !hasPos ? 'sensor' : hasPos ? 'log' : prev.kind,
      ...(key && !hasPos ? { sensorKey: key } : {}),
      delimiter: d, headerRow: hr,
      time: timeCol ? { column: timeCol, as } : null,
      timezone: prev.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      columns: { ...guessed, ...(timeCol ? { [timeCol]: { ignore: true } } : {}) }
    }));
  };

  const setCol = (name: string, spec: ColumnSpec) => setF(prev => ({ ...prev, columns: { ...prev.columns, [name]: spec } }));
  const targetOf = (spec: ColumnSpec | undefined): string => (!spec || spec.ignore || !spec.target ? '' : spec.target.startsWith('custom:') ? 'custom' : spec.target);

  const save = async () => {
    const name = f.name.trim();
    if (!name) { setNote({ ok: false, text: t('名前を付けてください', 'Enter a name') }); return; }
    if (f.kind === 'sensor' && !/^[a-z0-9][a-z0-9_]{0,39}$/.test(f.sensorKey ?? '')) { setNote({ ok: false, text: t('ファイルの名前 (<走行>.<名前>.csv の名前) は、英小文字・数字・_ で付けてください', 'Use lowercase letters, digits and _ for the file name part') }); return; }
    const targets = Object.values(f.columns).map(s => s.target).filter(Boolean);
    if (f.kind === 'log' && !(targets.includes('lat') && targets.includes('lon'))) { setNote({ ok: false, text: t('走行の CSV には、緯度と経度の列が要ります', 'A run CSV needs latitude and longitude columns') }); return; }
    if (f.kind === 'sensor' && (!f.time || !targets.length)) { setNote({ ok: false, text: t('値だけの CSV には、時刻の列と、使う値の列が要ります', 'A value CSV needs a time column and at least one value column') }); return; }
    const keys = Object.values(f.columns).flatMap(s => (s.target?.startsWith('custom:') ? [s.target.slice(7)] : []));
    if (keys.some(k => !CUSTOM_KEY_RE.test(k)) || new Set(keys).size !== keys.length) { setNote({ ok: false, text: t('自分で名前を付けた値の英字の名前は、英小文字・数字・_ で、ほかと重ならないように', 'Custom value keys must be lowercase letters, digits and _, and unique') }); return; }
    // 同じ名前、または名前は違ってもファイルの名前が同じになるもの (「My Log」と「My_Log」など) は、上書きになる
    const stemId = `user:${safeName(name)}`.toLowerCase();
    const clash = others.find(o => o.id !== f.id && (o.name === name || o.id.toLowerCase() === stemId));
    // 値だけの CSV は、ファイルの名前 (<走行>.<名前>.csv) で形式を選ぶので、同じ名前のものが 2 つあると、どちらで読むか決まらない
    const sameKey = f.kind === 'sensor' ? others.find(o => o.id !== f.id && o.id !== clash?.id && o.kind === 'sensor' && o.sensorKey === f.sensorKey) : undefined;
    if (sameKey) { setNote({ ok: false, text: t(`ファイルの名前「${f.sensorKey}」は「${sameKey.name}」で使っています。別の名前にしてください`, `The file name part "${f.sensorKey}" is already used by "${sameKey.name}". Choose another one`) }); return; }
    if (clash && !window.confirm(t(`「${name}」に上書きしますか？`, `Overwrite "${name}"?`))) return;
    // 見出しは、使う列と時刻の列 (見分けるのに使う)
    const used = [...Object.entries(f.columns).filter(([, s]) => !s.ignore).map(([n]) => n), ...(f.time ? [f.time.column] : [])];
    try {
      const saved = await saveCsvFormat({ ...f, name, header: [...new Set(used)] }, clash?.id ?? (f.id || undefined));
      setF(saved);
      setNote({ ok: true, text: t(`「${name}」を保存しました`, `Saved "${name}"`) });
    } catch (e) {
      setNote({ ok: false, text: t(`保存できませんでした: ${e instanceof Error ? e.message : String(e)}`, `Could not save: ${e instanceof Error ? e.message : String(e)}`) });
    }
  };

  const input = 'bg-surface-0 border border-line-3 rounded px-2 py-1 text-xs text-slate-200';
  return (
    <div className="fixed inset-0 z-[90] bg-black/60 flex items-center justify-center p-4" data-testid="csv-format-editor">
      <div className="w-full max-w-5xl max-h-full flex flex-col bg-surface-1 border border-line-2 rounded-xl shadow-2xl text-xs text-slate-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2">
          <FileSpreadsheet size={16} className="text-sky-400" />
          <span className="font-bold text-slate-100 flex-1">{t('CSV の形式', 'CSV format')}</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-3 cursor-pointer" aria-label={t('閉じる', 'Close')} data-testid="csv-format-close"><X size={16} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 px-3 py-1.5 rounded bg-surface-3 border border-line-3 cursor-pointer"><Upload size={13} />{t('CSV を選ぶ', 'Choose a CSV')}</button>
            <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" className="hidden" data-testid="csv-format-file" onChange={e => { const x = e.target.files?.[0]; e.target.value = ''; if (x) void loadFile(x); }} />
            <span className="text-slate-500 truncate">{fileName || (initial ? t('(見本の CSV を選ぶと、中身を見ながら直せます)', '(choose a sample CSV to see its contents)') : t('見本の CSV を選んでください', 'Choose a sample CSV'))}</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <label className="space-y-0.5"><span className="text-[10px] text-slate-400">{t('名前', 'Name')}</span><input value={f.name} onChange={e => setF({ ...f, name: e.target.value.slice(0, 40) })} className={`${input} w-full`} data-testid="csv-format-name" /></label>
            <label className="space-y-0.5"><span className="text-[10px] text-slate-400">{t('種類', 'Kind')}</span>
              <select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value as CsvFormat['kind'] })} className={`${input} w-full`} data-testid="csv-format-kind">
                <option value="log">{t('走行の CSV (緯度・経度がある)', 'Run CSV (has latitude / longitude)')}</option>
                <option value="sensor">{t('値だけの CSV (走行の横に置く)', 'Value CSV (next to a run)')}</option>
              </select>
            </label>
            {f.kind === 'sensor' && (
              <label className="space-y-0.5"><span className="text-[10px] text-slate-400">{t('ファイルの名前 (<走行>.<ここ>.csv)', 'File name (<run>.<this>.csv)')}</span>
                <input value={f.sensorKey ?? ''} onChange={e => setF({ ...f, sensorKey: e.target.value.trim().toLowerCase().slice(0, 40) })} placeholder="obd_nd5rc" className={`${input} w-full font-mono`} data-testid="csv-format-sensor-key" />
              </label>
            )}
            <label className="space-y-0.5"><span className="text-[10px] text-slate-400">{t('区切り・見出しの行', 'Delimiter / header row')}</span>
              <div className="flex gap-1">
                <select value={f.delimiter} onChange={e => setF({ ...f, delimiter: e.target.value as CsvFormat['delimiter'] })} className={input}>
                  <option value=",">,</option><option value=";">;</option><option value={'\t'}>Tab</option>
                </select>
                <input type="number" min={1} max={100} value={f.headerRow + 1} onChange={e => setF({ ...f, headerRow: Math.max(0, Math.min(99, Number(e.target.value) - 1 || 0)) })} className={`${input} w-16`} title={t('見出しの行 (1 から)', 'Header row (from 1)')} />
              </div>
            </label>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <label className="space-y-0.5"><span className="text-[10px] text-slate-400">{t('時刻の列', 'Time column')}</span>
              <select value={f.time?.column ?? ''} onChange={e => setF({ ...f, time: e.target.value ? { column: e.target.value, as: f.time?.as ?? 'seconds' } : null })} className={`${input} w-full`} data-testid="csv-format-time">
                <option value="">{t('無し (行の順に 0.1 秒ずつ)', 'None (0.1 s per row)')}</option>
                {header.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            <label className="space-y-0.5"><span className="text-[10px] text-slate-400">{t('時刻の形', 'Time format')}</span>
              <select value={f.time?.as ?? 'seconds'} disabled={!f.time} onChange={e => f.time && setF({ ...f, time: { ...f.time, as: e.target.value as TimeAs } })} className={`${input} w-full`} data-testid="csv-format-time-as">
                <option value="seconds">{t('秒 (始まりから)', 'Seconds (from start)')}</option>
                <option value="ms">{t('ミリ秒 (始まりから)', 'Milliseconds (from start)')}</option>
                <option value="utcMs">{t('UTC のミリ秒 (1970 年から)', 'UTC milliseconds (epoch)')}</option>
                <option value="clock">{t('日時の文字 (2026-10-24 10:00:00 など)', 'Date and time text')}</option>
              </select>
            </label>
            <label className="space-y-0.5"><span className="text-[10px] text-slate-400">{t('タイムゾーン (日時の文字のとき)', 'Time zone (for date-time text)')}</span>
              <select value={f.timezone ?? ''} onChange={e => setF({ ...f, timezone: validTimezone(e.target.value) ? e.target.value : undefined })} className={`${input} w-full`} data-testid="csv-format-timezone">
                <option value="">{t('端末の時刻', 'Device time zone')}</option>
                {[...new Set([...(f.timezone ? [f.timezone] : []), ...TIMEZONES])].map(z => <option key={z} value={z}>{z}</option>)}
              </select>
            </label>
            {f.kind === 'sensor' && f.time && (f.time.as === 'seconds' || f.time.as === 'ms') && (
              <label className="space-y-0.5"><span className="text-[10px] text-slate-400">{t('走行の始まりとのずれ (秒)', 'Offset from run start (s)')}</span>
                <input type="number" step="0.1" value={f.offsetSec ?? 0} onChange={e => setF({ ...f, offsetSec: Number(e.target.value) || 0 })} className={`${input} w-full`} />
              </label>
            )}
          </div>
          {/* 列の一覧 */}
          {header.length > 0 && (
            <div className="overflow-x-auto border border-line-2 rounded">
              <table className="w-full text-[11px]" data-testid="csv-format-columns">
                <thead className="bg-surface-2 text-slate-400">
                  <tr><th className="text-left px-2 py-1">{t('列', 'Column')}</th><th className="text-left px-2 py-1">{t('中身の例', 'Sample')}</th><th className="text-left px-2 py-1">{t('何の値か', 'Meaning')}</th><th className="text-left px-2 py-1">{t('単位・表示', 'Unit / display')}</th></tr>
                </thead>
                <tbody>
                  {header.map((h, i) => {
                    const spec = f.columns[h];
                    const tgt = targetOf(spec);
                    const isTime = f.time?.column === h;
                    return (
                      <tr key={`${h}-${i}`} className="border-t border-line-2" data-testid="csv-format-column">
                        <td className="px-2 py-1 font-mono text-slate-200 whitespace-nowrap">{h}</td>
                        <td className="px-2 py-1 font-mono text-slate-500 whitespace-nowrap">{samples.map(r => r[i] ?? '').join(' / ').slice(0, 40)}</td>
                        <td className="px-2 py-1">
                          {isTime ? <span className="text-slate-500">{t('(時刻)', '(time)')}</span> : (
                            <select value={tgt} onChange={e => {
                              const v = e.target.value;
                              if (!v) setCol(h, { ignore: true });
                              else if (v === 'custom') setCol(h, { target: `custom:${keyFromName(h)}`, label: h });
                              else setCol(h, { target: v as ColumnTarget, ...(v === 'speed' ? { speedUnit: 'km/h' } : {}) });
                            }} className={input} data-testid={`csv-format-target-${i}`}>
                              {TARGETS.map(([v, ja, en]) => <option key={v} value={v}>{t(ja, en)}</option>)}
                            </select>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          {tgt === 'speed' && spec && (
                            <select value={spec.speedUnit ?? 'km/h'} onChange={e => setCol(h, { ...spec, speedUnit: e.target.value as ColumnSpec['speedUnit'] })} className={input}>
                              <option value="km/h">km/h</option><option value="m/s">m/s</option><option value="mph">mph</option><option value="kn">kn</option>
                            </select>
                          )}
                          {tgt === 'custom' && spec?.target && (
                            <div className="flex flex-wrap gap-1 items-center">
                              <input value={spec.label ?? ''} onChange={e => setCol(h, { ...spec, label: e.target.value.slice(0, 30) })} placeholder={t('表示名', 'Label')} className={`${input} w-24`} data-testid={`csv-format-label-${i}`} />
                              <input value={spec.target.slice(7)} onChange={e => setCol(h, { ...spec, target: `custom:${e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40)}` })} title={t('英字の名前 (計算式で使う)', 'Key (used in formulas)')} className={`${input} w-24 font-mono`} />
                              <input value={spec.unit ?? ''} onChange={e => setCol(h, { ...spec, unit: e.target.value.slice(0, 12) })} placeholder={t('単位', 'Unit')} className={`${input} w-14`} />
                              <input type="number" value={spec.min ?? ''} onChange={e => setCol(h, { ...spec, min: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder={t('最小', 'Min')} className={`${input} w-16`} />
                              <input type="number" value={spec.max ?? ''} onChange={e => setCol(h, { ...spec, max: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder={t('最大', 'Max')} className={`${input} w-16`} />
                            </div>
                          )}
                          {tgt && tgt !== 'speed' && spec && (
                            <span className="inline-flex items-center gap-1 ml-1 text-slate-500">×<input type="number" step="any" value={spec.scale ?? 1} onChange={e => setCol(h, { ...spec, scale: Number(e.target.value) || 1 })} className={`${input} w-14`} title={t('倍率 (単位を換える)', 'Scale')} /></span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-line-2">
          {note && <span className={`flex-1 ${note.ok ? 'text-emerald-400' : 'text-red-400'}`} data-testid="csv-format-note">{note.text}</span>}
          {!note && <span className="flex-1" />}
          {f.id && (
            <button onClick={() => { if (window.confirm(t(`「${f.name}」を消しますか？`, `Delete "${f.name}"?`))) void deleteCsvFormat(f.id).then(onClose); }} className="flex items-center gap-1 px-3 py-1.5 rounded border border-line-3 text-slate-400 hover:text-red-400 cursor-pointer" data-testid="csv-format-delete"><Trash2 size={13} />{t('消す', 'Delete')}</button>
          )}
          <button onClick={() => void save()} className="flex items-center gap-1 px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer" data-testid="csv-format-save"><Save size={13} />{t('保存', 'Save')}</button>
        </div>
      </div>
    </div>
  );
};

/** 計算式を作る・直す (パソコン) */
const CalcEditor: React.FC<{ initial: CalcChannel[]; onClose: () => void }> = ({ initial, onClose }) => {
  const t = useT();
  const [list, setList] = useState<CalcChannel[]>(initial.map(c => ({ ...c })));
  // 開いたあとで計算式を読み終えたら (起動直後・iCloud から来たとき)、まだ直していなければ読み直したものにする
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) setList(initial.map(c => ({ ...c }))); }, [initial]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const errOf = (c: CalcChannel): string | null => {
    if (!CUSTOM_KEY_RE.test(c.key)) return t('英字の名前は英小文字・数字・_', 'Key: lowercase letters, digits, _');
    if (BUILTIN_VALUE_NAMES.has(c.key)) return t(`「${c.key}」はもともとある値の名前なので、別の名前にしてください`, `"${c.key}" is a built-in value name; choose another key`);
    let vars: string[];
    try { vars = exprVars(parseExpr(c.expr)); } catch (e) { return e instanceof Error ? e.message : String(e); }
    // 計算式の値は点に書かないので、ほかの計算式の値 (自分も) は式から読めない (前は保存できて、値が出ないだけだった)
    const calcRef = vars.find(v => list.some(o => o.key === v));
    if (calcRef) return t(`計算式の値「${calcRef}」は、式の中では使えません`, `A formula cannot use another formula's value ("${calcRef}")`);
    return null;
  };
  const set = (i: number, patch: Partial<CalcChannel>) => { dirty.current = true; setList(l => l.map((c, k) => (k === i ? { ...c, ...patch } : c))); };
  const save = async () => {
    const bad = list.find(errOf);
    if (bad) { setNote({ ok: false, text: `${bad.label || bad.key}: ${errOf(bad)}` }); return; }
    if (new Set(list.map(c => c.key)).size !== list.length) { setNote({ ok: false, text: t('英字の名前が重なっています', 'Duplicate keys') }); return; }
    try {
      await saveCalcChannels(list);
      setNote({ ok: true, text: t('保存しました', 'Saved') });
    } catch (e) {
      setNote({ ok: false, text: t(`保存できませんでした: ${e instanceof Error ? e.message : String(e)}`, `Could not save: ${e instanceof Error ? e.message : String(e)}`) });
    }
  };
  const input = 'bg-surface-0 border border-line-3 rounded px-2 py-1 text-xs text-slate-200';
  return (
    <div className="fixed inset-0 z-[90] bg-black/60 flex items-center justify-center p-4" data-testid="calc-editor">
      <div className="w-full max-w-3xl max-h-full flex flex-col bg-surface-1 border border-line-2 rounded-xl shadow-2xl text-xs text-slate-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2">
          <Calculator size={16} className="text-sky-400" />
          <span className="font-bold text-slate-100 flex-1">{t('計算式', 'Formulas')}</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-3 cursor-pointer" aria-label={t('閉じる', 'Close')} data-testid="calc-close"><X size={16} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
          <p className="text-[11px] text-slate-500">
            {t('値から新しい値を作ります。使える値: speed・accelG・corneringG・combinedG・throttle・brake・steering・rpm・gear・altitude と、自分で名前を付けた値の英字の名前。+ - * / ( )、> < >= <= == != (合えば 1)、min max abs sqrt round。例: speed * 0.621、rpm / gear、(brake > 10) * 100',
              'Make new values from others. Values: speed, accelG, corneringG, combinedG, throttle, brake, steering, rpm, gear, altitude and your custom keys. + - * / ( ), comparisons (1 when true), min max abs sqrt round. e.g. speed * 0.621')}
          </p>
          {list.map((c, i) => {
            const err = errOf(c);
            return (
              <div key={i} className="flex flex-wrap items-center gap-1" data-testid="calc-row">
                <input value={c.label} onChange={e => set(i, { label: e.target.value.slice(0, 30) })} placeholder={t('表示名', 'Label')} className={`${input} w-28`} data-testid="calc-label" />
                <input value={c.key} onChange={e => set(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40) })} placeholder="key" className={`${input} w-24 font-mono`} data-testid="calc-key" />
                <span>=</span>
                <input value={c.expr} onChange={e => set(i, { expr: e.target.value.slice(0, 200) })} placeholder="speed * 0.621" className={`${input} flex-1 min-w-[12rem] font-mono ${err ? 'border-red-500' : ''}`} data-testid="calc-expr" />
                <input value={c.unit ?? ''} onChange={e => set(i, { unit: e.target.value.slice(0, 12) })} placeholder={t('単位', 'Unit')} className={`${input} w-14`} />
                <input type="number" value={c.min ?? ''} onChange={e => set(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder={t('最小', 'Min')} className={`${input} w-16`} />
                <input type="number" value={c.max ?? ''} onChange={e => set(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder={t('最大', 'Max')} className={`${input} w-16`} />
                <button onClick={() => { dirty.current = true; setList(l => l.filter((_, k) => k !== i)); }} className="p-1 text-slate-500 hover:text-red-400 cursor-pointer" aria-label={t('消す', 'Delete')}><Trash2 size={13} /></button>
                {err && c.expr && <span className="basis-full text-[10px] text-red-400">{err}</span>}
              </div>
            );
          })}
          <button onClick={() => { dirty.current = true; setList(l => [...l, { key: `calc${l.length + 1}`, label: "", expr: "" }]); }} className="flex items-center gap-1 px-2 py-1 rounded border border-line-3 cursor-pointer" data-testid="calc-add"><Plus size={12} />{t('足す', 'Add')}</button>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-line-2">
          <span className={`flex-1 ${note?.ok ? 'text-emerald-400' : 'text-red-400'}`} data-testid="calc-note">{note?.text}</span>
          <button onClick={() => void save()} className="flex items-center gap-1 px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer" data-testid="calc-save"><Save size={13} />{t('保存', 'Save')}</button>
        </div>
      </div>
    </div>
  );
};
