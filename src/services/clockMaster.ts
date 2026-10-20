/**
 * 再生の時計の元 (2026-10-20 の試作)。
 *
 * ふだんは App の時計 (requestAnimationFrame) が時刻を進め、動画はそれに合わせる (PlaybackController)。
 * ただ Safari (iPhone・パソコン) は、音を出している動画の速さを変えたり位置を動かしたりすると、映像と音が止まる
 * (WebKit の不具合 163433・306350。下の AVFoundation の動き)。合わせ直すほど、かえって引っかかる。
 * そこで、音を出している動画が再生しているときは、その動画の位置を App の時計にする (音を時計の元にする、動画の再生ソフトのふつうのやり方)。
 * App はその時刻に付いていくだけにし、音のある動画には手を出さない。音のない動画はこれまでどおり速さで合わせる。
 *
 * 時計の元になれるのは、見えている動画のウインドウ 1 つだけ (後から登録したものが使われる)
 */

type Reader = () => number | null;

let active: { owner: object; read: Reader } | null = null;

/** 時計の元を登録する。返す関数で外す */
export function setClockMaster(owner: object, read: Reader): () => void {
  active = { owner, read };
  return () => {
    if (active?.owner === owner) active = null;
  };
}

/** 時計の元の、今の App の時刻 (秒)。元がない・使えないときは null */
export function readClockMaster(): number | null {
  if (!active || !clockMasterEnabled) return null;
  return active.read();
}

/** URL の ?clock=app で、これまでどおり App の時計だけで進める (比べるため) */
export const clockMasterEnabled: boolean =
  typeof window === 'undefined' || new URLSearchParams(window.location.search).get('clock') !== 'app';
