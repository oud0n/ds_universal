/**
 * システムのデフォルトブラウザで安全に外部リンクを開くユーティリティ
 */
export const openExternalUrl = (url: string) => {
  if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};
