export * from '../engine/nmeaExporter';
/**
 * ファイルダウンロード発火ヘルパー
 */
export function triggerFileDownload(filename: string, content: string | Uint8Array, mimeType: string = 'text/plain') {
  const blob = new Blob([content as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
