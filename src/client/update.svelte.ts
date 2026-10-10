// App updates from the GitHub releases, behind one dialog (ui/UpdateDialog.svelte):
//
// - Android: this page reads the latest release, and the app (AppUpdate.kt, as
//   window.DrawAppUpdate) downloads its APK and opens Android's installer.
// - Linux AppImage: the app (electron/update.cjs, through drawDesktop.updates) reads the
//   release, downloads the new AppImage and puts it in place of the running one. A .deb or .rpm
//   install only hears that there is a new version and gets a link to the release.
//
// The web app and the Windows and macOS apps have no updater here: they show nothing.

import { ELECTRON } from './config';
import { showToast } from './state.svelte';

const REPO = 'WACOMalt/draw';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
/** While the app is open, look again this often (desktop apps stay open for days). */
const RECHECK_MS = 6 * 60 * 60 * 1000;

interface AndroidBridge {
  download(url: string): void;
  install(): 'started' | 'needs-permission' | 'missing';
  openInstallSettings(): void;
}
type AndroidEvent = { type: 'progress'; fraction: number } | { type: 'downloaded' } | { type: 'error'; message: string };

const ANDROID = (window as unknown as { DrawAppUpdate?: AndroidBridge }).DrawAppUpdate ?? null;
const DESKTOP = ELECTRON?.updates ?? null;

/** This app can tell about (and on Android and AppImage, install) its updates. */
export const CAN_UPDATE = ANDROID !== null || DESKTOP !== null;

export interface Update {
  version: string;
  current: string;
  /** The release on GitHub. */
  page: string;
  /** 'android' and 'appimage' install from the dialog; 'manual' links to the release. */
  how: 'android' | 'appimage' | 'manual';
  /** Download size in bytes (0: unknown). */
  size: number;
  /** Android: the APK. */
  apk?: string;
  /** First lines of the commit messages since this version, newest first. */
  changes: string[];
  /** AppImage: already downloaded and in place; a restart runs it. */
  ready?: boolean;
}

export type Phase =
  | 'offer' // there is a new version
  | 'downloading'
  | 'installing' // Android's installer is open
  | 'permission' // Android: the app may not install apps yet
  | 'restart' // AppImage: the new file is in place
  | 'error';

export const upd = $state({
  open: false,
  update: null as Update | null,
  phase: 'offer' as Phase,
  progress: 0,
  error: '',
  checking: false,
  /** Check at start and every few hours. */
  auto: true,
  /** A version the person chose to skip: not offered again until a newer one. */
  skip: '',
  /**
   * The installed app's version, after a check. The Linux app loads its page from the server,
   * so the page's version (__APP_VERSION__) is the server's and may be older.
   */
  appVersion: '',
});

const STORE = 'draw.update';
try {
  const s = JSON.parse(localStorage.getItem(STORE) ?? '{}') as { auto?: boolean; skip?: string };
  upd.auto = s.auto !== false;
  upd.skip = typeof s.skip === 'string' ? s.skip : '';
} catch {
  // private window or no storage: defaults
}
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ auto: upd.auto, skip: upd.skip }));
  } catch {
    // not saved: fine
  }
}

/** "v0.2.34" -> [0, 2, 34] */
const parts = (v: string) =>
  v
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((p) => parseInt(p, 10) || 0);
export function isNewer(a: string, b: string): boolean {
  const x = parts(a),
    y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** Commit subjects between two releases (best effort: none when GitHub does not answer). */
async function changesBetween(from: string, to: string): Promise<string[]> {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/compare/v${from}...v${to}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return [];
    const d = (await r.json()) as { commits?: { commit: { message: string } }[] };
    return (d.commits ?? [])
      .map((c) => c.commit.message.split('\n')[0].trim())
      .filter((m) => m && !/^Merge /.test(m))
      .reverse();
  } catch {
    return [];
  }
}

async function androidCheck(): Promise<{ current: string; update: Update | null }> {
  const r = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
  const rel = (await r.json()) as {
    tag_name: string;
    html_url: string;
    draft: boolean;
    prerelease: boolean;
    assets: { name: string; browser_download_url: string; size: number }[];
  };
  const version = rel.tag_name.replace(/^v/, '');
  const apk = rel.assets.find((a) => /^Draw_[\d.]+_android\.apk$/.test(a.name));
  const current = __APP_VERSION__;
  if (rel.draft || rel.prerelease || !apk || !isNewer(version, current)) return { current, update: null };
  return { current, update: { version, current, page: rel.html_url, how: 'android', size: apk.size, apk: apk.browser_download_url, changes: [] } };
}

async function desktopCheck(): Promise<{ current: string; update: Update | null }> {
  const r = await DESKTOP!.check();
  if (!r.update) return { current: r.current, update: null };
  const u = r.update;
  return { current: r.current, update: { version: u.version, current: r.current, page: u.page, how: u.install, size: u.size, changes: [], ready: u.installed } };
}

let lastCheck = 0;
/** The version whose APK is downloaded: tapping Update again only opens the installer. */
let downloaded = '';

/**
 * Looks for a newer release. `manual`: the person asked (shows the result, ignores a skipped
 * version and the auto setting).
 */
export async function checkForUpdates(manual = false): Promise<void> {
  if (!CAN_UPDATE || upd.checking || upd.phase === 'downloading') return;
  if (!manual && !upd.auto) return;
  upd.checking = true;
  lastCheck = Date.now();
  try {
    const { current, update: u } = ANDROID ? await androidCheck() : await desktopCheck();
    upd.appVersion = current;
    if (!u) {
      const site = current !== __APP_VERSION__ ? ` The page comes from the server, which runs v${__APP_VERSION__}.` : '';
      if (manual) showToast(`The Draw app is up to date (v${current}).${site}`);
      return;
    }
    if (!manual && u.version === upd.skip) return;
    if (upd.update?.version !== u.version) {
      upd.update = u;
      upd.phase = u.ready ? 'restart' : 'offer';
      upd.error = '';
      upd.progress = 0;
      void changesBetween(u.current, u.version).then((c) => {
        if (upd.update?.version === u.version) upd.update.changes = c;
      });
    }
    upd.open = true;
  } catch (e) {
    console.warn('update check', e);
    if (manual) showToast('Could not reach GitHub to check for updates');
  } finally {
    upd.checking = false;
  }
}

/** Checks a little after start, then every few hours while the app is open. */
export function watchUpdates(): void {
  if (!CAN_UPDATE) return;
  setTimeout(() => void checkForUpdates(), 3000);
  setInterval(() => {
    if (Date.now() - lastCheck >= RECHECK_MS) void checkForUpdates();
  }, 10 * 60 * 1000);
  // Android: the app may sit in the background for days. Check again when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck >= RECHECK_MS) void checkForUpdates();
  });
}

/** Android: download events from AppUpdate.kt. */
let androidWait: { resolve: () => void; reject: (e: Error) => void } | null = null;
(window as unknown as { __drawUpdate?: (e: AndroidEvent) => void }).__drawUpdate = (e) => {
  if (e.type === 'progress') upd.progress = e.fraction;
  else if (e.type === 'downloaded') androidWait?.resolve();
  else if (e.type === 'error') androidWait?.reject(new Error(e.message));
  if (e.type !== 'progress') androidWait = null;
};

function androidInstall() {
  const r = ANDROID!.install();
  if (r === 'needs-permission') upd.phase = 'permission';
  else if (r === 'missing') {
    downloaded = '';
    upd.phase = 'error';
    upd.error = 'The download is gone. Try again.';
  } else upd.phase = 'installing';
}

/** The dialog's Update button. */
export async function startUpdate(): Promise<void> {
  const u = upd.update;
  if (!u || upd.phase === 'downloading') return;
  if (u.how === 'manual') {
    window.open(u.page, '_blank', 'noopener');
    upd.open = false;
    return;
  }
  upd.error = '';
  try {
    if (u.how === 'android') {
      if (downloaded !== u.version) {
        upd.phase = 'downloading';
        upd.progress = 0;
        await new Promise<void>((resolve, reject) => {
          androidWait = { resolve, reject };
          ANDROID!.download(u.apk!);
        });
        downloaded = u.version;
      }
      androidInstall();
    } else {
      upd.phase = 'downloading';
      upd.progress = 0;
      await DESKTOP!.download((f) => (upd.progress = f));
      upd.phase = 'restart';
      upd.open = true; // the dialog may have been closed during the download
    }
  } catch (e) {
    upd.phase = 'error';
    upd.error = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
  }
}

/** Android: open the setting that allows installing apps; Install tries again after. */
export function grantPermission(): void {
  ANDROID?.openInstallSettings();
}
export const retryInstall = androidInstall;

/** AppImage: start the new version now. */
export function restartApp(): void {
  void DESKTOP?.restart();
}

export function skipVersion(): void {
  if (upd.update) upd.skip = upd.update.version;
  save();
  upd.open = false;
}

export function setAutoCheck(on: boolean): void {
  upd.auto = on;
  save();
}
