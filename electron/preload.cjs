// The page's only native API in the Linux app: files the system opened the app with.
// The page calls onOpenFile once it can show the "open as a new canvas" dialog.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('drawDesktop', {
  kind: 'electron',
  onOpenFile(callback) {
    ipcRenderer.on('open-file', (_event, file) => callback(file.name, file.bytes));
    ipcRenderer.send('opened-files-ready');
  },
});
