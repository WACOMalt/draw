// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// The AppImage carries WebKitGTK and GTK from Ubuntu 22.04, the build machine. With the NVIDIA
/// driver, that build renders far slower than the distribution's own WebKitGTK on the same PC
/// (measured: the web process at ~99% CPU against ~35%, and a 5x slower redraw). So when the
/// system has WebKitGTK 4.1, the AppImage restarts itself once with the system libraries first.
/// The bundled libraries still fill any gap. DRAW_SYSTEM_WEBKIT=0 keeps the bundled ones.
/// If the system copy cannot even load (a WebKitGTK older than our build needs), the app goes
/// on with the bundled libraries, so it always opens.
#[cfg(target_os = "linux")]
fn prefer_system_webkit() {
    use std::{os::unix::process::CommandExt, path::Path};
    // Not an AppImage, already restarted (marker "1"), or turned off ("0").
    let Some(appdir) = std::env::var_os("APPDIR") else { return };
    if std::env::var_os("APPIMAGE").is_none() || std::env::var_os("DRAW_SYSTEM_WEBKIT").is_some() {
        return;
    }
    let Some(lib_dir) = ["/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib"]
        .into_iter()
        .find(|d| Path::new(d).join("libwebkit2gtk-4.1.so.0").exists())
    else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else { return };
    let appdir = appdir.to_string_lossy().into_owned();
    let bundled = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
    // The launcher put the AppImage's share folder first; its GSettings schemas are older than
    // the system GTK expects, and GLib aborts on a missing key. Keep only the system folders.
    let data_dirs: Vec<String> = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty() && !d.starts_with(&appdir))
        .map(str::to_owned)
        .collect();

    let mut cmd = std::process::Command::new(exe);
    cmd.args(std::env::args_os().skip(1))
        .env("LD_LIBRARY_PATH", format!("{lib_dir}:{bundled}"))
        .env("XDG_DATA_DIRS", if data_dirs.is_empty() { "/usr/local/share:/usr/share".into() } else { data_dirs.join(":") })
        .env("DRAW_SYSTEM_WEBKIT", "1");
    // If this waiting parent is killed, the app goes with it.
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    // These point GTK, GIO and GdkPixbuf at the bundled modules, built for the bundled versions.
    for key in [
        "GTK_PATH",
        "GTK_EXE_PREFIX",
        "GTK_DATA_PREFIX",
        "GTK_IM_MODULE_FILE",
        "GIO_MODULE_DIR",
        "GDK_PIXBUF_MODULE_FILE",
        "GSETTINGS_SCHEMA_DIR",
        "GI_TYPELIB_PATH",
    ] {
        cmd.env_remove(key);
    }
    // Wait for the restarted app and exit with its status. The dynamic loader exits with 127
    // when a library or symbol is missing: then go on here with the bundled libraries.
    match cmd.status() {
        Ok(status) if status.code() == Some(127) => {
            eprintln!("draw: the system WebKitGTK does not fit this build; using the bundled one");
        }
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(err) => eprintln!("draw: could not start with the system WebKitGTK ({err}); using the bundled one"),
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    prefer_system_webkit();
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
