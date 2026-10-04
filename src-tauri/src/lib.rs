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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
