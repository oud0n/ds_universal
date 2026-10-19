/**
 * BLE の通知の記録 (仕様の確かめ用。速度・高度の単位、本体の情報、途切れ方)。
 *
 * - アプリ (ネイティブ): 窓口の recorder.* で、ネイティブがファイルに書き足す。画面を消していても続き、
 *   OS がアプリを止めても、起こし直したときに続きを書く
 * - ブラウザ (Web Bluetooth): このページを開いている間だけ、メモリに同じ形で書く (ページを閉じると消える)
 *
 * どちらも同じ形の文 (src/native/contract.ts の RecordingFile) になり、bleCaptureDecode.ts で読む
 */

import { callNative } from '../native/bridge';
import type { RecordingFile } from '../native/contract';
import type { BleLoggerLink } from './bleLoggerLink';
import { triggerFileDownload } from './nmeaExporter';

export interface CaptureStatus {
  recording: boolean;
  fileName?: string;
  notifications?: number;
}

export interface CaptureBackend {
  /** 画面を消しても続くか */
  readonly continuesInBackground: boolean;
  start(name: string, deviceId: string, header: string[]): Promise<string>;
  stop(): Promise<void>;
  status(): Promise<CaptureStatus>;
  list(): Promise<RecordingFile[]>;
  read(fileName: string): Promise<string>;
  remove(fileName: string): Promise<void>;
  /** 元のままのファイルを渡す (アプリは共有の画面、ブラウザはダウンロード) */
  exportRaw(fileName: string): Promise<void>;
  /** Web で作った文を渡す */
  exportText(fileName: string, text: string): Promise<void>;
}

const nativeBackend: CaptureBackend = {
  continuesInBackground: true,
  async start(name, deviceId, header) {
    return (await callNative('recorder.start', { name, deviceId, header })).fileName;
  },
  async stop() {
    await callNative('recorder.stop', {});
  },
  status: () => callNative('recorder.status', {}),
  async list() {
    return (await callNative('recorder.list', {})).files;
  },
  async read(fileName) {
    return (await callNative('recorder.read', { fileName })).text;
  },
  async remove(fileName) {
    await callNative('recorder.remove', { fileName });
  },
  async exportRaw(fileName) {
    await callNative('recorder.share', { fileName });
  },
  async exportText(fileName, text) {
    await callNative('system.shareText', { fileName, text });
  }
};

/** ブラウザ: 届いた通知をメモリに書く */
function memoryBackend(link: BleLoggerLink): CaptureBackend {
  const files = new Map<string, { text: string[]; modifiedMs: number }>();
  let active: { fileName: string; deviceId: string; lines: string[]; count: number; off: () => void } | null = null;
  const ns = (ms: number) => Math.round(ms * 1e6);

  const stop = () => {
    if (!active) return;
    active.off();
    files.set(active.fileName, { text: active.lines, modifiedMs: Date.now() });
    active = null;
  };

  return {
    continuesInBackground: false,
    async start(name, deviceId, header) {
      stop();
      let fileName = `${name}.csv`;
      for (let n = 2; files.has(fileName); n++) fileName = `${name}_${n}.csv`;
      const lines = [
        '# ds-ble-capture 1',
        ...header.map(h => `# ${h}`),
        `# started_utc_ms=${Date.now()} started_ns=${ns(performance.now())}`,
        't_ns,device,characteristic,hex'
      ];
      const a = { fileName, deviceId, lines, count: 0, off: () => {} };
      const offRaw = link.onRaw(items => {
        for (const it of items) {
          lines.push(`${ns(it.tMs)},${deviceId},2a67,${Array.from(it.bytes, b => b.toString(16).padStart(2, '0')).join('')}`);
          a.count++;
        }
      });
      const offState = link.onLinkState(state => lines.push(`# state,${ns(performance.now())},${state}`));
      a.off = () => { offRaw(); offState(); };
      active = a;
      files.set(fileName, { text: lines, modifiedMs: Date.now() });
      return fileName;
    },
    async stop() {
      stop();
    },
    async status() {
      return active ? { recording: true, fileName: active.fileName, notifications: active.count } : { recording: false };
    },
    async list() {
      return [...files].map(([fileName, f]) => ({ fileName, bytes: f.text.reduce((n, l) => n + l.length + 1, 0), modifiedMs: f.modifiedMs }));
    },
    async read(fileName) {
      const f = files.get(fileName);
      return f ? f.text.join('\n') + '\n' : '';
    },
    async remove(fileName) {
      if (active?.fileName !== fileName) files.delete(fileName);
    },
    async exportRaw(fileName) {
      triggerFileDownload(fileName, await this.read(fileName), 'text/csv');
    },
    async exportText(fileName, text) {
      triggerFileDownload(fileName, text, 'text/csv');
    }
  };
}

let memory: CaptureBackend | null = null;

/** この環境の記録の手段 (BLE を使えないときは null) */
export function captureBackendFor(link: BleLoggerLink): CaptureBackend | null {
  const kind = link.getCentral()?.kind;
  if (kind === 'native') return nativeBackend;
  if (kind === 'web') return (memory ??= memoryBackend(link));
  return null;
}

/** 記録のファイル名 (ble-20261019-1830-0012345) */
export function captureName(serial: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ble-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${serial}`;
}
