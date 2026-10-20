import { describe, expect, it } from 'vitest';
import { Elm327Client, parseObdResponse, type ObdSample } from './obdElm327';

describe('OBD-II の答えを読む', () => {
  it('回転数・車速・アクセル開度・水温', () => {
    expect(parseObdResponse('410C1AF8\r\r')).toEqual({ key: 'rpm', value: 1726 });
    expect(parseObdResponse('41 0D 64 \r')).toEqual({ key: 'speed_kmh', value: 100 });
    expect(parseObdResponse('411180')).toEqual({ key: 'throttle_pct', value: 50.2 });
    expect(parseObdResponse('SEARCHING...\r41055A')).toEqual({ key: 'coolant_c', value: 50 });
  });
  it('読めない答え', () => {
    expect(parseObdResponse('NO DATA')).toBeNull();
    expect(parseObdResponse('?')).toBeNull();
    expect(parseObdResponse('410C1A')).toBeNull();
  });
});

describe('ELM327 とのやり取り (偽の機器)', () => {
  it('初期化してから PID を順に問い合わせ、値を返す', async () => {
    const sent: string[] = [];
    const samples: ObdSample[] = [];
    let client: Elm327Client;
    const answers: Record<string, string> = { '010C': '410C1AF8', '010D': '410D64' };
    // 偽の機器: 書かれた命令に、少しおいて「>」付きで答える (答えは 2 つに分けて届ける)
    const write = async (text: string) => {
      const cmd = text.trim();
      sent.push(cmd);
      const a = `${answers[cmd] ?? 'OK'}\r\r>`;
      setTimeout(() => {
        client.feed(new TextEncoder().encode(a.slice(0, 3)));
        client.feed(new TextEncoder().encode(a.slice(3)));
      }, 1);
    };
    client = new Elm327Client(write, s => { samples.push(s); if (samples.length >= 4) client.stop(); }, () => 1000, 200);
    await client.start(['rpm', 'speed_kmh']);
    expect(sent.slice(0, 6)).toEqual(['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']);
    expect(sent.slice(6, 10)).toEqual(['010C', '010D', '010C', '010D']);
    expect(samples.map(s => [s.key, s.value])).toEqual([['rpm', 1726], ['speed_kmh', 100], ['rpm', 1726], ['speed_kmh', 100]]);
  });

  it('答えが来なければ、待つのをやめて次へ進む', async () => {
    const sent: string[] = [];
    const client = new Elm327Client(async t => { sent.push(t.trim()); if (sent.length >= 8) client.stop(); }, () => {}, () => 0, 20);
    await client.start(['rpm']);
    expect(sent.length).toBe(8);
  });
});
