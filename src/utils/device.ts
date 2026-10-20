import { hasNative } from '../native/bridge';

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
  // スマートフォンのアプリでは USB のメニューを出さない (2026-10-20)
  if (hasNative()) return false;
  return 'serial' in navigator && !/Android/i.test(navigator.userAgent);
})();

/**
 * ロガー (デジスパイス) と Bluetooth でつなぐ機能 (と、それを使うラップタイマー) を出すか。
 * スマートフォンのアプリ (iPhone・Android) だけで出す (2026-10-20)。ブラウザ版・デスクトップ版では、Web Bluetooth があっても出さない。
 * アプリかどうかは、アプリが入れるネイティブの窓口 (window.webkit.messageHandlers.dsNative・window.dsNativeAndroid) で見分ける
 * (ユーザーエージェントは書き換えられるため使わない)。
 * 開発サーバーで `?native=mock` を付けたときは、ネイティブのふりをする窓口 (src/native/mockNative.ts) につなぐので出す
 */
export const canUseLoggerBle: boolean = (() => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  if (isMockNativeRequested()) return true;
  return hasNative();
})();

/** ラップタイマーを出すか (スマートフォンのアプリだけ。開発サーバーでは試せるように出す) */
export const canUseLapTimer: boolean = canUseLoggerBle || import.meta.env.DEV;

/** ロガー設定のタブを出すか (USB か Bluetooth のどちらかでつなげる) */
export const canUseLogger: boolean = canUseLoggerUsb || canUseLoggerBle;

/** 開発サーバーで `?native=mock` が付いているか */
export function isMockNativeRequested(): boolean {
  return import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('native') === 'mock';
}

/**
 * iPhone / iPad か。iPadOS の Safari は Mac と名乗るので、タッチの点の数でも見分ける
 */
export const isIOS: boolean = typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/**
 * 描き直しの重いブラウザか (Mac・iPhone の Safari などの WebKit)。Chrome・Edge・Electron は Chromium なので含めない。
 * Mac の Safari は、再生中に毎コマ (1 秒 60 回) 画面を描き直すと、動画のコマが落ちる (Chrome では落ちない。2026-10-19)
 */
export const isWebKitBrowser: boolean = typeof navigator !== 'undefined'
  // パソコンの Chrome・Edge は "Chrome/"・"Edg/" を名乗る。iPhone・iPad の Chrome (CriOS)・Edge (EdgiOS) は中身が WebKit なので含める
  && /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium|Edg\/|Electron/.test(navigator.userAgent);

/**
 * 再生中に画面を描き直す間隔の下限 (ミリ秒) を、URL の ?redraw=<ms> で試しに変える (重さを比べるため)。なければ null
 */
export const redrawIntervalOverride: number | null = (() => {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('redraw');
  const n = v === null || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : null;
})();

/**
 * ファイルの入力欄の accept。iOS では付けない (undefined)。
 * iOS のファイルの選択画面は、accept に .bon4 など iOS が知らない拡張子を並べると、そのファイルを灰色にして選べなくする
 * (ds4_convert でも同じだった)。iOS ではどのファイルも選べるようにして、読み込むときに中身で判定する
 */
export const fileAccept = (accept: string): string | undefined => (isIOS ? undefined : accept);
