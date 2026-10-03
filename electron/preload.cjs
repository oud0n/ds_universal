const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onOpenFiles: (callback) => ipcRenderer.on('open-files', (_event, value) => callback(value)),
  onOpenDonateModal: (callback) => ipcRenderer.on('open-donate-modal', () => callback()),
  saveBinaryFile: (options) => ipcRenderer.invoke('save-binary-file', options),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  isElectron: true
});
