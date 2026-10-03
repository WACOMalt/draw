// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // NVIDIA's explicit sync on Wayland crashes WebKitGTK's DMA-BUF renderer
    // ("Error 71 (Protocol error) dispatching to Wayland display"). Turning off explicit sync
    // keeps the fast DMA-BUF path; disabling DMA-BUF instead delays every frame by one.
    // Has no effect on other GPUs. Users can still override both variables.
    #[cfg(target_os = "linux")]
    if std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
    draw_lib::run()
}
