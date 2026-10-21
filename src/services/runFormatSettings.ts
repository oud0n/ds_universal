/**
 * 走行のファイルの形式の設定 (2026-10-21)。走行の基準は .nmea。.bon4 はデジスパイスの公式ソフトで開くためのもので、書くかを選べる (既定は書く)
 */

const KEY = 'lapTimer.writeBon4';

/** .bon4 も書くか */
export function getWriteBon4(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setWriteBon4(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // 覚えられなくても、今は使える
  }
}
