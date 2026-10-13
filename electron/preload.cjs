const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 登録を解除する関数を返す
  onOpenFiles: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('open-files', listener);
    return () => ipcRenderer.removeListener('open-files', listener);
  },
  onOpenDonateModal: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('open-donate-modal', listener);
    return () => ipcRenderer.removeListener('open-donate-modal', listener);
  },
  saveBinaryFile: (options) => ipcRenderer.invoke('save-binary-file', options),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  isElectron: true
});
