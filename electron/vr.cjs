// "Open in VR" in the Linux app: starts vdraw (the VR app, shipped beside the app in resources/)
// on the open canvas and passes JSON lines between it and the page (src/client/vr.ts).
//
// `vdraw --probe` prints one line: is an OpenXR runtime installed (it does not start it).
// `vdraw --bridge` reads the hello line (canvas, identity, view) from stdin, then writes
// {"t":"ready"}, {"t":"closed","view":...} or {"t":"error","message":...} to stdout; it ends on
// {"t":"close"} or when its stdin closes. Credentials go only through that pipe.
// The page gets each stdout line, then {"t":"exit","code":...} when the process is gone.
//
// DRAW_VDRAW=/path/to/vdraw runs another build (development, or a test double).

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

/** How long vdraw has to end after {"t":"close"} before it is killed. */
const CLOSE_GRACE_MS = 5000;
const PROBE_TIMEOUT_MS = 5000;
const MAX_HELLO = 64 * 1024;

/** The vdraw binary: resources/vdraw in the package, the cargo build in a checkout. */
function vdrawPath(app) {
  if (process.env.DRAW_VDRAW) return process.env.DRAW_VDRAW;
  return app.isPackaged ? path.join(process.resourcesPath, 'vdraw') : path.join(__dirname, '../vr/target/release/vdraw');
}

/**
 * vdraw's environment: the user's, without the AppImage's library folders (vdraw needs the
 * system's Vulkan loader and GPU driver, not libraries bundled for Chromium).
 */
function vdrawEnv() {
  const env = { ...process.env };
  const appdir = process.env.APPDIR;
  if (appdir && env.LD_LIBRARY_PATH) {
    const kept = env.LD_LIBRARY_PATH.split(':').filter((d) => d && !d.startsWith(appdir));
    if (kept.length) env.LD_LIBRARY_PATH = kept.join(':');
    else delete env.LD_LIBRARY_PATH;
  }
  delete env.DRAW_VDRAW;
  return env;
}

/** The first JSON object line of `text`, or null. */
function firstJsonLine(text) {
  for (const line of text.split('\n')) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') return v;
    } catch {
      // not JSON: a log line
    }
  }
  return null;
}

/**
 * The bridge. `send(line)` delivers a line to the page (dropped when there is no page);
 * `supported` is false where VR cannot run (only Linux and Windows have OpenXR).
 */
function createVr({ app, send, supported = process.platform === 'linux' || process.platform === 'win32' }) {
  /** The running vdraw: { child, closing } or null. */
  let run = null;

  function probe() {
    const exe = vdrawPath(app);
    if (!supported || !fs.existsSync(exe)) return Promise.resolve({ ok: false, reason: 'not available' });
    return new Promise((resolve) => {
      execFile(exe, ['--probe'], { env: vdrawEnv(), timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout) => {
        const v = firstJsonLine(String(stdout ?? ''));
        if (v && v.ok === true) resolve({ ok: true, runtime: typeof v.runtime === 'string' ? v.runtime : '' });
        else if (v && v.ok === false) resolve({ ok: false, reason: typeof v.reason === 'string' ? v.reason : 'no VR runtime' });
        else resolve({ ok: false, reason: err ? `vdraw --probe failed: ${err.message}` : 'vdraw --probe said nothing' });
      });
    });
  }

  /** Starts `vdraw --bridge` and writes the hello. Throws when it cannot start. */
  function open(hello) {
    if (!supported) throw new Error('VR is not available on this system');
    if (run) throw new Error('VR is already open');
    if (typeof hello !== 'string' || hello.length > MAX_HELLO) throw new Error('bad hello');
    // One line of JSON, whatever the page sent.
    const line = JSON.stringify(JSON.parse(hello));
    const exe = vdrawPath(app);
    if (!fs.existsSync(exe)) throw new Error('vdraw is not installed with this app');
    const child = spawn(exe, ['--bridge'], { env: vdrawEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const me = { child, closing: null };
    run = me;
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(me.closing);
      if (run === me) run = null;
      send(JSON.stringify({ t: 'exit', code }));
    };
    child.on('error', (e) => {
      send(JSON.stringify({ t: 'error', message: `Could not start VR: ${e.message}` }));
      end(null);
    });
    // Its stdout lines first, then the exit (close waits for the pipes to end).
    child.on('close', (code) => end(code));
    child.stdin.on('error', () => {}); // it exited before reading: the exit says so
    readline.createInterface({ input: child.stdout }).on('line', (l) => {
      if (l.trim()) send(l);
    });
    readline.createInterface({ input: child.stderr }).on('line', (l) => console.error(`vdraw: ${l}`));
    child.stdin.write(`${line}\n`);
  }

  /** Asks vdraw to end, and kills it if it is still there a few seconds later. */
  function close() {
    const me = run;
    if (!me || me.closing) return;
    if (me.child.stdin.writable) me.child.stdin.write('{"t":"close"}\n');
    me.closing = setTimeout(() => {
      if (me.child.exitCode === null && me.child.signalCode === null) me.child.kill('SIGKILL');
    }, CLOSE_GRACE_MS);
  }

  /** The app quits: closing its stdin ends vdraw. */
  function quit() {
    run?.child.stdin.end();
  }

  return { probe, open, close, quit, running: () => run !== null };
}

module.exports = { createVr };
