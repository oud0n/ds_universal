/**
 * 走行を消す (走行の画面の「この走行を消す」。2026-10-25)。
 *
 * 同じ日に何本も走ると、同じフォルダ (サーキット/日付/) に別の走行のファイルが並ぶ。消すのは、その走行のものと分かるものだけ:
 * - ログ: <走行名>.<拡張子> (.nmea と .bon4 の組など)
 * - センサーの記録: <走行名>.<機器>.csv (心拍・OBD・iphone_imu など)
 * - 内蔵カメラの動画: <走行名>.mov / _2 / _front / _v2 など
 * - その走行に付けた動画 (runs.json の行の videos。GoPro など)。ただし、ほかの走行にも付いている動画は残す (1 本の動画に 2 つの走行が映るとき)
 * 名前の形が合っても、それ自体がほかの走行のログになっているファイル (例: session.nmea と、別の走行の session_2.nmea) は残す。
 * 付けていない動画は、同じフォルダにあっても残す。走行の行 (runs.json) は消す。laptimes.json の控えは、次に一覧を作るときに消えたファイルの分が落ちる
 */
import type { RunItem } from './runOpener';
import type { RunFileInfo, RunStore } from './runStore';
import { removeRunRow } from './runsFile';

export interface RunDeletePlan {
  /** 消すファイル (保管場所の道) */
  remove: Array<{ path: string; size: number; kind: 'log' | 'sensor' | 'camera' | 'video' }>;
  /** 同じフォルダにあって残すファイル (理由つき。確かめの画面に出す) */
  keep: Array<{ path: string; reason: 'other-run' | 'shared-video' | 'unattached-video' }>;
}

const VIDEO = /\.(mp4|mov|m4v|insv|mkv|webm)$/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 道の最後の名前と、入っているフォルダ (末尾の / 付き) */
function split(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** 走行のファイルの名前から、走行名 (拡張子なし) */
const stemOf = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * 消すファイルを決める (読むだけ。ファイルは変えない)。
 * files: 置き場の全部のファイル、runs: 置き場の全部の走行 (同じフォルダの別の走行を見分けるため)
 */
export function planRunDelete(item: RunItem, files: RunFileInfo[], runs: RunItem[]): RunDeletePlan {
  const runPath = `${item.folder}/${item.file}`;
  const { dir } = split(runPath);
  const base = stemOf(split(runPath).name);
  // 同じフォルダのほかの走行の名前 (このファイルたちは消さない)
  const others = runs.filter(r => r.folder === item.folder && `${r.folder}/${r.file}` !== runPath && split(`${r.folder}/${r.file}`).dir === dir);
  const otherStems = new Set(others.map(r => stemOf(split(r.file).name)).filter(s => s !== base));
  // ほかの走行に付いている動画 (同じフォルダの名前)
  // 付けた動画は runs.json の行、無ければ控え (laptimes.json) のもの (一覧の videos はその 2 つを合わせたもの)
  const sharedVideos = new Set(others.flatMap(r => r.videos));
  const attached = new Set(item.videos);
  const b = esc(base);
  const logRe = new RegExp(`^${b}\\.[^.]+$`, 'i');
  const sensorRe = new RegExp(`^${b}\\.[^.]+\\.csv$`, 'i');
  const cameraRe = new RegExp(`^${b}(_front)?(_\\d+)?(_v\\d+)?\\.(mov|mp4)$`, 'i');

  const patterns = (stem: string) => {
    const e = esc(stem);
    return [new RegExp(`^${e}\\.[^.]+$`, 'i'), new RegExp(`^${e}\\.[^.]+\\.csv$`, 'i'), new RegExp(`^${e}(_front)?(_\\d+)?(_v\\d+)?\\.(mov|mp4)$`, 'i')];
  };
  const otherRes = [...otherStems].map(stem => ({ stem, re: patterns(stem) }));

  const plan: RunDeletePlan = { remove: [], keep: [] };
  for (const f of files) {
    const { dir: fdir, name } = split(f.path);
    if (fdir !== dir || name.startsWith('.')) continue;
    // ほかの走行の名前の形にも合うファイル (例: 別の走行 base_2 の base_2.mov)。両方に合うときは、長い名前の走行のもの
    // (base_2 を消すときの base_2.mov は、base の 2 つめの録画ではなく base_2 のもの)。走行名に . があっても合うように、形で見る
    const otherOwner = otherRes.some(o => o.stem.length > base.length && o.re.some(x => x.test(name)));
    const isCamera = cameraRe.test(name);
    const isLog = !isCamera && logRe.test(name);
    const isSensor = sensorRe.test(name);
    if (isLog || isSensor || isCamera) {
      // 名前の形は合っても、ほかの走行のもの (例: 別の走行の base_2.nmea・base_2.mov)
      if (otherOwner) { plan.keep.push({ path: f.path, reason: 'other-run' }); continue; }
      if (isCamera && sharedVideos.has(name)) { plan.keep.push({ path: f.path, reason: 'shared-video' }); continue; }
      plan.remove.push({ path: f.path, size: f.size, kind: isCamera ? 'camera' : isSensor ? 'sensor' : 'log' });
      continue;
    }
    if (VIDEO.test(name)) {
      if (!attached.has(name)) {
        // ほかの走行の内蔵カメラの動画 (その走行の名前の形) なら、そう出す
        const other = otherRes.some(o => o.re.some(x => x.test(name)));
        plan.keep.push({ path: f.path, reason: other ? 'other-run' : 'unattached-video' });
        continue;
      }
      if (sharedVideos.has(name)) { plan.keep.push({ path: f.path, reason: 'shared-video' }); continue; }
      plan.remove.push({ path: f.path, size: f.size, kind: 'video' });
    }
  }
  return plan;
}

/** 消す (ファイルを消してから、走行の行を消す)。消せなかったファイルと、ゴミ箱へ移せずすぐに消したファイルを返す */
export async function deleteRun(store: RunStore, item: RunItem, plan: RunDeletePlan): Promise<{ failed: Array<{ path: string; error: string }>; permanent: string[] }> {
  if (!store.remove) throw new Error('cannot delete files here');
  const r = await store.remove(plan.remove.map(f => f.path));
  // ログが消えたときだけ、走行の行を消す (消せなかったら、行は残して次に開けるようにする)
  const logGone = plan.remove.filter(f => f.kind === 'log').every(f => r.deleted.includes(f.path));
  if (logGone) await removeRunRow(store, item.folder, item.file);
  return { failed: r.failed, permanent: r.permanent ?? [] };
}
