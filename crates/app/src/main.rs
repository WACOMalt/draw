//! vdraw: volumetric painting. Strokes are round cones, raymarched exactly (no voxels).
//!
//!   vdraw                       paint in a desktop window (mouse)
//!   vdraw --xr                  paint in VR (OpenXR: SteamVR, Monado, WiVRn)
//!   vdraw --snapshot out.png    render the demo painting to a PNG (no window, no headset)

mod camera;
mod demo;
mod snapshot;

use anyhow::Result;

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--snapshot") => {
            let path = args.get(1).map(String::as_str).unwrap_or("snapshot.png");
            snapshot::run(path, 1280, 800)
        }
        _ => anyhow::bail!("usage: vdraw --snapshot out.png"),
    }
}
