import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { isMockNativeRequested } from './utils/device';

// 開発サーバーで `?native=mock` を付けたら、ネイティブのふりをする窓口を入れる (iPhone のアプリの画面を試すため)
async function installMock(): Promise<void> {
  if (!isMockNativeRequested()) return;
  const { installMockNative } = await import('./native/mockNative');
  (window as unknown as { __dsMockNative: unknown }).__dsMockNative = installMockNative();
}

installMock().finally(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
