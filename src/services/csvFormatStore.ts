/**
 * CSV の形式の定義・計算式の置き場 (PLAN-36)。
 * - アプリ・デスクトップ版: 保管場所の formats/<名前>.csvformat.json と formats/calc.json (iPhone とデスクトップ版で同じものを使う)
 * - ブラウザ版 (保管場所なし): ブラウザに保存する
 * 置き場には消す窓口が無いので、消すときは deleted の印を書き、一覧に出さない (メーターの並びと同じ)。
 * 読んだ形式は手元に持ち、ファイルを読むとき (logLoader)・走行を開くときに使う
 */
import { useSyncExternalStore } from 'react';
import type { RunStore } from './runStore';
import { canUseRunStore, getRunStore } from './runStore';
import { customSpecsOf, parseCsvFormat, type CsvFormat } from './csvFormats';
import { compileExpr, parseCalcFile, type CalcChannel } from './calcChannels';
import { setCustomChannels } from './overlayLayout';

export const FORMATS_DIR = 'formats';
export const CALC_FILE = `${FORMATS_DIR}/calc.json`;
const LOCAL_FORMATS = 'ds_csv_formats';
const LOCAL_CALC = 'ds_calc_channels';

/** ファイルの名前に使える形 */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(0, 40) || 'format';
}
const stemOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.csvformat\.json$/, '');
const isDeleted = (text: string) => { try { return (JSON.parse(text) as { deleted?: unknown }).deleted === true; } catch { return false; } };

// 手元に持っている形式・計算式 (読み直したら知らせる)
let formats: CsvFormat[] = [];
let calc: CalcChannel[] = [];
let snapshot = { formats, calc };
const listeners = new Set<() => void>();
function publish(): void {
  snapshot = { formats, calc };
  // 自分で名前を付けた値の表示 (形式の列・計算式)。計算式は点からその場で求める
  const specs = [
    ...customSpecsOf(formats),
    ...calc.flatMap(c => { try { return [{ key: c.key, label: c.label, unit: c.unit, min: c.min, max: c.max, get: compileExpr(c.expr) }]; } catch { return []; } })
  ];
  setCustomChannels(specs);
  for (const f of listeners) f();
}

/** 今の形式 (ファイルを読むときに使う) */
export const currentCsvFormats = (): CsvFormat[] => formats;
export function useCsvFormats(): { formats: CsvFormat[]; calc: CalcChannel[] } {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => snapshot);
}

const store = (): Promise<RunStore | null> => (canUseRunStore() ? getRunStore().catch(() => null) : Promise.resolve(null));

function readLocal<T>(key: string, parse: (x: unknown, i: number) => T | null): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.map(parse).filter((x): x is T => !!x) : [];
  } catch { return []; }
}
function writeLocal(key: string, list: unknown[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* 覚えられなくても、今の画面では使える */ }
}

/** 置き場から形式・計算式を読み直す (起動したとき・保管場所を替えたとき) */
export async function loadCsvFormats(retries = 0): Promise<void> {
  const s = await store();
  if (!s) {
    formats = readLocal(LOCAL_FORMATS, (x, i) => parseCsvFormat(JSON.stringify(x), `user:local${i}`));
    calc = parseCalcFile(JSON.stringify({ version: 1, channels: readLocal(LOCAL_CALC, x => x as CalcChannel) }));
    publish();
    return;
  }
  const files = (await s.listAll().catch(() => [])).filter(f => f.path.startsWith(`${FORMATS_DIR}/`));
  const out: CsvFormat[] = [];
  // iCloud にだけあって、まだ端末に取り込まれていないファイル (保管場所を選んだ直後など)。取り込みを頼んで、あとで読み直す
  let pending = false;
  for (const f of files.filter(x => x.path.endsWith('.csvformat.json') || x.path === CALC_FILE)) {
    if (f.local === false) { pending = true; void s.startDownload(f.path).catch(() => undefined); }
  }
  if (pending && retries < 4) setTimeout(() => { void loadCsvFormats(retries + 1); }, 4000);
  for (const f of files.filter(x => x.path.endsWith('.csvformat.json'))) {
    const text = await s.readText(f.path).catch(() => null);
    if (!text || isDeleted(text)) continue;
    const id = `user:${stemOf(f.path)}`;
    const fmt = parseCsvFormat(text, id);
    if (fmt) out.push({ ...fmt, id });
  }
  formats = out.sort((a, b) => a.name.localeCompare(b.name));
  calc = files.some(f => f.path === CALC_FILE) ? parseCalcFile(await s.readText(CALC_FILE).catch(() => null)) : [];
  publish();
}

/** 形式を保存する (名前から印を決める。同じ印は上書き)。保存した形式を返す */
export async function saveCsvFormat(f: CsvFormat, overwriteId?: string): Promise<CsvFormat> {
  const stem = overwriteId?.startsWith('user:') ? overwriteId.slice(5) : safeName(f.name);
  const saved: CsvFormat = { ...f, id: `user:${stem}` };
  const s = await store();
  if (!s) writeLocal(LOCAL_FORMATS, [...formats.filter(x => x.id !== saved.id), saved]);
  else await s.writeText(`${FORMATS_DIR}/${stem}.csvformat.json`, JSON.stringify(saved, null, 1));
  formats = [...formats.filter(x => x.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
  publish();
  return saved;
}

/** 形式を消す (置き場では消した印を書く) */
export async function deleteCsvFormat(id: string): Promise<void> {
  if (!id.startsWith('user:')) return;
  const s = await store();
  formats = formats.filter(x => x.id !== id);
  if (!s) writeLocal(LOCAL_FORMATS, formats);
  else await s.writeText(`${FORMATS_DIR}/${id.slice(5)}.csvformat.json`, JSON.stringify({ version: 1, deleted: true }));
  publish();
}

/** 計算式を全部書き換える */
export async function saveCalcChannels(list: CalcChannel[]): Promise<void> {
  const s = await store();
  if (!s) writeLocal(LOCAL_CALC, list);
  else await s.writeText(CALC_FILE, JSON.stringify({ version: 1, channels: list }, null, 1));
  calc = list;
  publish();
}
