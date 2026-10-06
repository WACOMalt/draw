// Draw for Linux: the web app in Chromium (Electron).
//
// The Tauri runtime on Linux is WebKitGTK: it gives web pages no pen pressure, and with the
// NVIDIA driver its WebGL is much slower than a browser's. Chromium has neither problem. The
// window shows the hosted site, so the app updates with the server. Windows (WebView2, also
// Chromium) and macOS stay on Tauri (src-tauri/).
//
// Native parts: .bdraw files the system opens the app with (sent to the page through
// preload.cjs), the .bdraw MIME type for AppImages (Gear Lever does not install it), and a
// file manager thumbnailer for .bdraw (draw-thumbnailer.sh), and updates from the GitHub
// releases (update.cjs).

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const updates = require('./update.cjs');

const SITE = (process.env.DRAW_URL || 'https://draw.bsums.xyz').replace(/\/+$/, '');
const ORIGIN = new URL(SITE).origin;
const MAX_FILE = 64 * 1024 * 1024;

// Native Wayland on a Wayland desktop, X11 elsewhere. On Wayland, Chromium reads the tablet
// through zwp_tablet_v2 (pen type and pressure). Under XWayland with the NVIDIA driver the GPU
// process crashes and WebGL is lost (tested: RTX 3090, KDE Plasma). DRAW_OZONE=x11 forces X11.
if (process.env.DRAW_OZONE) app.commandLine.appendSwitch('ozone-platform', process.env.DRAW_OZONE);
else app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

// `draw --thumbnail IN OUT SIZE`: render a .bdraw to a PNG and exit (thumbnail.cjs). No window,
// no single-instance lock: the file manager may run several at once, next to the open app.
const thumbAt = process.argv.indexOf('--thumbnail');
const THUMBNAIL = thumbAt > 0;
if (THUMBNAIL) require('./thumbnail.cjs')(app, BrowserWindow, process.argv.slice(thumbAt + 1, thumbAt + 4));

// One app instance: a .bdraw opened later goes to the window that is already open.
if (!THUMBNAIL && !app.requestSingleInstanceLock()) app.quit();

/** .bdraw paths from the command line (the file manager passes them), not yet sent to the page. */
const pending = [];
let pageReady = false;
let win = null;

function collect(argv) {
  for (const arg of argv.slice(1)) {
    if (/\.bdraw$/i.test(arg) && fs.existsSync(arg)) pending.push(path.resolve(arg));
  }
}

function sendPending() {
  if (!pageReady || !win) return;
  for (const file of pending.splice(0)) {
    try {
      if (fs.statSync(file).size > MAX_FILE) continue;
      win.webContents.send('open-file', { name: path.basename(file), bytes: fs.readFileSync(file) });
    } catch (e) {
      console.error(`draw: cannot read ${file}: ${e.message}`);
    }
  }
}

const isOurs = (url) => {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
};

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 480,
    minHeight: 400,
    title: 'Draw',
    backgroundColor: '#1d1d1d',
    icon: path.join(process.resourcesPath, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const wc = win.webContents;

  // Only the site runs in the window. Everything else opens in the default browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (isOurs(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  // A new page load (reload, navigation) asks for the files again.
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) pageReady = false;
  });
  // No connection: a small page with a retry button instead of Chromium's error page.
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */ || !isOurs(url)) return;
    void win.loadFile(path.join(__dirname, 'offline.html'), { query: { site: SITE } });
  });

  void win.loadURL(SITE);
}

// The page asks for the opened files when it is ready for them (files.ts watchOpenedFiles).
ipcMain.on('opened-files-ready', (e) => {
  if (!win || e.sender !== win.webContents || !isOurs(e.senderFrame?.url ?? '')) return;
  pageReady = true;
  sendPending();
});

// Updates (update.cjs). Only the site's page may ask.
const fromPage = (e) => win && e.sender === win.webContents && isOurs(e.senderFrame?.url ?? '');
ipcMain.handle('update-check', (e) => (fromPage(e) ? updates.check() : null));
ipcMain.handle('update-download', (e) => {
  if (!fromPage(e)) return;
  const wc = e.sender;
  return updates.download((fraction) => !wc.isDestroyed() && wc.send('update-progress', fraction));
});
ipcMain.handle('update-restart', (e) => fromPage(e) && updates.restart());

app.on('second-instance', (_e, argv) => {
  collect(argv);
  sendPending();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

/**
 * .deb and .rpm install the .bdraw MIME type for the system. An AppImage cannot, and Gear Lever
 * does not do it on install, so the AppImage registers it for the user (~/.local/share/mime).
 * Checks the built cache, so a failed run repairs itself on the next start.
 */
function registerMimeForAppImage() {
  if (!process.env.APPIMAGE) return;
  try {
    const xml = fs.readFileSync(path.join(process.resourcesPath, 'xyz.bsums.draw.xml'), 'utf8');
    const dataHome = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local/share');
    const mimeDir = path.join(dataHome, 'mime');
    const file = path.join(mimeDir, 'packages/xyz.bsums.draw.xml');
    const read = (f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    };
    if (read(path.join(mimeDir, 'globs2')).includes(':application/x-bdraw:') && read(file) === xml) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, xml);
    // System tools: run them without the AppImage's library path.
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '' };
    spawnSync('update-mime-database', [mimeDir], { env, stdio: 'ignore' });
    const apps = path.join(dataHome, 'applications');
    if (fs.existsSync(apps)) spawnSync('update-desktop-database', [apps], { env, stdio: 'ignore' });
  } catch (e) {
    console.error(`draw: MIME registration failed: ${e.message}`);
  }
}

/**
 * File manager thumbnails for .bdraw (freedesktop thumbnailer spec: KDE Dolphin through KIO,
 * GNOME Files, ...). Installs draw-thumbnailer.sh and a .thumbnailer entry for this user, for
 * every package type: the script reads the preview PNG that Draw stores in saved files.
 * Rewrites only what changed.
 */
function registerThumbnailer() {
  try {
    const dataHome = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local/share');
    const script = path.join(dataHome, 'xyz.bsums.draw', 'draw-thumbnailer.sh');
    const entry = path.join(dataHome, 'thumbnailers', 'xyz.bsums.draw.thumbnailer');
    const put = (file, content, mode) => {
      let old = null;
      try {
        old = fs.readFileSync(file, 'utf8');
      } catch {
        // not there yet
      }
      if (old === content) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode });
      fs.chmodSync(file, mode);
    };
    put(script, fs.readFileSync(path.join(process.resourcesPath, 'draw-thumbnailer.sh'), 'utf8'), 0o755);
    // The app itself renders files without a stored preview: the AppImage file, or the binary.
    const exe = process.env.APPIMAGE || process.execPath;
    const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
    put(
      entry,
      ['[Thumbnailer Entry]', 'TryExec=/bin/sh', `Exec=/bin/sh ${q(script)} %i %o %s ${q(exe)}`, 'MimeType=application/x-bdraw;', ''].join('\n'),
      0o644,
    );
  } catch (e) {
    console.error(`draw: thumbnailer registration failed: ${e.message}`);
  }
}

if (!THUMBNAIL) collect(process.argv);
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  if (THUMBNAIL) return;
  createWindow();
  setTimeout(() => {
    registerMimeForAppImage();
    registerThumbnailer();
  }, 2000);
  if (process.env.DRAW_GPU_INFO) {
    // Diagnostics: DRAW_GPU_INFO=1 prints the WebGL renderer the page gets and the GPU status.
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const renderer = await win.webContents.executeJavaScript(
          `(() => { const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) return 'no webgl2';
            const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`,
        );
        console.log('draw: webgl2 renderer:', renderer);
        const f = app.getGPUFeatureStatus();
        console.log('draw: gpu compositing:', f.gpu_compositing, '| webgl2:', f.webgl2, '| rasterization:', f.rasterization);
      }, 3000),
    );
  }
});

app.on('window-all-closed', () => {
  if (!THUMBNAIL) app.quit();
});
