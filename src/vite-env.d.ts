/// <reference types="vite/client" />

interface ElectronAPI {
  deviceHost?: import('./services/deviceHost/electronHost').ElectronUsbHostApi;
  onOpenFiles?: (callback: (filePaths: string[]) => void) => void;
  onOpenDonateModal?: (callback: () => void) => void;
  saveBinaryFile?: (options: { defaultName?: string; dataArray: number[] }) => Promise<{ success: boolean; filePath?: string; bytesWritten?: number; error?: string }>;
  saveTextFile?: (options: { defaultName: string; text: string }) => Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  readFileBuffer?: (filePath: string) => Promise<{ success: boolean; name: string; dataArray: number[]; error?: string }>;
  openExternal?: (url: string) => Promise<boolean>;
  isElectron?: boolean;
  /** 更新 (PLAN-44、2026-11-02。前の版のアプリには無い) */
  update?: {
    getState: () => Promise<DesktopUpdateState>;
    check: () => Promise<DesktopUpdateState>;
    download: () => Promise<DesktopUpdateState>;
    install: () => Promise<DesktopUpdateState>;
    setAutoCheck: (on: boolean) => Promise<DesktopUpdateState>;
    openReleases: () => Promise<void>;
    onState: (callback: (state: DesktopUpdateState) => void) => () => void;
  };
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

/** デスクトップ版の更新の状態 (electron/updater.cjs) */
interface DesktopUpdateState {
  /** 更新を確かめる版か (タグで作った版だけ) */
  enabled: boolean;
  /** auto: 落として入れ替える。manual: ダウンロードのページを開くだけ */
  mode: 'auto' | 'manual';
  /** 起動したときに確かめるか (止めると、設定のボタンを押したときだけ通信する) */
  autoCheck: boolean;
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';
  current: string;
  version: string | null;
  percent: number;
  error: string | null;
  checkedAt: number | null;
}

/** 版の番号 (package.json。vite.config.ts の define) */
declare const __APP_VERSION__: string;

interface Window {
  electronAPI?: ElectronAPI;
}
