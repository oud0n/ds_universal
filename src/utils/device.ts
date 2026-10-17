/**
 * スマートフォンか (タブレットは含まない)。スマートフォン向けの配置にするかをこれで決める。
 * ウインドウの幅でなく端末の画面の短い辺で決める (600px 未満)。スマートフォンを回しても、パソコンのウインドウを狭くしても変わらない。
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
