/**
 * デジスパイスIV のプロトコル層 (入出力のない部分)。
 * コマンドの組み立て・チェックサム・受け取ったバイト列を行に分ける処理・応答の項目の取り出し。
 * 送受信の層 (loggerTransport.ts) にも、画面にも依存しないので、どの環境 (Web Serial・Rust・BLE) でも同じものを使う
 */

// 改行のないゴミデータが続いたときに捨てるまでの長さ
const READ_BUFFER_LIMIT = 1024 * 1024;

// NMEA の XOR チェックサム ($ と * の間)
export function calculateChecksum(body: string): string {
  let clean = body.trim();
  if (clean.startsWith('$')) clean = clean.substring(1);
  const starIdx = clean.indexOf('*');
  if (starIdx >= 0) clean = clean.substring(0, starIdx);

  let cs = 0;
  for (let i = 0; i < clean.length; i++) {
    cs ^= clean.charCodeAt(i);
  }
  return cs.toString(16).toUpperCase().padStart(2, '0');
}

// NMEA コマンド整形 ($<Body>*<CS>\r\n)
export function formatCommand(body: string): string {
  const cs = calculateChecksum(body);
  let clean = body.trim();
  if (clean.startsWith('$')) clean = clean.substring(1);
  const starIdx = clean.indexOf('*');
  if (starIdx >= 0) clean = clean.substring(0, starIdx);
  return `$${clean}*${cs}\r\n`;
}

/** 送るバイト列 (コマンド整形済み) */
export function encodeCommand(body: string): Uint8Array {
  return new TextEncoder().encode(formatCommand(body));
}

// `$...*HH` 形式のチェックサム検証
export function verifyNmeaChecksum(line: string): boolean {
  const m = /^\$([^*]*)\*([0-9A-Fa-f]{2})\s*$/.exec(line);
  if (!m) return false;
  let cs = 0;
  for (let i = 0; i < m[1].length; i++) cs ^= m[1].charCodeAt(i);
  return cs === parseInt(m[2], 16);
}

// 応答の項目 (チェックサムの前をカンマで分けたもの)
export function fields(line: string): string[] {
  return line.split('*')[0].split(',');
}

/** 受け取ったバイト列を、改行ごとの行に分ける (届く単位は行の区切りと関係ないため) */
export class LineSplitter {
  private decoder = new TextDecoder();
  private buffer = '';

  /** 届いた分を足し、そろった行 (末尾の \r を除き、空行は除く) を返す */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    // 改行のないゴミデータが続いた場合に際限なく溜め込まない
    if (this.buffer.length > READ_BUFFER_LIMIT && this.buffer.indexOf('\n') < 0) {
      this.buffer = '';
    }
    const lines: string[] = [];
    let newlineIdx;
    while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.substring(0, newlineIdx).replace(/\r$/, '');
      this.buffer = this.buffer.substring(newlineIdx + 1);
      if (line.trim().length > 0) lines.push(line);
    }
    return lines;
  }

  /** 組み立て途中の行を捨てる (受信が途切れたとき・つなぎ直したとき) */
  reset(): void {
    this.buffer = '';
    this.decoder = new TextDecoder();
  }
}
