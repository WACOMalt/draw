// The page's native API in the Linux app: files the system opened the app with (the page calls
// onOpenFile once it can show the "open as a new canvas" dialog), and updates (update.cjs).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('drawDesktop', {
  kind: 'electron',
  onOpenFile(callback) {
    ipcRenderer.on('open-file', (_event, file) => callback(file.name, file.bytes));
    ipcRenderer.send('opened-files-ready');
  },
  updates: {
    check: () => ipcRenderer.invoke('update-check'),
    download(onProgress) {
      const listener = (_event, fraction) => onProgress(fraction);
      ipcRenderer.on('update-progress', listener);
      return ipcRenderer.invoke('update-download').finally(() => ipcRenderer.removeListener('update-progress', listener));
    },
    restart: () => ipcRenderer.invoke('update-restart'),
  },
});
