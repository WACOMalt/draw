//! vdraw: volumetric painting. Strokes are round cones, raymarched exactly (no voxels).
//!
//!   vdraw                       paint in a desktop window (mouse)
//!   vdraw --xr [--demo ...]     paint in VR (OpenXR: SteamVR, Monado, WiVRn)
//!   vdraw --snapshot out.png [--demo shapes|soft|compare] [--orbit x y z yaw pitch distance]
//!                               render a demo painting to a PNG (no window, no headset)

mod camera;
mod demo;
mod snapshot;
mod xr;

use anyhow::Result;

/// The painting of `--demo shapes|soft|compare` (shapes when not given), and a camera for it.
fn demo(args: &[String]) -> Result<(vdraw_core::Painting, camera::Orbit)> {
    let name = args.iter().position(|a| a == "--demo").and_then(|i| args.get(i + 1)).map(String::as_str);
    Ok(match name.unwrap_or("shapes") {
        "shapes" => (demo::painting(), camera::Orbit::default()),
        "soft" => (demo::soft(), camera::Orbit::default()),
        "compare" => (demo::compare(), camera::Orbit { target: glam::Vec3::new(0.0, 1.22, 0.0), yaw: 0.0, pitch: 0.05, distance: 1.25 }),
        other => anyhow::bail!("no demo {other:?}: shapes, soft or compare"),
    })
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--snapshot") => {
            let path = args.get(1).map(String::as_str).unwrap_or("snapshot.png");
            let (painting, cam) = demo(&args)?;
            // --orbit x y z yaw pitch distance: look at (x, y, z) from another place.
            let cam = match args.iter().position(|a| a == "--orbit") {
                Some(i) => {
                    let v: Vec<f32> = args[i + 1..].iter().take(6).map(|s| s.parse()).collect::<Result<_, _>>()?;
                    anyhow::ensure!(v.len() == 6, "--orbit needs x y z yaw pitch distance");
                    camera::Orbit { target: glam::Vec3::new(v[0], v[1], v[2]), yaw: v[3], pitch: v[4], distance: v[5] }
                }
                None => cam,
            };
            snapshot::run(path, 1280, 800, painting, cam)
        }
        Some("--xr") => xr::run(demo(&args)?.0),
        _ => anyhow::bail!("usage: vdraw --xr | vdraw --snapshot out.png"),
    }
}
