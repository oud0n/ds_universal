/**
 * スマートフォン・タブレットか (USB でロガーとつなげない端末)。
 * iPhone / iPad は Web Serial に対応しておらず、Android の Chrome も USB 接続のシリアルは使えないため、ロガー設定を出さない。
 * iPadOS の Safari はパソコンの UA を名乗るので、タッチの点数で見分ける
 */
export const isMobileDevice: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile) return true;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
})();

/**
 * スマートフォンか (タブレットは含まない)。スマートフォン向けの配置にするかをこれで決める (画面の幅では決めない)。
 * - Chrome 系: userAgentData.mobile (スマートフォンだけ true)
 * - iPhone / iPod、Android のスマートフォン (UA に Mobile を含む。タブレットは含まない)
 * - iPhone の Safari で「デスクトップ用 Web サイト」にしたときは Mac を名乗るので、タッチ操作と画面の短い辺 (600px 未満) で見分ける
 */
export const isPhone: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile) return true;
  const ua = navigator.userAgent;
  if (/iPhone|iPod/i.test(ua)) return true;
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1 && typeof screen !== 'undefined') {
    return Math.min(screen.width, screen.height) < 600;
  }
  return false;
})();

/**
 * ロガー (デジスパイスIV) と USB でつなげるか。つなげないときはロガー設定を出さない。
 * Web Serial があるブラウザ (Electron 版・パソコンの Chrome / Edge) だけ。Safari・Firefox にはない。
 * Android の Chrome は Bluetooth 用に Web Serial を持つことがあるが USB には使えないので、スマートフォン・タブレットは除く。
 * 開発サーバーで `?sim=1` を付けたときは、シミュレーターにつなぐので出す
 */
export const canUseLoggerUsb: boolean = (() => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('sim')) return true;
  return !isMobileDevice && 'serial' in navigator;
})();
