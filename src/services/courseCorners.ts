/**
 * コースのコーナーの名前を、保管場所のコースのフォルダ (corners.json) から読み書きする (PLAN-27)。
 * 保管場所がない (ブラウザ版・選んでいない) ときは何もしない (今までどおり見つけた順に C1…)。
 */

import { useEffect, useState } from 'react';
import { CIRCUIT_PRESETS } from './circuitDatabase';
import { userCircuitStorage } from './userCircuitStorage';
import { courseFolder } from '../utils/courseNames';
import { canUseRunStore, getRunStore } from './runStore';
import { CORNERS_FILE, cornersFromDetection, newCornerFile, parseCornerFile, serializeCornerFile, type CornerFile } from './cornerNames';
import type { Corner, LapGeometry } from './drivingAnalysis';

const USER_SUFFIX = ' (ユーザー設置)';

/** 解析のコースの名前から、保管場所のフォルダの名前 (分からなければ null) */
export function folderForCircuitName(circuitName: string | undefined): string | null {
  if (!circuitName) return null;
  const name = circuitName.endsWith(USER_SUFFIX) ? circuitName.slice(0, -USER_SUFFIX.length) : circuitName;
  const own = userCircuitStorage.getAllCircuits().find(c => c.name === name);
  const preset = CIRCUIT_PRESETS.find(p => p.name === name);
  // 内蔵のコースを直した自分のコース (同じ名前で、保存フォルダ名を決めていないもの) は、内蔵のコースのフォルダ (ID) を使う。
  // 走行は内蔵のコースの ID のフォルダに入るので、コーナーの名前だけ名前から作ったフォルダ (sodegaura_forest_raceway など) に分かれていた (BUG-34)
  if (own) return courseFolder(own.name, own.folder, own.folder ? undefined : preset?.id);
  return preset ? courseFolder(preset.name, preset.folder, preset.id) : null;
}

/** 読んだもの (フォルダごと。null はファイルがない) */
const cache = new Map<string, Promise<CornerFile | null>>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(f => f());
/** この起動の中で自動で作ろうとしたフォルダ (書けなくても何度も試さない) */
const autoTried = new Set<string>();

const path = (folder: string) => `${folder}/${CORNERS_FILE}`;

export function loadCourseCorners(folder: string): Promise<CornerFile | null> {
  let p = cache.get(folder);
  if (!p) {
    p = (async () => {
      if (!canUseRunStore()) return null;
      const store = await getRunStore();
      if (!store) return null;
      return parseCornerFile(await store.readText(path(folder)).catch(() => null));
    })();
    cache.set(folder, p);
    // 無かった (読めなかった) ときは覚えない。あとで置かれた・iCloud から落ちてきたファイルを、次に開いたときに読む
    void p.then(file => { if (file === null && cache.get(folder) === p) cache.delete(folder); });
  }
  return p;
}

/** 書く。前の中身があれば corners.json.bak に 1 つ残す */
export async function saveCourseCorners(folder: string, file: CornerFile): Promise<void> {
  const store = await getRunStore();
  if (!store) throw new Error('no storage folder');
  const before = await store.readText(path(folder)).catch(() => null);
  if (before) await store.writeText(`${path(folder)}.bak`, before);
  await store.writeText(path(folder), serializeCornerFile(file));
  cache.set(folder, Promise.resolve(file));
  changed();
}

/**
 * まだ corners.json のないコースなら、この周から見つけたコーナーで C1… の名前のファイルを作る (今あるコースの自動作成)。
 * 周の全体を走った周 (計測線から計測線まで) だけ
 */
export async function ensureAutoCorners(folder: string, geo: LapGeometry, found: Corner[]): Promise<void> {
  if (autoTried.has(folder) || found.length === 0 || geo.lap.isWholeSession || geo.lap.isPartialLap) return;
  autoTried.add(folder);
  if (await loadCourseCorners(folder)) return;
  if (!canUseRunStore()) return;
  const store = await getRunStore();
  if (!store) return;
  // 「無い」ときだけ作る。読めない (iCloud から落とせない など)・形が違う (手で直して壊れた) ときに作ると、
  // ユーザーの名前を C1… で上書きしてしまうため
  try {
    if ((await store.readTextStrict(path(folder))) !== null) return;
  } catch {
    return;
  }
  try {
    await saveCourseCorners(folder, newCornerFile(folder, cornersFromDetection(geo, found), true));
  } catch {
    // 書けない (保管場所が読み取り専用など) ときは、見つけた順の名前のまま
  }
}

/** コースのコーナーの名前 (読み終えるまで・ないときは null) */
export function useCourseCorners(folder: string | null): CornerFile | null {
  const [file, setFile] = useState<CornerFile | null>(null);
  useEffect(() => {
    if (!folder) { setFile(null); return; }
    let alive = true;
    const read = () => void loadCourseCorners(folder).then(f => { if (alive) setFile(f); });
    read();
    listeners.add(read);
    return () => { alive = false; listeners.delete(read); };
  }, [folder]);
  return file;
}
