// `draw --thumbnail IN OUT [SIZE]`: renders a .bdraw file to a PNG of at most SIZE × SIZE (64 to
// 1024, default 256) and exits: 0 when OUT is written, 1 otherwise. draw-thumbnailer.sh runs this
// for files without a stored preview (saved before Draw 0.2.24). A hidden window loads the
// bundled thumb/thumb.html, which renders with the same off-screen WebGL2 renderer as the image
// export. Each run has its own temporary profile, so many can run at once next to the app.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_FILE = 64 * 1024 * 1024;

module.exports = function thumbnail(app, BrowserWindow, [input, output, size]) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'draw-thumb-'));
  app.setPath('userData', profile);
  const done = (code) => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // ignore
    }
    app.exit(code);
  };
  setTimeout(() => done(1), 30_000);
  app
    .whenReady()
    .then(async () => {
      if (!input || !output) return done(1);
      const data = fs.readFileSync(input);
      if (data.length > MAX_FILE) return done(1);
      const px = Math.max(64, Math.min(1024, Math.round(Number(size)) || 256));
      const win = new BrowserWindow({
        show: false,
        width: 64,
        height: 64,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
      });
      await win.loadFile(path.join(__dirname, 'thumb', 'thumb.html'));
      const png = await win.webContents.executeJavaScript(`renderBdraw(${JSON.stringify(data.toString('base64'))}, ${px})`);
      if (!png) return done(1);
      fs.writeFileSync(output, Buffer.from(png, 'base64'));
      done(0);
    })
    .catch((e) => {
      console.error(`draw: thumbnail failed: ${e.message}`);
      done(1);
    });
};
