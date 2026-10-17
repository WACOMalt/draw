//! `vdraw --bridge`: VR opened from the 2D desktop app, on the canvas it shows. The app starts
//! vdraw with pipes: it writes one line of JSON first (the canvas, its server, who the user is,
//! and what the 2D view shows: see `Hello`), and later lines asking it to close; vdraw writes
//! lines back: `ready` when the canvas is open in the headset, `closed` (with where the user
//! last looked) when it ends, `error` when it cannot go on. The user's credentials travel only
//! over this pipe (never on the command line, where other programs could read them). Logs go to
//! stderr.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// What the 2D view shows: its middle (canvas units) and how wide it is (canvas units).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct View {
    pub x: f64,
    pub y: f64,
    pub width: f64,
}

/// The app's first line.
#[derive(Clone, Debug, Deserialize)]
pub struct Hello {
    pub server: String,
    pub canvas: String,
    #[serde(default)]
    pub link: Option<String>,
    pub name: String,
    pub color: String,
    pub anon: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub view: Option<View>,
}

/// Reads the hello from stdin, and from then on watches stdin: a `close` line, or stdin closing
/// (the app quit), sets `quit`.
pub fn start(quit: Arc<AtomicBool>) -> Result<Hello> {
    let stdin = std::io::stdin();
    let mut line = String::new();
    stdin.lock().read_line(&mut line).context("reading the 2D app's hello")?;
    let hello: Hello = serde_json::from_str(line.trim()).context("the 2D app's hello")?;
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(l) if serde_json::from_str::<serde_json::Value>(&l).ok().and_then(|v| v.get("t").and_then(|t| t.as_str()).map(str::to_string)).as_deref() == Some("close") => {
                    quit.store(true, Ordering::Relaxed);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        // The pipe closed: the app is gone.
        quit.store(true, Ordering::Relaxed);
    });
    Ok(hello)
}

fn send(v: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

/// The canvas is open in the headset.
pub fn ready() {
    send(json!({ "t": "ready" }));
}

/// VR ended; `view`: where the user last looked, for the 2D view to go to.
pub fn closed(view: Option<View>) {
    send(match view {
        Some(v) => json!({ "t": "closed", "view": { "x": v.x, "y": v.y, "width": v.width } }),
        None => json!({ "t": "closed" }),
    });
}

/// It cannot go on (it exits after).
pub fn error(message: &str) {
    send(json!({ "t": "error", "message": message }));
}

/// `vdraw --probe`: whether VR can run here, without starting the VR runtime (an OpenXR
/// instance would start SteamVR): an OpenXR runtime is installed, by its manifest, where the
/// OpenXR loader looks for it (XR_RUNTIME_JSON; on Linux the XDG config dirs; on Windows the
/// registry). Whether a headset is on is found out when VR opens.
pub fn probe() -> serde_json::Value {
    match active_runtime() {
        Some(path) => {
            // Its name, when the manifest says it.
            let name = std::fs::read(&path)
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| v.pointer("/runtime/name").and_then(|n| n.as_str()).map(str::to_string))
                .unwrap_or_else(|| path.display().to_string());
            json!({ "ok": true, "runtime": name })
        }
        None => json!({ "ok": false, "reason": "no OpenXR runtime is installed (SteamVR, Meta Link, Monado, WiVRn)" }),
    }
}

fn active_runtime() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    if let Some(p) = std::env::var_os("XR_RUNTIME_JSON").map(PathBuf::from).filter(|p| p.exists()) {
        return Some(p);
    }
    #[cfg(windows)]
    {
        // HKLM\SOFTWARE\Khronos\OpenXR\1, value ActiveRuntime.
        let out = std::process::Command::new("reg").args(["query", r"HKLM\SOFTWARE\Khronos\OpenXR\1", "/v", "ActiveRuntime"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().find(|l| l.contains("ActiveRuntime"))?;
        let path = line.split("REG_SZ").nth(1)?.trim();
        return Some(PathBuf::from(path)).filter(|p| p.exists());
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".config")));
        let dirs = std::env::var("XDG_CONFIG_DIRS").unwrap_or_else(|_| "/etc/xdg".into());
        config
            .into_iter()
            .chain(dirs.split(':').filter(|d| !d.is_empty()).map(PathBuf::from))
            .chain([PathBuf::from("/etc")])
            .map(|d| d.join("openxr/1/active_runtime.json"))
            .find(|p| p.exists())
    }
}

/// The OpenXR runtimes to start, in order (None: the system's default). The default is what
/// the OpenXR loader starts, but it may name a runtime that is not running while another is
/// (Monado installed as the default, SteamVR in use): so a running SteamVR comes first, then
/// the default, then the other runtimes installed. XR_RUNTIME_JSON, when set, is the only one.
pub fn runtimes_to_try() -> Vec<Option<std::path::PathBuf>> {
    if std::env::var_os("XR_RUNTIME_JSON").is_some() {
        return vec![None];
    }
    let default = active_runtime().and_then(|p| std::fs::canonicalize(&p).ok().or(Some(p)));
    let installed = installed_runtimes();
    let steam = installed.iter().find(|p| p.to_string_lossy().contains("steamxr")).cloned();
    let mut out: Vec<Option<std::path::PathBuf>> = Vec::new();
    if let Some(s) = steam.clone().filter(|_| steamvr_running()) {
        out.push(Some(s));
    }
    out.push(None);
    for p in steam.into_iter().chain(installed) {
        let p = std::fs::canonicalize(&p).unwrap_or(p);
        if Some(&p) != default.as_ref() && !out.iter().flatten().any(|o| *o == p) {
            out.push(Some(p));
        }
    }
    // The default, when it is one of the others already, need not be tried twice.
    if let Some(d) = &default {
        let first_steam = out.first().and_then(|o| o.as_ref()) == Some(d);
        if first_steam {
            out.retain(|o| o.is_some());
        }
    }
    out
}

/// OpenXR runtime manifests installed here (SteamVR's where Steam keeps it, and those in the
/// OpenXR folders; on Windows the registry's list).
fn installed_runtimes() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut out: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(o) = std::process::Command::new("reg").args(["query", r"HKLM\SOFTWARE\Khronos\OpenXR\1\AvailableRuntimes"]).output() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                if let Some(path) = line.split("REG_DWORD").next().map(str::trim).filter(|p| p.to_ascii_lowercase().ends_with(".json")) {
                    out.push(PathBuf::from(path));
                }
            }
        }
        out.push(PathBuf::from(r"C:\Program Files (x86)\Steam\steamapps\common\SteamVR\steamxr_win64.json"));
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            // Steam's own folders, its libraries (libraryfolders.vdf), and the Flatpak's.
            let roots = [home.join(".local/share/Steam"), home.join(".steam/steam"), home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam")];
            let mut libraries: Vec<PathBuf> = roots.to_vec();
            for r in &roots {
                if let Ok(vdf) = std::fs::read_to_string(r.join("steamapps/libraryfolders.vdf")) {
                    for line in vdf.lines() {
                        let parts: Vec<&str> = line.split('"').collect();
                        if parts.len() >= 4 && parts[1] == "path" {
                            libraries.push(PathBuf::from(parts[3]));
                        }
                    }
                }
            }
            for l in libraries {
                out.push(l.join("steamapps/common/SteamVR/steamxr_linux64.json"));
            }
        }
        for dir in ["/usr/share/openxr/1", "/usr/local/share/openxr/1", "/etc/xdg/openxr/1"] {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().is_some_and(|x| x == "json") && !p.ends_with("active_runtime.json") {
                        out.push(p);
                    }
                }
            }
        }
    }
    out.retain(|p| p.exists());
    out
}

/// Whether SteamVR's server is running.
fn steamvr_running() -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq vrserver.exe", "/NH"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).to_ascii_lowercase().contains("vrserver.exe"))
    }
    #[cfg(not(windows))]
    {
        std::fs::read_dir("/proc").is_ok_and(|rd| rd.flatten().any(|e| std::fs::read_to_string(e.path().join("comm")).is_ok_and(|c| c.trim() == "vrserver")))
    }
}
