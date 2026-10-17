// "Open in VR": starts vdraw (the VR app, vr/ in the repository) on the open canvas and passes
// JSON lines between it and the page (src/client/vr.ts). The Windows app bundles vdraw as a
// sidecar (tauri.windows.conf.json: externalBin), installed next to the app's own executable.
// The Linux app is Electron (electron/vr.cjs does the same there); macOS, Android and iOS have
// no OpenXR, so these commands only say "not available" there.
//
// `vdraw --probe` prints one line: is an OpenXR runtime installed (it does not start it).
// `vdraw --bridge` reads the hello line (canvas, identity, view) from stdin, then writes
// {"t":"ready"}, {"t":"closed","view":...} or {"t":"error","message":...} to stdout; it ends on
// {"t":"close"} or when its stdin closes. Credentials go only through that pipe. The page gets
// each stdout line as a "vr-line" event, then {"t":"exit","code":...} when the process is gone.

#[cfg(any(windows, target_os = "linux"))]
pub use imp::*;
#[cfg(not(any(windows, target_os = "linux")))]
pub use stub::*;

#[cfg(any(windows, target_os = "linux"))]
mod imp {
    use serde_json::{json, Value};
    use std::{
        io::{BufRead, BufReader, Write},
        path::PathBuf,
        process::{Child, ChildStdin, Command, Stdio},
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Mutex,
        },
        time::{Duration, Instant},
    };
    use tauri::{AppHandle, Emitter, Manager};

    /** How long vdraw has to end after {"t":"close"} before it is killed. */
    const CLOSE_GRACE: Duration = Duration::from_secs(5);
    const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
    const MAX_HELLO: usize = 64 * 1024;

    struct Run {
        id: u64,
        stdin: Option<ChildStdin>,
        child: Arc<Mutex<Child>>,
        closing: bool,
    }

    /** The running vdraw, if any (one at a time). */
    #[derive(Default)]
    pub struct Vr {
        run: Mutex<Option<Run>>,
        next: AtomicU64,
    }

    /** The sidecar: next to the app's executable (Tauri strips the target triple from its name). */
    fn vdraw_path() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let path = exe.parent()?.join(if cfg!(windows) { "vdraw.exe" } else { "vdraw" });
        path.is_file().then_some(path)
    }

    fn command(path: &PathBuf, arg: &str) -> Command {
        let mut cmd = Command::new(path);
        cmd.arg(arg);
        // No console window for it (the app is a GUI program).
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    fn not_available() -> Value {
        json!({ "ok": false, "reason": "not available" })
    }

    /** `vdraw --probe`, at most PROBE_TIMEOUT. */
    fn probe_blocking() -> Value {
        let Some(path) = vdraw_path() else { return not_available() };
        let child = command(&path, "--probe").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => return json!({ "ok": false, "reason": format!("vdraw --probe failed: {e}") }),
        };
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if start.elapsed() < PROBE_TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return json!({ "ok": false, "reason": "vdraw --probe did not answer" });
                }
            }
        }
        let mut out = String::new();
        if let Some(mut stdout) = child.stdout.take() {
            let _ = std::io::Read::read_to_string(&mut stdout, &mut out);
        }
        // The first JSON object line; logs go to stderr, but be lenient.
        let line = out.lines().find_map(|l| serde_json::from_str::<Value>(l).ok().filter(Value::is_object));
        match line {
            Some(v) if v["ok"] == true => json!({ "ok": true, "runtime": v["runtime"].as_str().unwrap_or("") }),
            Some(v) if v["ok"] == false => json!({ "ok": false, "reason": v["reason"].as_str().unwrap_or("no VR runtime") }),
            _ => json!({ "ok": false, "reason": "vdraw --probe said nothing" }),
        }
    }

    #[tauri::command]
    pub async fn vr_probe() -> Value {
        tauri::async_runtime::spawn_blocking(probe_blocking).await.unwrap_or_else(|_| not_available())
    }

    fn emit_line(app: &AppHandle, line: String) {
        let _ = app.emit_to("main", "vr-line", line);
    }

    /** Starts `vdraw --bridge` and writes the hello line. */
    #[tauri::command]
    pub fn vr_open(app: AppHandle, hello: String, state: tauri::State<Vr>) -> Result<(), String> {
        let mut slot = state.run.lock().unwrap();
        if slot.is_some() {
            return Err("VR is already open".into());
        }
        if hello.len() > MAX_HELLO {
            return Err("bad hello".into());
        }
        // One line of JSON, whatever the page sent.
        let hello: Value = serde_json::from_str(&hello).map_err(|_| "bad hello".to_string())?;
        let path = vdraw_path().ok_or("vdraw is not installed with this app")?;
        let mut child = command(&path, "--bridge")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start VR: {e}"))?;
        let mut stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if let Some(w) = stdin.as_mut() {
            // If it already exited, its exit says why.
            let _ = writeln!(w, "{hello}").and_then(|_| w.flush());
        }
        let id = state.next.fetch_add(1, Ordering::Relaxed);
        let child = Arc::new(Mutex::new(child));
        *slot = Some(Run { id, stdin, child: child.clone(), closing: false });
        drop(slot);

        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("vdraw: {line}");
                }
            });
        }
        std::thread::spawn(move || {
            if let Some(stdout) = stdout {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        emit_line(&app, line);
                    }
                }
            }
            // Its stdout ended: wait for the exit (polling, so close() can still kill it).
            let code = loop {
                match child.lock().unwrap().try_wait() {
                    Ok(Some(status)) => break status.code(),
                    Ok(None) => {}
                    Err(_) => break None,
                }
                std::thread::sleep(Duration::from_millis(50));
            };
            let vr = app.state::<Vr>();
            let mut slot = vr.run.lock().unwrap();
            if slot.as_ref().is_some_and(|r| r.id == id) {
                *slot = None;
            }
            drop(slot);
            emit_line(&app, json!({ "t": "exit", "code": code }).to_string());
        });
        Ok(())
    }

    /** Asks vdraw to end, and kills it if it is still there a few seconds later. */
    #[tauri::command]
    pub fn vr_close(app: AppHandle, state: tauri::State<Vr>) {
        let mut slot = state.run.lock().unwrap();
        let Some(run) = slot.as_mut() else { return };
        if run.closing {
            return;
        }
        run.closing = true;
        if let Some(w) = run.stdin.as_mut() {
            let _ = w.write_all(b"{\"t\":\"close\"}\n").and_then(|_| w.flush());
        }
        let (id, child) = (run.id, run.child.clone());
        drop(slot);
        std::thread::spawn(move || {
            std::thread::sleep(CLOSE_GRACE);
            let still = app.state::<Vr>().run.lock().unwrap().as_ref().is_some_and(|r| r.id == id);
            if still {
                let _ = child.lock().unwrap().kill();
            }
        });
    }

    /** The app quits: closing vdraw's stdin ends it. */
    pub fn quit(app: &AppHandle) {
        if let Some(run) = app.state::<Vr>().run.lock().unwrap().as_mut() {
            run.stdin = None;
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod stub {
    use serde_json::{json, Value};

    #[derive(Default)]
    pub struct Vr;

    #[tauri::command]
    pub async fn vr_probe() -> Value {
        json!({ "ok": false, "reason": "not available" })
    }

    #[tauri::command]
    pub fn vr_open(hello: String) -> Result<(), String> {
        let _ = hello;
        Err("VR is not available on this system".into())
    }

    #[tauri::command]
    pub fn vr_close() {}

    pub fn quit(_app: &tauri::AppHandle) {}
}
