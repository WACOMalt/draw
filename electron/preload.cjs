// The page's native API in the Linux app: files the system opened the app with (the page calls
// onOpenFile once it can show the "open as a new canvas" dialog), updates (update.cjs), and
// VR (vr.cjs; the page's side is src/client/vr.ts).

const { contextBridge, ipcRenderer } = require('electron');

/** The main process's own message, without Electron's "Error invoking remote method" prefix. */
const plain = (e) => {
  throw new Error(String(e?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
};

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
  vr: {
    probe: () => ipcRenderer.invoke('vr-probe'),
    open: (hello) => ipcRenderer.invoke('vr-open', String(hello)).catch(plain),
    close: () => ipcRenderer.invoke('vr-close'),
    onLine(callback) {
      const listener = (_event, line) => callback(line);
      ipcRenderer.on('vr-line', listener);
      return () => ipcRenderer.removeListener('vr-line', listener);
    },
  },
});
