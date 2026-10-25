/**
 * 自分のメーターの並びの置き場 (PLAN-08)。
 * - アプリ・デスクトップ版: 保管場所の overlays/<名前>.overlay.json (iPhone とデスクトップ版で同じ並びを使える)
 * - ブラウザ版 (保管場所なし): ブラウザに保存し、ファイルで書き出す・読み込む
 * 置き場には消す窓口が無いので、消すときは deleted の印を書き、一覧に出さない (保存した比べ方と同じ)
 */
import type { RunStore } from './runStore';
import { parseOverlayLayout, type OverlayLayout } from './overlayLayout';

export const OVERLAYS_DIR = 'overlays';
const LOCAL_KEY = 'ds_overlay_layouts';

/** ファイルの名前に使える形 (英数字・かな漢字は残し、区切りになる文字だけ替える) */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(0, 40) || 'layout';
}

/** 並びの印 (選びの値)。自分の並びは user:<ファイルの名前> */
export const userLayoutId = (fileStem: string) => `user:${fileStem}`;
const stemOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.overlay\.json$/, '');

function readLocal(): OverlayLayout[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.map((x, i) => parseOverlayLayout(JSON.stringify(x), `user:local${i}`)).filter((l): l is OverlayLayout => !!l) : [];
  } catch {
    return [];
  }
}

function writeLocal(list: OverlayLayout[]): void {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch { /* 覚えられなくても、今の画面では使える */ }
}

/** 自分の並び (名前の順) */
export async function listCustomLayouts(store: RunStore | null): Promise<OverlayLayout[]> {
  if (!store) return readLocal();
  const files = (await store.listAll().catch(() => [])).filter(f => f.path.startsWith(`${OVERLAYS_DIR}/`) && f.path.endsWith('.overlay.json'));
  const out: OverlayLayout[] = [];
  for (const f of files) {
    const text = await store.readText(f.path).catch(() => null);
    if (!text || isDeleted(text)) continue;
    const l = parseOverlayLayout(text, userLayoutId(stemOf(f.path)));
    if (l) out.push({ ...l, id: userLayoutId(stemOf(f.path)) });
  }
  return out.sort((a, b) => a.name[0].localeCompare(b.name[0]));
}

function isDeleted(text: string): boolean {
  try { return (JSON.parse(text) as { deleted?: unknown }).deleted === true; } catch { return false; }
}

/**
 * 並びを保存する。名前から印を決める (同じ名前は上書き)。保存した並び (印つき) を返す
 */
export async function saveCustomLayout(store: RunStore | null, layout: OverlayLayout, name: string): Promise<OverlayLayout> {
  const stem = safeName(name.trim());
  const saved: OverlayLayout = { version: 1, id: userLayoutId(stem), name: [name.trim(), name.trim()], parts: layout.parts };
  if (!store) {
    const list = readLocal().filter(l => l.id !== saved.id);
    writeLocal([...list, saved]);
    return saved;
  }
  const { builtin: _b, ...body } = saved;
  await store.writeText(`${OVERLAYS_DIR}/${stem}.overlay.json`, JSON.stringify(body, null, 1));
  return saved;
}

/** 並びを消す (保管場所では消した印を書く) */
export async function deleteCustomLayout(store: RunStore | null, id: string): Promise<void> {
  if (!id.startsWith('user:')) return;
  if (!store) { writeLocal(readLocal().filter(l => l.id !== id)); return; }
  await store.writeText(`${OVERLAYS_DIR}/${id.slice(5)}.overlay.json`, JSON.stringify({ version: 1, deleted: true }));
}

/** 並びをファイルにする (ブラウザ版の書き出し) */
export function layoutFileText(layout: OverlayLayout): string {
  const { builtin: _b, ...body } = layout;
  return JSON.stringify(body, null, 1);
}
