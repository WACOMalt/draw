//! vdraw: volumetric painting. Strokes are round cones, raymarched exactly (no voxels).
//!
//!   vdraw                       paint in a desktop window (mouse)
//!   vdraw --xr [--demo ...]     paint in VR (OpenXR: SteamVR, Monado, WiVRn)
//!   vdraw --snapshot out.png [--demo shapes|soft|compare|dense|overlap] [--orbit x y z yaw pitch distance]
//!                               [--tip opacity hardness] [--size WxH] [--bench N] [--panel]
//!                               render a demo painting to a PNG (no window, no headset)

mod camera;
mod demo;
mod panel;
mod rig;
mod snapshot;
mod xr;

use anyhow::{Context, Result};

/// The painting of `--demo shapes|soft|compare|dense|overlap` (shapes when not given), and a camera for it.
fn demo(args: &[String]) -> Result<(vdraw_core::Painting, camera::Orbit)> {
    let name = args.iter().position(|a| a == "--demo").and_then(|i| args.get(i + 1)).map(String::as_str);
    Ok(match name.unwrap_or("shapes") {
        "shapes" => (demo::painting(), camera::Orbit::default()),
        "soft" => (demo::soft(), camera::Orbit::default()),
        "compare" => (demo::compare(), camera::Orbit { target: glam::Vec3::new(0.0, 1.22, 0.0), yaw: 0.0, pitch: 0.05, distance: 1.25 }),
        "dense" => (demo::dense(), camera::Orbit { target: glam::Vec3::new(0.0, 1.3, 0.0), yaw: 0.3, pitch: 0.1, distance: 0.9 }),
        "overlap" => (demo::overlap(), camera::Orbit { target: glam::Vec3::new(0.0, 1.3, 0.0), yaw: 0.0, pitch: 0.0, distance: 1.1 }),
        other => anyhow::bail!("no demo {other:?}: shapes, soft, compare, dense or overlap"),
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
            // --tip opacity hardness: draw the brush tip at the orbit target.
            let tip = match args.iter().position(|a| a == "--tip") {
                Some(i) => {
                    let v: Vec<f32> = args[i + 1..].iter().take(2).map(|s| s.parse()).collect::<Result<_, _>>()?;
                    anyhow::ensure!(v.len() == 2, "--tip needs opacity hardness");
                    Some(vdraw_render::BrushTip { pos: cam.target, radius: 0.05, color: [0.2, 0.6, 0.95], opacity: v[0], hardness: v[1] })
                }
                None => None,
            };
            // --size WxH (1280x800), --bench N: time N renders on the GPU first.
            let size = match args.iter().position(|a| a == "--size").and_then(|i| args.get(i + 1)) {
                Some(s) => {
                    let (w, h) = s.split_once('x').context("--size WxH")?;
                    (w.parse()?, h.parse()?)
                }
                None => (1280, 800),
            };
            let bench = match args.iter().position(|a| a == "--bench").and_then(|i| args.get(i + 1)) {
                Some(n) => n.parse()?,
                None => 0,
            };
            snapshot::run(path, size.0, size.1, painting, cam, tip, bench, args.iter().any(|a| a == "--panel"))
        }
        Some("--xr") => xr::run(demo(&args)?.0),
        _ => anyhow::bail!("usage: vdraw --xr | vdraw --snapshot out.png"),
    }
}
