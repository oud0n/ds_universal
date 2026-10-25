/**
 * 解析用のセッション (複数の走行を Car に割り当てた組み合わせ) の保存と一覧 (PLAN-18。2026-10-25。設計は docs/session_storage_design.md)。
 *
 * 保管場所の sessions/<作った時刻>_<名前>.lapsession.json。ファイルは写さず、走行 (フォルダ/ファイル・runs.json の行の id) と
 * 分かれた走行の何番目か・何周目かを指すだけ。開くときは、指している走行を開いて Car に割り当てる (動画・同期は走行の runs.json から)。
 * 置き場には消す窓口が無いので、消すときは deleted の印を書き、一覧に出さない
 */
import type { RunStore } from './runStore';

export const SESSIONS_DIR = 'sessions';

export interface LapSessionCar {
  /** Car の番号 (0 = Car 1) */
  slot: number;
  /** 走行のファイル (保管場所の道。例 sodegaura/20261025/20261025100000.nmea) */
  run: string;
  /** runs.json の行の変わらない印 (あれば) */
  id?: string;
  /** 分かれた走行の何番目か (1 から。分かれていなければ無い) */
  part?: number;
  /** 何周目か */
  lap: number;
}

export interface LapSession {
  version: 1;
  name: string;
  createdAt: string;
  course?: { name: string };
  cars: LapSessionCar[];
  /** 消した (一覧に出さない) */
  deleted?: boolean;
  [key: string]: unknown;
}

export interface SavedSession {
  path: string;
  data: LapSession;
}

/** ファイルの名前に使えるようにする (英数字・かな漢字は残し、区切りになる文字だけ替える) */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(0, 40) || 'session';
}

/** 中身を確かめる (おかしなものは null) */
export function parseLapSession(text: string | null): LapSession | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<LapSession>;
    if (!v || v.version !== 1 || typeof v.name !== 'string' || !Array.isArray(v.cars)) return null;
    const cars = v.cars.filter((c): c is LapSessionCar =>
      !!c && typeof c.slot === 'number' && typeof c.run === 'string' && typeof c.lap === 'number' && !c.run.includes('..'));
    if (!cars.length) return null;
    return { ...v, createdAt: typeof v.createdAt === 'string' ? v.createdAt : '', cars } as LapSession;
  } catch {
    return null;
  }
}

/** 保存したセッション (新しい順。消したものは出さない) */
export async function listSessions(store: RunStore): Promise<SavedSession[]> {
  const files = (await store.listAll()).filter(f => f.path.startsWith(`${SESSIONS_DIR}/`) && f.path.endsWith('.lapsession.json'));
  const out: SavedSession[] = [];
  for (const f of files) {
    const data = parseLapSession(await store.readText(f.path).catch(() => null));
    if (data && !data.deleted) out.push({ path: f.path, data });
  }
  return out.sort((a, b) => b.data.createdAt.localeCompare(a.data.createdAt));
}

/** 保存する (新しいファイル)。書いた道を返す */
export async function saveSession(store: RunStore, session: { name: string; course?: { name: string }; cars: LapSessionCar[] }): Promise<string> {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const path = `${SESSIONS_DIR}/${stamp}_${safeName(session.name)}.lapsession.json`;
  const data: LapSession = { version: 1, createdAt: now.toISOString(), ...session };
  await store.writeText(path, JSON.stringify(data, null, 1));
  return path;
}

/** 消す (消した印を書く) */
export async function deleteSession(store: RunStore, path: string): Promise<void> {
  const data = parseLapSession(await store.readText(path));
  if (!data) return;
  await store.writeText(path, JSON.stringify({ ...data, deleted: true }, null, 1));
}
