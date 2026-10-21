import { describe, expect, it } from 'vitest';
import { parseLogBuffer, splitByGaps } from './logLoader';

const tr = (ja: string) => ja;

/** 確かめの値を付けた NMEA の文 */
function nmea(body: string): string {
  let x = 0;
  for (const c of body) x ^= c.charCodeAt(0);
  return `$${body}*${x.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
}

/** hh:mm:ss から、1 秒おきの RMC を n 本 */
function rmcRun(h: number, m: number, n: number, lat0 = 3523.66): string {
  let out = '';
  for (let i = 0; i < n; i++) {
    const t = h * 3600 + m * 60 + i;
    const hh = String(Math.floor(t / 3600)).padStart(2, '0');
    const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    out += nmea(`GNRMC,${hh}${mm}${ss}.00,A,${(lat0 + i * 0.001).toFixed(4)},N,14005.2800,E,50.0,90.0,130926,,,A`);
  }
  return out;
}

describe('ログの読み込み (logLoader)', () => {
  it('記録の空き (10 分以上) で分ける', () => {
    const pts = [0, 1, 2, 700, 701, 1500].map(time => ({ time }));
    expect(splitByGaps(pts).map(p => p.length)).toEqual([3, 2, 1]);
  });

  it('NMEA は、10 分以上の空きのところで 2 つの走行に分ける (.bon4・周の一覧と同じ)', async () => {
    const text = rmcRun(0, 0, 30) + rmcRun(0, 20, 30);
    const r = await parseLogBuffer('x.nmea', new TextEncoder().encode(text).buffer, tr);
    expect(r.kind).toBe('nmea');
    expect(r.parts).toHaveLength(2);
    expect(r.parts.map(p => p.points.length)).toEqual([30, 30]);
  });

  it('空きのない NMEA は 1 つの走行', async () => {
    const r = await parseLogBuffer('x.nmea', new TextEncoder().encode(rmcRun(0, 0, 60)).buffer, tr);
    expect(r.parts).toHaveLength(1);
  });

  it('知らない拡張子・位置のないファイルは断る', async () => {
    await expect(parseLogBuffer('x.mp3', new ArrayBuffer(4), tr)).rejects.toThrow('未対応');
    await expect(parseLogBuffer('x.csv', new TextEncoder().encode('a,b\n1,2\n').buffer, tr)).rejects.toThrow();
  });
});
