// The desktop app is the web client in a native window. It talks to https://draw.bsums.xyz
// (set at build time by .env.tauri). The dialog and fs plugins back saving files (PNG, .bdraw).
//
// Opening a .bdraw file from the file manager starts the app with the path as an argument
// (Windows, Linux) or sends RunEvent::Opened (macOS). The page asks for those paths and reads
// them through the two commands below, which only read files the system opened the app with.

use std::{collections::HashSet, path::PathBuf, sync::Mutex};

#[derive(Default)]
struct Opened {
    /** Paths the page has not taken yet. */
    pending: Mutex<Vec<PathBuf>>,
    /** Every path the system opened the app with: the only files read_opened_file reads. */
    allowed: Mutex<HashSet<PathBuf>>,
}

impl Opened {
    fn add(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let mut pending = self.pending.lock().unwrap();
        let mut allowed = self.allowed.lock().unwrap();
        for path in paths {
            if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("bdraw")) {
                allowed.insert(path.clone());
                pending.push(path);
            }
        }
    }
}

#[tauri::command]
fn take_opened_files(state: tauri::State<Opened>) -> Vec<String> {
    state.pending.lock().unwrap().drain(..).map(|p| p.to_string_lossy().into_owned()).collect()
}

#[tauri::command]
fn read_opened_file(path: String, state: tauri::State<Opened>) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    if !state.allowed.lock().unwrap().contains(&path) {
        return Err("not a file the app was opened with".into());
    }
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// The .deb and .rpm packages install the .bdraw MIME type for the whole system. An AppImage
/// cannot, and Gear Lever does not do it on install, so the AppImage registers the type for
/// the current user (~/.local/share/mime), the same way AppImageLauncher would. Without it,
/// file managers see a .bdraw file as plain gzip and do not offer Draw.
#[cfg(target_os = "linux")]
fn register_mime_for_appimage() {
    use std::process::{Command, Stdio};
    const XML: &str = include_str!("../mime/xyz.bsums.draw.xml");
    if std::env::var_os("APPIMAGE").is_none() {
        return;
    }
    let data_home = match std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => match std::env::var_os("HOME") {
            Some(home) => PathBuf::from(home).join(".local/share"),
            None => return,
        },
    };
    let mime_dir = data_home.join("mime");
    let file = mime_dir.join("packages/xyz.bsums.draw.xml");
    // Check the built cache, not only our XML: a failed rebuild then repairs itself next start.
    let in_cache = std::fs::read_to_string(mime_dir.join("globs2")).is_ok_and(|g| g.contains(":application/x-bdraw:"));
    if in_cache && std::fs::read_to_string(&file).is_ok_and(|old| old == XML) {
        return; // already registered
    }
    if std::fs::create_dir_all(mime_dir.join("packages")).and_then(|_| std::fs::write(&file, XML)).is_err() {
        return;
    }
    // Rebuild the user's MIME cache, and the desktop-file cache so the MimeType line counts.
    // These are the system's tools: run them without the AppImage's environment. Its
    // LD_LIBRARY_PATH points at the bundled (older) GLib, and the system tool then fails with
    // "undefined symbol: g_string_free_and_steal".
    let quiet = |cmd: &str, dir: PathBuf| {
        let mut c = Command::new(cmd);
        c.env_clear().arg(dir).stdout(Stdio::null()).stderr(Stdio::null());
        for key in ["PATH", "HOME"] {
            if let Some(v) = std::env::var_os(key) {
                c.env(key, v);
            }
        }
        match c.status() {
            Ok(st) if st.success() => {}
            other => eprintln!("draw: {cmd} failed: {other:?}"),
        }
    };
    quiet("update-mime-database", mime_dir);
    quiet("update-desktop-database", data_home.join("applications"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    std::thread::spawn(register_mime_for_appimage);
    let opened = Opened::default();
    opened.add(std::env::args_os().skip(1).map(PathBuf::from));
    tauri::Builder::default()
        .manage(opened)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![take_opened_files, read_opened_file])
        .build(tauri::generate_context!())
        .expect("error while building the Draw app")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                use tauri::{Emitter, Manager};
                _app.state::<Opened>().add(urls.into_iter().filter_map(|u| u.to_file_path().ok()));
                let _ = _app.emit("opened-files", ());
            }
        });
}
