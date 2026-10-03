// The desktop app is the web client in a native window. It talks to https://draw.bsums.xyz
// (set at build time by .env.tauri). The dialog and fs plugins back "Export PNG".
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running the Draw app");
}
