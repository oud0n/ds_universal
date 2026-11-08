import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopUsbTransport } from './electronHost';
import type { ElectronUsbHostApi } from './electronHost';
import { LOGGER_SERIAL_OPTIONS } from './contract';

afterEach(()=>vi.unstubAllGlobals());
function api(enabled=true): ElectronUsbHostApi {
  return {available:vi.fn(async()=>({enabled})),request:vi.fn(async()=>({ok:true as const,result:null})),onEvent:vi.fn(()=>()=>{})};
}
describe('Electron USB試験経路の選択',()=>{
  it('通常のブラウザと無効時には既存経路へ返す',async()=>{
    vi.stubGlobal('window',undefined);
    expect(await desktopUsbTransport()).toBeUndefined();
    const off=api(false);expect(await desktopUsbTransport(off)).toBeUndefined();expect(off.request).not.toHaveBeenCalled();
  });
  it('有効時はHostSerialTransportで、host open失敗をWebへ迂回しない',async()=>{
    vi.stubGlobal('navigator',{get serial(){throw new Error('Web Serial used');}});
    const host=api();host.request=vi.fn(async()=>({ok:false as const,error:{code:'not-found' as const}}));
    const transport=await desktopUsbTransport(host);
    await expect(transport!.open({onData(){},onLost(){}})).rejects.toMatchObject({code:'not-found'});
    expect(host.request).toHaveBeenCalledWith('serial.open',expect.objectContaining({options:LOGGER_SERIAL_OPTIONS}));
  });
  it('binding失敗も無効扱いして隠さない',async()=>{
    const host=api();host.available=async()=>{throw {code:'permission-denied'};};
    await expect(desktopUsbTransport(host)).rejects.toMatchObject({code:'permission-denied'});
  });
});
