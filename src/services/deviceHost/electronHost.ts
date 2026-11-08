import type { DeviceHost, HostCommands, HostEvent, HostFault } from './contract';
import { hostError } from './contract';
import { HostSerialTransport } from './serialTransport';
import { tr } from '../../utils/i18n';

export interface ElectronUsbHostApi {
  available(): Promise<{ enabled: boolean }>;
  request(method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: HostFault }>;
  onEvent(receive: (event: HostEvent) => void): () => void;
}
export function electronUsbHost(api: ElectronUsbHostApi): DeviceHost {
  return {
    async listen(receive) { return api.onEvent(receive); },
    async request<K extends keyof HostCommands>(method: K, params: HostCommands[K]['params']): Promise<HostCommands[K]['result']> {
      const response = await api.request(method, params);
      if (!response.ok) throw response.error;
      return response.result as HostCommands[K]['result'];
    }
  };
}
/** 開発版の明示的な試験経路だけで有効。開始後の失敗をWebへ迂回しない。 */
export async function desktopUsbTransport(api = typeof window === 'undefined' ? undefined : window.electronAPI?.deviceHost): Promise<HostSerialTransport | undefined> {
  if (!api) return undefined;
  try {
    if (!(await api.available()).enabled) return undefined;
    return new HostSerialTransport(electronUsbHost(api), tr);
  } catch (error) { throw hostError(error, tr); }
}
