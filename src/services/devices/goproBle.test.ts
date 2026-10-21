import { describe, expect, it } from 'vitest';
import { GoProAssembler, goproCommands, goproKeepAlive, goproQueryStatus, packetize, parseCommandResponse, parseStatusResponse } from './goproBle';

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join(':');

describe('GoPro のパケット', () => {
  it('短いメッセージは一般の頭 (長さ 5 ビット) を付けた 1 つのパケット', () => {
    expect(packetize(goproCommands.shutter(true)).map(hex)).toEqual(['03:01:01:01']);
    expect(packetize(goproCommands.shutter(false)).map(hex)).toEqual(['03:01:01:00']);
    expect(packetize(goproCommands.hilight()).map(hex)).toEqual(['01:18']);
    expect(packetize(goproKeepAlive()).map(hex)).toEqual(['03:5b:01:42']);
  });

  it('20 バイトより長いメッセージは、続きのパケットに分け、つなぎ直すと元に戻る', () => {
    const msg = Uint8Array.from({ length: 50 }, (_, i) => i);
    const packets = packetize(msg);
    expect(packets.every(p => p.length <= 20)).toBe(true);
    expect(packets[0][0] & 0x80).toBe(0);
    expect(packets.slice(1).map(p => p[0])).toEqual([0x80, 0x81]);
    const a = new GoProAssembler();
    const got = packets.map(p => a.push(p));
    expect(got.slice(0, -1)).toEqual([null, null]);
    expect(Array.from(got[got.length - 1]!)).toEqual(Array.from(msg));
  });

  it('拡張 (13 ビット) の頭のメッセージも読める', () => {
    const a = new GoProAssembler();
    expect(Array.from(a.push(Uint8Array.from([0x20, 0x03, 0x13, 0x00, 0x0a]))!)).toEqual([0x13, 0x00, 0x0a]);
  });

  it('時計合わせは、資料の例と同じ並び (2023-01-31 03:04:05、UTC-02:00、夏時間)', () => {
    const d = new Date(Date.UTC(2023, 0, 31, 5, 4, 5)); // その土地の 03:04:05 は UTC の 05:04:05
    expect(hex(goproCommands.setLocalDateTime(d, -120, true))).toBe('0f:0a:07:e7:01:1f:03:04:05:ff:88:01');
  });

  it('命令の答えと、状態の問い合わせの答えを読む', () => {
    expect(parseCommandResponse(Uint8Array.from([0x01, 0x00]))).toEqual({ id: 1, ok: true });
    expect(parseCommandResponse(Uint8Array.from([0x01, 0x02]))).toEqual({ id: 1, ok: false });
    expect(hex(goproQueryStatus())).toBe('13:08:0a:23:46');
    // busy=0、encoding=1、残り 3600 秒 (4 バイト)、電池 87%
    const res = Uint8Array.from([0x13, 0x00, 8, 1, 0, 10, 1, 1, 35, 4, 0, 0, 0x0e, 0x10, 70, 1, 87]);
    expect(parseStatusResponse(res)).toEqual({ busy: false, encoding: true, remainingVideoSec: 3600, batteryPercent: 87 });
    expect(parseStatusResponse(Uint8Array.from([0x13, 0x01]))).toBeNull();
  });
});
