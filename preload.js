// ==============================================================================
// デジスパイスIV 制御ツール (プリロードスクリプト / IPCブリッジ)
// ==============================================================================

const { contextBridge, ipcRenderer } = require('electron');

// レンダラープロセスに安全なファイル保存APIを公開
contextBridge.exposeInMainWorld('electronAPI', {
  saveBinaryFile: (options) => ipcRenderer.invoke('save-binary-file', options),
  isElectron: true,
});
