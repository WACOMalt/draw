// Updates for the Linux app from the GitHub releases. The page shows the dialog
// (src/client/update.svelte.ts); this side reads the latest release, and for an AppImage
// downloads the new AppImage and puts it in place of the running one: the same file, at the same
// path, that Gear Lever's GitHub updater would fetch. The next start runs the new version.
//
// .deb and .rpm installs are updated by the system's package tools: they only learn that a new
// version exists, and the page links to the release.

const { app, net } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LATEST = 'https://api.github.com/repos/WACOMalt/draw/releases/latest';
const ASSET = /^Draw_[\d.]+_amd64\.AppImage$/;
// Release files are served from GitHub (the download link redirects to its file host).
const HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/** The running AppImage file, or null for a .deb or .rpm install. */
const appImage = () => process.env.APPIMAGE || null;

/** "0.2.34" -> [0, 2, 34] */
const parts = (v) => v.replace(/^v/, '').split('-')[0].split('.').map((p) => parseInt(p, 10) || 0);
function newer(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

const allowed = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

/** GET that follows redirects itself, so every hop must be a GitHub host. */
async function fetchFromGitHub(url) {
  for (let hop = 0; hop < 5; hop++) {
    if (!allowed(url)) throw new Error('Not a GitHub file');
    // Node's fetch: Electron's net.fetch cancels a manual redirect instead of returning it.
    const res = await fetch(url, { redirect: 'manual' });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!to) return res;
    url = new URL(to, url).href;
  }
  throw new Error('Too many redirects');
}

/** The release check() found, for download(). */
let found = null;
let downloading = false;
/** The version whose AppImage is in place of the running one (a restart runs it). */
let installed = '';

/**
 * { current, update }: this app's version, and the newest release when it is newer, else null.
 * `install` says how it updates: 'appimage' (download() replaces the file), or 'manual' (.deb,
 * .rpm, or a folder this user cannot write: the page links to the release). `installed`: the new
 * AppImage is already in place, a restart runs it.
 */
async function check() {
  const res = await net.fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const r = await res.json();
  const version = String(r.tag_name || '').replace(/^v/, '');
  const current = app.getVersion();
  if (r.draft || r.prerelease || !version || !newer(version, current)) return { current, update: null };
  const asset = (r.assets || []).find((a) => ASSET.test(a.name));
  let install = 'manual';
  const file = appImage();
  if (file && asset) {
    try {
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
      install = 'appimage';
    } catch {
      // A folder this user cannot write (/opt, say): update by hand.
    }
  }
  found = { version, asset: install === 'appimage' ? asset : null };
  return { current, update: { version, page: r.html_url, install, size: asset?.size ?? 0, installed: installed === version } };
}

/**
 * Downloads the AppImage of the release check() found and puts it in place of the running one.
 * Progress goes to onProgress(0..1). Checks the size and the SHA-256 that GitHub lists for the
 * file, and that it is an AppImage, before it replaces anything.
 */
async function download(onProgress) {
  const file = appImage();
  const asset = found?.asset;
  if (!file || !asset) throw new Error('No AppImage update to download');
  if (downloading) throw new Error('Already downloading');
  if (!allowed(asset.browser_download_url)) throw new Error('Not a GitHub release file');
  downloading = true;
  // Same folder as the AppImage, so the last step is a rename (atomic, same file system).
  const part = path.join(path.dirname(file), `.${path.basename(file)}.update`);
  try {
    const res = await fetchFromGitHub(asset.browser_download_url);
    if (!res.ok || !res.body) throw new Error(`Download: HTTP ${res.status}`);
    const total = asset.size || Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part, { mode: 0o755 });
    let got = 0;
    let shown = -1;
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const pct = total ? Math.floor((got * 100) / total) : 0;
        if (pct !== shown) {
          shown = pct;
          onProgress(total ? got / total : 0);
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (asset.size && got !== asset.size) throw new Error('Download incomplete');
    const digest = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : '';
    if (digest && digest !== hash.digest('hex')) throw new Error('The file does not match the release (SHA-256)');
    // An AppImage type 2 starts as an ELF file with "AI" 2 at byte 8.
    const head = Buffer.alloc(11);
    const fd = fs.openSync(part, 'r');
    fs.readSync(fd, head, 0, 11, 0);
    fs.closeSync(fd);
    if (head.readUInt32BE(0) !== 0x7f454c46 || head.toString('latin1', 8, 11) !== 'AI\x02') throw new Error('Not an AppImage');
    fs.chmodSync(part, 0o755);
    // The running app keeps its open copy; the path now holds the new version.
    fs.renameSync(part, file);
    installed = found.version;
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  } finally {
    downloading = false;
  }
}

/** Starts the new AppImage and quits this one. */
function restart() {
  const file = appImage();
  if (!file || !installed) return;
  // Let the new instance take the single-instance lock, not hand its start over to this one.
  app.releaseSingleInstanceLock();
  // A new process of its own (app.relaunch does not start an AppImage). The AppImage runtime
  // sets its own APPIMAGE, APPDIR and friends.
  const env = { ...process.env };
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[k];
  spawn(file, [], { detached: true, stdio: 'ignore', env, cwd: process.env.OWD || app.getPath('home') }).unref();
  app.exit(0);
}

module.exports = { check, download, restart };
