/**
 * デスクトップ版 (Mac・Windows) の案内。ブラウザ版をパソコンで開いたときだけ、ダウンロードの案内を出す
 */

import { hasNative } from '../native/bridge';
import { isIOS, isPhone } from './device';
import { getLang } from './i18n';

/**
 * デスクトップ版のダウンロードの案内 (README の「ダウンロード & インストール」)。
 * Mac 版は署名していないので、ファイルを直接落とさせず、開けないときの手順と一緒に読んでもらう
 */
export function desktopDownloadUrl(): string {
  return getLang() === 'en'
    ? 'https://github.com/oud0n/ds_universal/blob/main/README.en.md#-download-and-installation'
    : 'https://github.com/oud0n/ds_universal#-ダウンロード--インストール';
}

/** パソコンのブラウザ版で開いているか (デスクトップ版・iPhone アプリの中、スマートフォン・iPad では false) */
export function isBrowserVersionOnPc(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.electronAPI && !hasNative() && !isIOS && !isPhone;
}
