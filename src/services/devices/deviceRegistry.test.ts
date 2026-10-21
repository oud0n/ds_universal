import { describe, expect, it, vi } from 'vitest';
import { checkDeviceFileName, devicesOfGenre, suggestFileName, upsertDevice, type RegisteredDevice } from './deviceRegistry';

const dev = (id: string, kind: RegisteredDevice['kind'], fileName: string): RegisteredDevice => ({ id, kind, bleName: id, displayName: id, fileName, addedAt: 0 });

describe('機器の登録', () => {
  it('ファイル名用の名前の候補は種類の名前、同じ種類があれば _2', () => {
    expect(suggestFileName('hr', [])).toBe('hr');
    expect(suggestFileName('hr', [dev('a', 'hr', 'hr')])).toBe('hr_2');
    expect(suggestFileName('hr', [dev('a', 'hr', 'hr'), dev('b', 'hr', 'hr_2')])).toBe('hr_3');
  });
  it('ファイル名用の名前は英小文字・数字・_ だけで、ほかの機器と重ならない', () => {
    expect(checkDeviceFileName('hr_driver')).toBeNull();
    expect(checkDeviceFileName('HR')).not.toBeNull();
    expect(checkDeviceFileName('心拍')).not.toBeNull();
    expect(checkDeviceFileName('hr driver')).not.toBeNull();
    expect(checkDeviceFileName('')).not.toBeNull();
    const list = [dev('a', 'hr', 'hr')];
    expect(checkDeviceFileName('hr', list)?.ja).toContain('同じ名前');
    expect(checkDeviceFileName('hr', list, 'a')).toBeNull();
  });
  it('タブ (位置・センサー・カメラ) で分ける', () => {
    const list = upsertDevice(upsertDevice(upsertDevice([], dev('r', 'racebox', 'racebox')), dev('h', 'hr', 'hr')), dev('g', 'gopro', 'gopro'));
    expect(devicesOfGenre(list, 'position').map(d => d.id)).toEqual(['r']);
    expect(devicesOfGenre(list, 'sensor').map(d => d.id)).toEqual(['h']);
    expect(devicesOfGenre(list, 'camera').map(d => d.id)).toEqual(['g']);
  });
});

describe('センサーの .csv', () => {
  it('はじめに列の名前を書き、時刻と値を書き足す (無い値は空)', async () => {
    const calls: Array<{ path: string; text: string; truncate?: boolean }> = [];
    vi.resetModules();
    vi.doMock('../../native/bridge', () => ({
      hasNative: () => true,
      toBase64: (b: Uint8Array) => new TextDecoder().decode(b),
      callNative: async (_m: string, p: { path: string; b64: string; truncate?: boolean }) => { calls.push({ path: p.path, text: p.b64, truncate: p.truncate }); return {}; }
    }));
    const { SensorCsvRecorder } = await import('../sensorCsvRecorder');
    const rec = new SensorCsvRecorder('sodegaura/20261024100000', 'obd', ['rpm', 'throttle_pct']);
    rec.add(1000, { rpm: 3000, throttle_pct: 50.1234 });
    rec.add(1100, { rpm: 3100 });
    await rec.flush();
    rec.add(1200, { throttle_pct: 10 });
    await rec.flush();
    expect(calls.map(c => c.path)).toEqual(Array(3).fill('sodegaura/20261024100000.obd.csv'));
    expect(calls[0]).toMatchObject({ text: 'time_utc_ms,rpm,throttle_pct\n', truncate: true });
    expect(calls[1].text).toBe('1000,3000,50.123\n1100,3100,\n');
    expect(calls[2].text).toBe('1200,,10\n');
    vi.doUnmock('../../native/bridge');
  });
});
