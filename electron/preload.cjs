const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onOpenFiles: (callback) => ipcRenderer.on('open-files', (_event, value) => callback(value)),
  saveBinaryFile: (options) => ipcRenderer.invoke('save-binary-file', options),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath)
});
