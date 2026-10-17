//! vdraw: volumetric painting. Strokes are round cones, raymarched exactly (no voxels).
//!
//!   vdraw                       paint in a desktop window (mouse)
//!   vdraw --xr [--open file.vdraw | --demo ...]
//!                               paint in VR (OpenXR: SteamVR, Monado, WiVRn); opens and saves
//!                               ~/.local/share/vdraw/painting.vdraw unless told otherwise
//!   vdraw --import in.bdraw [out.vdraw]
//!                               bring a 2D app canvas in, as 3D strokes on a plane ahead
//!   vdraw --snapshot out.png [--demo shapes|soft|compare|dense|overlap|flat|mix|near|layers|brushes] [--orbit x y z yaw pitch distance]
//!                               [--tip opacity hardness] [--size WxH] [--bench N] [--mix normal|pigment]
//!                               [--panel [brush|eraser|stroke-eraser|color|palettes|layers|settings]] [--sweep radius] [--replay folder [right]]
//!                               render a painting to a PNG (no window, no headset); --replay:
//!                               a debug snapshot's painting from its left (or right) eye
//!                               render a demo painting to a PNG (no window, no headset)

mod camera;
mod canvas;
mod debug;
mod demo;
mod lobby;
mod painter;
mod palettes;
mod presets;
mod panel;
mod rig;
mod snapshot;
mod tools;
mod xr;

use anyhow::{Context, Result};

/// The painting of `--demo shapes|soft|compare|dense|overlap|flat|mix|near|layers|brushes` (shapes when not given), and a camera for it.
fn demo(args: &[String]) -> Result<(vdraw_core::Painting, camera::Orbit)> {
    // --open file.vdraw: a saved painting, seen from where the viewer starts, toward its middle.
    if let Some(path) = args.iter().position(|a| a == "--open").and_then(|i| args.get(i + 1)) {
        let painting = vdraw_core::file::load(std::path::Path::new(path))?;
        let target = painting.bounds().map_or(glam::Vec3::new(0.0, 1.3, -1.0), |(lo, hi)| (lo + hi) * 0.5);
        let cam = camera::Orbit { target, yaw: 0.0, pitch: 0.0, distance: target.z.abs().max(0.5) };
        return Ok((painting, cam));
    }
    let name = args.iter().position(|a| a == "--demo").and_then(|i| args.get(i + 1)).map(String::as_str);
    Ok(match name.unwrap_or("shapes") {
        "shapes" => (demo::painting(), camera::Orbit::default()),
        "soft" => (demo::soft(), camera::Orbit::default()),
        "compare" => (demo::compare(), camera::Orbit { target: glam::Vec3::new(0.0, 1.22, 0.0), yaw: 0.0, pitch: 0.05, distance: 1.25 }),
        "dense" => (demo::dense(), camera::Orbit { target: glam::Vec3::new(0.0, 1.3, 0.0), yaw: 0.3, pitch: 0.1, distance: 0.9 }),
        "overlap" => (demo::overlap(), camera::Orbit { target: glam::Vec3::new(0.0, 1.3, 0.0), yaw: 0.0, pitch: 0.0, distance: 1.1 }),
        "flat" => (demo::flat(), camera::Orbit { target: glam::Vec3::new(0.0, 1.35, 0.0), yaw: 0.0, pitch: 0.0, distance: 1.0 }),
        "near" => (demo::near(), camera::Orbit { target: glam::Vec3::new(0.0, 1.3, 0.0), yaw: 0.0, pitch: 0.0, distance: 1.1 }),
        "layers" => (demo::layers(), camera::Orbit { target: glam::Vec3::new(0.0, 1.33, 0.0), yaw: 0.0, pitch: 0.0, distance: 1.0 }),
        "brushes" => (demo::brushes(), camera::Orbit { target: glam::Vec3::new(0.0, 1.38, 0.0), yaw: 0.0, pitch: 0.0, distance: 0.9 }),
        "mix" => (demo::mix(), camera::Orbit { target: glam::Vec3::new(0.0, 1.35, 0.0), yaw: 0.0, pitch: 0.0, distance: 0.9 }),
        other => anyhow::bail!("no demo {other:?}: shapes, soft, compare, dense, overlap, flat, mix, near, layers or brushes"),
    })
}

/// The painting `vdraw --xr` opens and saves: $XDG_DATA_HOME/vdraw/painting.vdraw (or
/// ~/.local/share/vdraw/painting.vdraw).
fn painting_path() -> std::path::PathBuf {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".local/share")))
        .unwrap_or_else(|| ".".into());
    data.join("vdraw/painting.vdraw")
}

/// `--import in.bdraw [out.vdraw]`: brings a 2D app canvas in as 3D strokes on a plane ahead.
fn import(args: &[String]) -> Result<()> {
    let from = args.get(1).context("usage: vdraw --import in.bdraw [out.vdraw]")?;
    let to = args.get(2).map(std::path::PathBuf::from).unwrap_or_else(painting_path);
    let painting = vdraw_core::file::import_bdraw(std::path::Path::new(from))?;
    for l in &painting.layers {
        log::info!("layer {:?}: {} strokes, {:?}, opacity {:.2}{}", l.name, l.strokes.len(), l.blend, l.opacity, if l.visible { "" } else { ", hidden" });
    }
    let mut segs = Vec::new();
    painting.build(&mut segs);
    log::info!("{} segments", segs.len());
    vdraw_core::file::save(&to, &painting)?;
    log::info!("saved {}", to.display());
    Ok(())
}

/// A shared canvas's painting and place, as VR opens it: joined as a guest, the document
/// waited for (10 s at most).
fn canvas_snapshot(server: &str, input: &str) -> Result<(vdraw_core::Painting, snapshot::CanvasView)> {
    let srv = vdraw_net::Server::new(server, None);
    let (key, link) = srv.resolve(input)?.with_context(|| format!("no canvas {input:?} on {server}"))?;
    let id = vdraw_net::identity::Identity::default();
    let session = vdraw_net::session::Session::open(&srv, &key, "vdraw snapshot", &id.color, &id.anon, link.as_deref());
    let mut c = canvas::Canvas::new(session);
    let mut painter = painter::Painter::new(vdraw_core::Painting::default());
    let head = glam::Mat4::from_translation(glam::Vec3::new(0.0, 1.6, 0.0));
    let t0 = std::time::Instant::now();
    loop {
        if c.update(&mut painter, head) && !c.rebuilding() && c.placed {
            log::info!("the document into a painting: {:.1} ms after joining", t0.elapsed().as_secs_f64() * 1e3);
            break;
        }
        anyhow::ensure!(t0.elapsed().as_secs() < 10, "{key}: no document after 10 s ({:?})", c.session.state);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    log::info!("{key}: {} layers, {} strokes; frame {:?}", c.session.doc.layers.len(), c.session.doc.strokes.len(), c.frame);
    c.session.close();
    Ok((painter.painting.clone(), snapshot::CanvasView { world_from_scene: c.view, paper: c.paper, grid: 0.0 }))
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--snapshot") => {
            let path = args.get(1).map(String::as_str).unwrap_or("snapshot.png");
            let (mut painting, cam) = demo(&args)?;
            // --mix normal|pigment: the painting's paint mixing.
            if let Some(m) = args.iter().position(|a| a == "--mix").and_then(|i| args.get(i + 1)) {
                painting.mix = match m.as_str() {
                    "normal" => vdraw_core::Mix::Normal,
                    "pigment" => vdraw_core::Mix::Pigment,
                    _ => anyhow::bail!("--mix normal|pigment"),
                };
            }
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
                    Some(vdraw_render::BrushTip { pos: cam.target, radius: 0.05, color: [0.2, 0.6, 0.95], opacity: v[0], hardness: v[1], up: glam::Vec3::Y, roundness: 1.0 })
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
            // --panel [tool]: the tool panel beside the view; --sweep r: the stroke eraser's
            // overlay, its ball (radius r) at the orbit target.
            let panel = args.iter().position(|a| a == "--panel").map(|i| match args.get(i + 1).map(String::as_str) {
                Some("eraser") => (tools::Tool::Eraser, panel::Tab::Tool),
                Some("stroke-eraser") => (tools::Tool::StrokeEraser, panel::Tab::Tool),
                Some("color") => (tools::Tool::Brush, panel::Tab::Color),
                Some("palettes") => (tools::Tool::Brush, panel::Tab::Color),
                Some("layers") => (tools::Tool::Brush, panel::Tab::Layers),
                Some("settings") => (tools::Tool::Brush, panel::Tab::Settings),
                _ => (tools::Tool::Brush, panel::Tab::Tool),
            });
            let sweep = match args.iter().position(|a| a == "--sweep").and_then(|i| args.get(i + 1)) {
                Some(r) => Some(r.parse()?),
                None => None,
            };
            // --replay folder [right]: a debug snapshot's painting, from its eye, at its size.
            if let Some(dir) = args.iter().position(|a| a == "--replay").and_then(|i| args.get(i + 1)) {
                let (info, painting) = debug::read(std::path::Path::new(dir))?;
                let i = if args.iter().any(|a| a == "right") { 1 } else { 0 };
                let e = &info.eyes[i];
                let eye = vdraw_render::EyeView { view_proj: e.view_proj, pos: e.world.pos };
                let size = args.iter().any(|a| a == "--size").then_some(size).unwrap_or((info.size[0], info.size[1]));
                log::info!("replay: {} eye, {}x{}; it took {:.2} ms per frame (both eyes) in VR", ["left", "right"][i], size.0, size.1, info.gpu_ms);
                return snapshot::run(path, size.0, size.1, painting, snapshot::View::Eye(eye), tip, bench, None, None, None);
            }
            // --canvas KEY [--server URL] [--grid]: a shared canvas, as VR opens it (in front of
            // a head at 1.6 m looking ahead), seen from the orbit camera (by default: the head).
            if let Some(key) = args.iter().position(|a| a == "--canvas").and_then(|i| args.get(i + 1)) {
                let server = args.iter().position(|a| a == "--server").and_then(|i| args.get(i + 1)).map_or(vdraw_net::identity::DEFAULT_SERVER, String::as_str);
                let (painting, view) = canvas_snapshot(server, key)?;
                let cam = if args.iter().any(|a| a == "--orbit") { cam } else { camera::Orbit { target: glam::Vec3::new(0.0, 1.6, -1.3), yaw: 0.0, pitch: 0.0, distance: 1.3 } };
                let view = snapshot::CanvasView { grid: if args.iter().any(|a| a == "--grid") { 1.0 } else { 0.0 }, ..view };
                return snapshot::run(path, size.0, size.1, painting, snapshot::View::Orbit(cam), tip, bench, panel, sweep, Some(view));
            }
            snapshot::run(path, size.0, size.1, painting, snapshot::View::Orbit(cam), tip, bench, panel, sweep, None)
        }
        Some("--import") => import(&args),
        Some("--xr") => {
            // --demo X or --open file: paint on this device at once (a demo is not saved).
            // --canvas KEY: open a shared canvas at once. Else the start screen. --server URL:
            // the 2D app's server (the one you last used when not given).
            let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
            let start = if args.iter().any(|a| a == "--demo") {
                xr::Start::Local(demo(&args)?.0, None)
            } else if let Some(path) = arg("--open").map(std::path::PathBuf::from) {
                let painting = if path.exists() { vdraw_core::file::load(&path)? } else { demo::painting() };
                xr::Start::Local(painting, Some(path))
            } else if let Some(key) = arg("--canvas") {
                xr::Start::Canvas(key)
            } else {
                xr::Start::Home
            };
            xr::run(start, arg("--server"))
        }
        _ => anyhow::bail!("usage: vdraw --xr | vdraw --snapshot out.png"),
    }
}
