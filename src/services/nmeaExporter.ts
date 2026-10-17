/**
 * NMEA-0183 の文を組み立てる部品と、ファイルのダウンロード。
 * 書き出し本体は変換画面 (logConverter.ts) に 1 本化している
 */

export function calculateNmeaChecksum(sentence: string): string {
  let checksum = 0;
  for (let i = 0; i < sentence.length; i++) {
    checksum ^= sentence.charCodeAt(i);
  }
  return checksum.toString(16).toUpperCase().padStart(2, '0');
}

export function createNmeaSentence(bodyWithoutDollarAndChecksum: string): string {
  const checksum = calculateNmeaChecksum(bodyWithoutDollarAndChecksum);
  return `$${bodyWithoutDollarAndChecksum}*${checksum}\r\n`;
}

/**
 * 10進度数から NMEA 座標形式 (DDMM.MMMMMM) への変換
 */
export function formatNmeaCoord(val: number, isLat: boolean): { nmea: string; dir: string } {
  const sign = val >= 0;
  const absVal = Math.abs(val);
  const degrees = Math.floor(absVal);
  const minutes = (absVal - degrees) * 60;

  const degStr = isLat
    ? degrees.toString().padStart(2, '0')
    : degrees.toString().padStart(3, '0');
  let minStr = minutes.toFixed(6).padStart(9, '0');
  let degOut = degStr;
  // 丸めで分が 60 になった場合は度へ繰り上げる
  if (parseFloat(minStr) >= 60) {
    minStr = (0).toFixed(6).padStart(9, '0');
    degOut = (degrees + 1).toString().padStart(isLat ? 2 : 3, '0');
  }
  const dir = isLat ? (sign ? 'N' : 'S') : (sign ? 'E' : 'W');

  return {
    nmea: `${degOut}${minStr}`,
    dir
  };
}

/**
 * ファイルダウンロード発火ヘルパー
 */
export function triggerFileDownload(filename: string, content: string, mimeType: string = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
