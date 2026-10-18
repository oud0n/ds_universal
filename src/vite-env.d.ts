/// <reference types="vite/client" />

interface ElectronAPI {
  onOpenFiles?: (callback: (filePaths: string[]) => void) => void;
  onOpenDonateModal?: (callback: () => void) => void;
  saveBinaryFile?: (options: { defaultName?: string; dataArray: number[] }) => Promise<{ success: boolean; filePath?: string; bytesWritten?: number; error?: string }>;
  saveTextFile?: (options: { defaultName: string; text: string }) => Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  readFileBuffer?: (filePath: string) => Promise<{ success: boolean; name: string; dataArray: number[]; error?: string }>;
  openExternal?: (url: string) => Promise<boolean>;
  isElectron?: boolean;
}

interface Window {
  electronAPI?: ElectronAPI;
}
