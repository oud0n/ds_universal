/**
 * 再生の時計の元 (2026-10-20 の試作)。
 *
 * ふだんは App の時計 (requestAnimationFrame) が時刻を進め、動画はそれに合わせる (PlaybackController)。
 * ただ Safari (iPhone・パソコン) は、音を出している動画の速さを変えたり位置を動かしたりすると、映像と音が止まる
 * (WebKit の不具合 163433・306350。下の AVFoundation の動き)。合わせ直すほど、かえって引っかかる。
 * そこで、音を出している動画が再生しているときは、その動画の位置を App の時計にする (音を時計の元にする、動画の再生ソフトのふつうのやり方)。
 * App はその時刻に付いていくだけにし、音のある動画には手を出さない。音のない動画はこれまでどおり速さで合わせる。
 *
 * 時計の元になれるのは、見えている動画のウインドウの、音を出して再生している枠 1 つ
 */

type Reader = () => number | null;

const sources = new Map<object, Reader>();

/** 時計の元になれるもの (動画のウインドウ) を登録する。返す関数で外す */
export function setClockMaster(owner: object, read: Reader): () => void {
  sources.set(owner, read);
  return () => { sources.delete(owner); };
}

/**
 * 時計の元の、今の App の時刻 (秒)。音を出して再生している動画のあるウインドウのうち、登録の早いもの。ないときは null
 * (グラフ画面に動画のウインドウが 2 つあるとき、音を消したほうのウインドウは null を返すので、音を出しているほうが使われる)
 */
export function readClockMaster(): number | null {
  if (!clockMasterEnabled) return null;
  for (const read of sources.values()) {
    const v = read();
    if (v !== null) return v;
  }
  return null;
}

/** URL の ?clock=app で、これまでどおり App の時計だけで進める (比べるため) */
export const clockMasterEnabled: boolean =
  typeof window === 'undefined' || new URLSearchParams(window.location.search).get('clock') !== 'app';
