/**
 * スマートフォンか (タブレットは含まない)。端末の画面の短い辺で決める (600px 未満)。スマートフォンを回しても変わらない。
 * スマートフォン向けの配置は、これに加えてウインドウが狭いときにもする (src/hooks/useCompactLayout.ts)
 * (iPhone は 390〜440px、iPad mini は 744px、パソコンは 800px 以上)
 */
export const isPhone: boolean = typeof screen !== 'undefined' && Math.min(screen.width, screen.height) < 600;

/**
 * ロガー (デジスパイスIV) と USB でつなげるか。つなげないときはロガー設定を出さない。
 * Web Serial があるブラウザ (Electron 版・パソコンの Chrome / Edge) だけ。Safari・Firefox・iPhone / iPad にはない。
 * Android の Chrome は Bluetooth 用に Web Serial を持つが、USB の機器にはつなげないので除く。
 * 開発サーバーで `?sim=1` を付けたときは、シミュレーターにつなぐので出す
 */
export const canUseLoggerUsb: boolean = (() => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('sim')) return true;
  return 'serial' in navigator && !/Android/i.test(navigator.userAgent);
})();

/**
 * iPhone / iPad か。iPadOS の Safari は Mac と名乗るので、タッチの点の数でも見分ける
 */
export const isIOS: boolean = typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/**
 * ファイルの入力欄の accept。iOS では付けない (undefined)。
 * iOS のファイルの選択画面は、accept に .bon4 など iOS が知らない拡張子を並べると、そのファイルを灰色にして選べなくする
 * (ds4_convert でも同じだった)。iOS ではどのファイルも選べるようにして、読み込むときに中身で判定する
 */
export const fileAccept = (accept: string): string | undefined => (isIOS ? undefined : accept);
