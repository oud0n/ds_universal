import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { isIPad, isMockNativeRequested } from './utils/device';
import { callNative, hasNative } from './native/bridge';

// 開発サーバーで `?native=mock` を付けたら、ネイティブのふりをする窓口を入れる (iPhone のアプリの画面を試すため)
async function installMock(): Promise<void> {
  if (!isMockNativeRequested()) return;
  const { installMockNative } = await import('./native/mockNative');
  (window as unknown as { __dsMockNative: unknown }).__dsMockNative = installMockNative();
}

installMock().finally(() => {
  // ページを読み込んだ (読み込み直した) ときは、アプリの中で書きかけのファイルを全部書き終えたものにする。
  // 前のページの走行のファイルには書き足さないので、選んだフォルダへ移してよい (前のアプリは not-supported)
  if (hasNative()) void callNative('system.closeFiles', { all: true }).catch(() => {});
  // iPad のアプリ: ウィンドウ表示で左上に出るウィンドウのボタン (閉じる・最小化など) は safe area に入らないので、
  // 全画面でもいつも左上を空けておく (index.css の .ipad-app。2026-10-28、BUG-38)
  if (hasNative() && isIPad) document.documentElement.classList.add('ipad-app');
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
