// ==============================================================================
// デジスパイスIV 制御ツール (プリロードスクリプト / IPCブリッジ)
// ==============================================================================

const { contextBridge, ipcRenderer } = require('electron');

// レンダラープロセスに安全なファイル保存・操作APIを公開
contextBridge.exposeInMainWorld('electronAPI', {
  onOpenFiles: (callback) => ipcRenderer.on('open-files', (_event, value) => callback(value)),
  onOpenDonateModal: (callback) => ipcRenderer.on('open-donate-modal', () => callback()),
  saveBinaryFile: (options) => ipcRenderer.invoke('save-binary-file', options),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  isElectron: true,
});
