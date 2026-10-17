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
