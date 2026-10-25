/// <reference types="vite/client" />

interface ElectronAPI {
  onOpenFiles?: (callback: (filePaths: string[]) => void) => void;
  onOpenDonateModal?: (callback: () => void) => void;
  saveBinaryFile?: (options: { defaultName?: string; dataArray: number[] }) => Promise<{ success: boolean; filePath?: string; bytesWritten?: number; error?: string }>;
  saveTextFile?: (options: { defaultName: string; text: string }) => Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  readFileBuffer?: (filePath: string) => Promise<{ success: boolean; name: string; dataArray: number[]; error?: string }>;
  openExternal?: (url: string) => Promise<boolean>;
  isElectron?: boolean;
  /** ラップタイムの一覧の保管場所 (2026-10-20、PLAN-19)。path は保管場所からの道 */
  laps?: {
    getFolder: () => Promise<string | null>;
    pickFolder: () => Promise<string | null>;
    list: () => Promise<{ success: boolean; files?: Array<{ path: string; size: number; mtimeMs: number; local?: boolean }>; error?: string }>;
    read: (path: string) => Promise<{ success: boolean; data?: Uint8Array; error?: string }>;
    readText: (path: string) => Promise<{ success: boolean; text?: string | null; error?: string }>;
    writeText: (path: string, text: string) => Promise<{ success: boolean; error?: string }>;
    /** 走行のファイルを新しく書く (取り込み)。もうあれば error: 'exists' */
    writeFile?: (path: string, data: Uint8Array) => Promise<{ success: boolean; error?: string }>;
    /** iCloud Drive にだけあるファイルか (古い版のアプリには無い) */
    fileStatus?: (path: string) => Promise<{ local: boolean; downloading: boolean }>;
    startDownload?: (path: string) => Promise<{ success: boolean }>;
    /** 走行のファイルをゴミ箱へ移す (2026-10-25) */
    remove?: (paths: string[]) => Promise<{ deleted: string[]; failed: Array<{ path: string; error: string }> }>;
  };
}

interface Window {
  electronAPI?: ElectronAPI;
}
