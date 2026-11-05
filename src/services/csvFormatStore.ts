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
import { getStorageRevision, getStorageReadRevision, isStorageSelectionPending, subscribeStorageRevision, StorageChangedError } from './storageRevision';
import { tr } from '../utils/i18n';
import { setCustomChannels } from './overlayLayout';

export const FORMATS_DIR = 'formats';
export const CALC_FILE = `${FORMATS_DIR}/calc.json`;
const LOCAL_FORMATS = 'ds_csv_formats';
const LOCAL_CALC = 'ds_calc_channels';

/** ファイルの名前に使える形 (形式の印にもなる。名前が違っても同じ形になることがあるので、保存する前に重なりを確かめる) */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(0, 40) || 'format';
}
const stemOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.csvformat\.json$/, '');
const isDeleted = (text: string) => { try { return (JSON.parse(text) as { deleted?: unknown }).deleted === true; } catch { return false; } };

// 定義と計算式は同じ保存先から準備し、一括で公開する。
let formats: CsvFormat[] = [];
let calc: CalcChannel[] = [];
let dataRoot: number | null = null;
let calcReadable = false;
let formatsReadable = false;
let sequence = 0;
let attempt: { reads: number; promise: Promise<void> } | null = null;
let retryNeeded = false;
let retryQueued = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let observedRoot = getStorageRevision();
let snapshot = { formats, calc, storageRevision: observedRoot, ready: false };
const listeners = new Set<() => void>();
function publish(): void {
  snapshot = { formats, calc, storageRevision: getStorageRevision(), ready: dataRoot === getStorageRevision() && formatsReadable && calcReadable };
  const specs = [
    ...customSpecsOf(formatsReadable ? formats : []),
    ...(calcReadable ? calc : []).flatMap(c => { try { return [{ key: c.key, label: c.label, unit: c.unit, min: c.min, max: c.max, get: compileExpr(c.expr) }]; } catch { return []; } })
  ];
  setCustomChannels(specs);
  for (const f of listeners) f();
}

export const currentCsvFormats = (): CsvFormat[] => dataRoot === getStorageRevision() && formatsReadable ? formats : [];
export const csvFormatsReady = (): boolean => snapshot.storageRevision === getStorageRevision() && snapshot.ready;
export function useCsvFormats(): typeof snapshot {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => snapshot);
}
const store = (): Promise<RunStore | null> => (canUseRunStore() ? getRunStore() : Promise.resolve(null));
const checkRoot = (root: number) => {
  if (root !== getStorageRevision() || isStorageSelectionPending()) throw new StorageChangedError();
};
function retryWhenReady(): void {
  if (!retryNeeded || retryQueued || isStorageSelectionPending()) return;
  retryQueued = true;
  queueMicrotask(() => {
    retryQueued = false;
    if (retryNeeded && !isStorageSelectionPending()) void loadCsvFormats().catch(() => undefined);
  });
}
subscribeStorageRevision(() => {
  if (observedRoot !== getStorageRevision()) {
    observedRoot = getStorageRevision();
    sequence++;
    attempt = null;
    dataRoot = null; formats = []; calc = []; calcReadable = false; formatsReadable = false;
    retryNeeded = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    publish();
  }
  retryWhenReady();
});
function readLocal<T>(key: string, parse: (x: unknown, i: number) => T | null): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.map(parse).filter((x): x is T => !!x) : [];
  } catch { return []; }
}
function writeLocal(key: string, list: unknown[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* 今の画面では使える */ }
}

/** 中断後も選択終了時にやり直す。同じ期間の要求は共有する。 */
export function loadCsvFormats(retries = 0): Promise<void> {
  const reads = getStorageReadRevision();
  if (retries === 0 && attempt?.reads === reads) return attempt.promise;
  const root = getStorageRevision(), ticket = ++sequence;
  retryNeeded = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const check = () => { checkRoot(root); if (reads !== getStorageReadRevision() || ticket !== sequence) throw new StorageChangedError(); };
  const later = () => {
    if (retries >= 4) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (root !== getStorageRevision() || ticket !== sequence) return;
      if (isStorageSelectionPending()) { retryNeeded = true; return; }
      void loadCsvFormats(retries + 1).catch(() => undefined);
    }, 4000);
  };
  const promise = loadFormats(root, check, later);
  attempt = { reads, promise };
  void promise.catch(error => {
    if (ticket !== sequence) return;
    attempt = null;
    if (error instanceof StorageChangedError) {
      calcReadable = false; formatsReadable = false;
      retryNeeded = true; publish(); retryWhenReady();
    }
  });
  return promise;
}
async function loadFormats(root: number, check: () => void, later: () => void): Promise<void> {
  const s = await store(); check();
  if (!s) {
    formats = readLocal(LOCAL_FORMATS, (x, i) => parseCsvFormat(JSON.stringify(x), `user:local${i}`));
    calc = parseCalcFile(JSON.stringify({ version: 1, channels: readLocal(LOCAL_CALC, x => x as CalcChannel) }));
    dataRoot = root; calcReadable = true; formatsReadable = true; publish(); return;
  }
  let listed;
  try { listed = await s.listAll(); } catch (error) {
    if (error instanceof StorageChangedError) throw error;
    check(); calcReadable = false; formatsReadable = false; publish(); later(); return;
  }
  check();
  const files = listed.filter(f => f.path.startsWith(`${FORMATS_DIR}/`));
  const out: CsvFormat[] = [];
  let pending = false, readable = true;
  for (const f of files.filter(x => x.path.endsWith('.csvformat.json') || x.path === CALC_FILE)) {
    if (f.local === false) { pending = true; void s.startDownload(f.path).catch(() => undefined); }
  }
  for (const f of files.filter(x => x.path.endsWith('.csvformat.json'))) {
    let text;
    try { text = await s.readTextStrict(f.path); } catch (error) {
      if (error instanceof StorageChangedError) throw error;
      readable = false; continue;
    }
    check();
    if (!text || isDeleted(text)) continue;
    const id = `user:${stemOf(f.path)}`;
    const fmt = parseCsvFormat(text, id);
    if (fmt) out.push({ ...fmt, id });
  }
  let nextCalc: CalcChannel[] = [], calcOk = true;
  if (files.some(f => f.path === CALC_FILE)) {
    try { nextCalc = parseCalcFile(await s.readTextStrict(CALC_FILE)); } catch (error) {
      if (error instanceof StorageChangedError) throw error;
      calcOk = false;
      nextCalc = dataRoot === root ? calc : [];
    }
  }
  check();
  if (readable) formats = out.sort((a, b) => a.name.localeCompare(b.name));
  else if (dataRoot !== root) formats = [];
  calc = nextCalc; dataRoot = root; calcReadable = calcOk; formatsReadable = readable;
  publish();
  if (pending || !readable || !calcOk) later();
}
function requireLoaded(root: number): void {
  checkRoot(root);
  if (dataRoot !== root || !formatsReadable || !calcReadable) throw new Error(tr('定義と計算式を読み直してから、内容を確認して保存してください。', 'Reload the formats and formulas, review them, then save.'));
}
function saved(): void {
  // 保存前に始まった再読込みで編集結果を戻さない。
  sequence++; attempt = null; retryNeeded = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  publish();
}

export async function saveCsvFormat(f: CsvFormat, overwriteId?: string, root = getStorageRevision()): Promise<CsvFormat> {
  requireLoaded(root);
  const reads = getStorageReadRevision();
  const check = () => { checkRoot(root); if (reads !== getStorageReadRevision()) throw new StorageChangedError(); };
  const stem = overwriteId?.startsWith('user:') ? overwriteId.slice(5) : safeName(f.name);
  const value: CsvFormat = { ...f, id: `user:${stem}` };
  const s = await store(); check();
  if (!s) writeLocal(LOCAL_FORMATS, [...formats.filter(x => x.id !== value.id), value]);
  else await s.writeText(`${FORMATS_DIR}/${stem}.csvformat.json`, JSON.stringify(value, null, 1));
  check(); formats = [...formats.filter(x => x.id !== value.id), value].sort((a, b) => a.name.localeCompare(b.name)); saved();
  return value;
}
export async function deleteCsvFormat(id: string, root = getStorageRevision()): Promise<void> {
  if (!id.startsWith('user:')) return;
  requireLoaded(root);
  const reads = getStorageReadRevision();
  const check = () => { checkRoot(root); if (reads !== getStorageReadRevision()) throw new StorageChangedError(); };
  const s = await store(); check();
  const next = formats.filter(x => x.id !== id);
  if (!s) writeLocal(LOCAL_FORMATS, next);
  else await s.writeText(`${FORMATS_DIR}/${id.slice(5)}.csvformat.json`, JSON.stringify({ version: 1, deleted: true }));
  check(); formats = next; saved();
}
export async function saveCalcChannels(list: CalcChannel[], root = getStorageRevision()): Promise<void> {
  requireLoaded(root);
  const reads = getStorageReadRevision();
  const check = () => { checkRoot(root); if (reads !== getStorageReadRevision()) throw new StorageChangedError(); };
  const s = await store(); check();
  if (!s) writeLocal(LOCAL_CALC, list);
  else await s.writeText(CALC_FILE, JSON.stringify({ version: 1, channels: list }, null, 1));
  check(); calc = list; saved();
}
