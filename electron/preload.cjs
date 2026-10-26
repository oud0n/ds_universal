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
  saveTextFile: (options) => ipcRenderer.invoke('save-text-file', options),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // 画面の言語をメニューに知らせる
  setLanguage: (lang) => ipcRenderer.send('set-language', lang),
  // ラップタイムの一覧の保管場所 (選んだフォルダの中だけ読める。書けるのは laptimes.json だけ)
  laps: {
    getFolder: () => ipcRenderer.invoke('laps-get-folder'),
    pickFolder: () => ipcRenderer.invoke('laps-pick-folder'),
    list: () => ipcRenderer.invoke('laps-list'),
    read: (p) => ipcRenderer.invoke('laps-read', p),
    readText: (p) => ipcRenderer.invoke('laps-read-text', p),
    writeText: (p, text) => ipcRenderer.invoke('laps-write-text', p, text),
    writeFile: (p, data) => ipcRenderer.invoke('laps-write-file', p, data),
    fileStatus: (p) => ipcRenderer.invoke('laps-file-status', p),
    startDownload: (p) => ipcRenderer.invoke('laps-start-download', p),
    remove: (paths) => ipcRenderer.invoke('laps-delete', paths)
  },
  isElectron: true
});
