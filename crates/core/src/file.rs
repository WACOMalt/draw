//! Files: vdraw's own (.vdraw: gzip-compressed JSON of the painting), and the 2D app's
//! (.bdraw), brought in as 3D strokes on a wall.

use crate::painting::{Blend, Canvas, Layer, Painting, Plane};
use crate::segments::to_linear;
use crate::stroke::{Brush, Dabs, Sample, Stroke};
use anyhow::{Result, bail};
use glam::{Vec2, Vec3};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct VdrawFile {
    format: String,
    version: u32,
    painting: Painting,
}

const FORMAT: &str = "vdraw";
const VERSION: u32 = 1;

/// Reads gzip-compressed or plain bytes.
fn read_maybe_gzip(path: &Path) -> Result<Vec<u8>> {
    let raw = std::fs::read(path)?;
    if raw.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out)?;
        Ok(out)
    } else {
        Ok(raw)
    }
}

/// Saves the painting (written to a temporary file first, then renamed, so a crash while
/// saving keeps the last good file).
pub fn save(path: &Path, painting: &Painting) -> Result<()> {
    let file = VdrawFile { format: FORMAT.into(), version: VERSION, painting: painting.clone() };
    let json = serde_json::to_vec(&file)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("vdraw.tmp");
    let mut gz = flate2::write::GzEncoder::new(std::fs::File::create(&tmp)?, flate2::Compression::fast());
    gz.write_all(&json)?;
    gz.finish()?.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn load(path: &Path) -> Result<Painting> {
    let file: VdrawFile = serde_json::from_slice(&read_maybe_gzip(path)?)?;
    if file.format != FORMAT {
        bail!("{}: not a .vdraw file", path.display());
    }
    if file.version > VERSION {
        bail!("{}: version {} is newer than this vdraw reads ({VERSION})", path.display(), file.version);
    }
    Ok(file.painting)
}

/// Where the canvas of a .bdraw hangs: a wall in front of the viewer, its center at this point
/// (the viewer stands at the origin and looks toward -z), facing them.
pub const WALL_CENTER: Vec3 = Vec3::new(0.0, 1.45, -1.3);
/// The canvas's longer side, meters.
pub const WALL_SIZE: f32 = 1.1;

fn num(v: &Value, key: &str, default: f32) -> f32 {
    v.get(key).and_then(Value::as_f64).map_or(default, |x| x as f32)
}

fn flag(v: &Value, key: &str, default: bool) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn hex(s: &str) -> [f32; 3] {
    let s = s.trim_start_matches('#');
    let c = |i: usize| u8::from_str_radix(s.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f32 / 255.0;
    if s.len() >= 6 { [c(0), c(2), c(4)] } else { [0.0; 3] }
}

/// Brings in a .bdraw (the 2D app's canvas) as 3D strokes on a wall: every stroke keeps its
/// path and pressure and its 2D brush (flow, spacing, hardness, opacity, eraser), all its
/// points at one depth (the wall's plane), on the paper. Its layers are ordered (strokes cover
/// each other in their order, as in the 2D app). Seen square on with no perspective it matches
/// the 2D drawing; in perspective the round strokes show their thickness. The layers come in
/// order (groups that pass through flattened; a group's opacity multiplies its layers'), with
/// their blend modes. A layer goes on top for painting in VR. What it cannot carry yet: isolated
/// groups (drawn as if they passed through), layer masks, clipping, adjustment and shape
/// layers, and brush tip shapes (angle, roundness).
pub fn import_bdraw(path: &Path) -> Result<Painting> {
    let doc: Value = serde_json::from_slice(&read_maybe_gzip(path)?)?;
    if doc.get("format").and_then(Value::as_str) != Some("bdraw") {
        bail!("{}: not a .bdraw file", path.display());
    }
    let empty = Vec::new();
    let layers = doc.get("layers").and_then(Value::as_array).unwrap_or(&empty);
    let strokes = doc.get("strokes").and_then(Value::as_array).unwrap_or(&empty);

    // The layer order: top-level items by `order`, a group's children in its place by theirs.
    let live: Vec<&Value> = layers.iter().filter(|l| !flag(l, "deleted", false)).collect();
    let mut ordered: Vec<(String, f32, bool, Blend, String)> = Vec::new(); // id, opacity, visible, blend, name
    fn walk(live: &[&Value], under: Option<&str>, opacity: f32, visible: bool, out: &mut Vec<(String, f32, bool, Blend, String)>) {
        let mut items: Vec<&&Value> = live.iter().filter(|l| l.get("parent").and_then(Value::as_str) == under).collect();
        items.sort_by(|a, b| num(a, "order", 0.0).total_cmp(&num(b, "order", 0.0)));
        for l in items {
            let op = opacity * num(l, "opacity", 1.0);
            let vis = visible && flag(l, "visible", true);
            let lid = l.get("id").and_then(Value::as_str).unwrap_or("");
            match l.get("kind").and_then(Value::as_str) {
                Some("group") => walk(live, Some(lid), op, vis, out),
                Some("adjust") | Some("shape") => {}
                _ => {
                    let blend = Blend::from_name(l.get("blend").and_then(Value::as_str).unwrap_or("normal"));
                    let name = l.get("name").and_then(Value::as_str).unwrap_or("Layer").to_string();
                    out.push((lid.to_string(), op, vis, blend, name));
                }
            }
        }
    }
    walk(&live, None, 1.0, true, &mut ordered);

    // The canvas: the strokes' extent, with a margin, scaled to the wall.
    let mut lo = Vec2::splat(f32::MAX);
    let mut hi = Vec2::splat(f32::MIN);
    for s in strokes {
        let r = num(&s["brush"], "size", 1.0) * 0.5;
        if let Some(pts) = s.get("pts").and_then(Value::as_array) {
            for p in pts.chunks_exact(3) {
                let q = Vec2::new(p[0].as_f64().unwrap_or(0.0) as f32, p[1].as_f64().unwrap_or(0.0) as f32);
                lo = lo.min(q - r);
                hi = hi.max(q + r);
            }
        }
    }
    if lo.x > hi.x {
        lo = Vec2::ZERO;
        hi = Vec2::splat(1000.0);
    }
    let margin = (hi - lo).max_element() * 0.04;
    let (lo, hi) = (lo - margin, hi + margin);
    let scale = WALL_SIZE / (hi - lo).max_element(); // meters per 2D unit
    let center2d = (lo + hi) * 0.5;
    let plane = Plane { origin: WALL_CENTER, right: Vec3::X, up: Vec3::Y };
    // 2D y runs down; the wall's runs up.
    let to_wall = |x: f32, y: f32| plane.to_room(Vec2::new(x - center2d.x, center2d.y - y) * scale);
    let half = (hi - lo) * 0.5 * scale;
    let paper = doc.get("paper").and_then(|p| p.get("color")).and_then(Value::as_str).map(hex).unwrap_or([1.0, 1.0, 1.0]);
    let canvas = Canvas { plane, min: -half, max: half, paper: Some(paper) };

    let mut out: Vec<Layer> = ordered
        .iter()
        .map(|(_, opacity, visible, blend, name)| Layer { name: name.clone(), blend: *blend, opacity: *opacity, visible: *visible, ordered: true, strokes: Vec::new() })
        .collect();
    let index: std::collections::HashMap<&str, usize> = ordered.iter().enumerate().map(|(i, l)| (l.0.as_str(), i)).collect();
    let mut sorted: Vec<&Value> = strokes.iter().filter(|s| !flag(s, "deleted", false) && s.get("mask").is_none()).collect();
    sorted.sort_by(|a, b| num(a, "seq", 0.0).total_cmp(&num(b, "seq", 0.0)));
    for s in sorted {
        let Some(&li) = s.get("layerId").and_then(Value::as_str).and_then(|l| index.get(l)) else { continue };
        let b = &s["brush"];
        // The 2D brush comes along whole: the stamps' strengths follow its dabs (flow and
        // spacing), and its opacity caps each stroke (see stamp_strengths).
        let (flow, spacing, hardness) = (num(b, "flow", 1.0), num(b, "spacing", 0.1).max(0.005), num(b, "hardness", 0.8));
        let brush = Brush {
            radius: num(b, "size", 1.0) * 0.5 * scale,
            color: to_linear(hex(b.get("color").and_then(Value::as_str).unwrap_or("#000000"))),
            pressure_size: flag(b, "pressureSize", true),
            min_ratio: 0.02,
            opacity: num(b, "opacity", 1.0),
            hardness,
            erase: b.get("tool").and_then(Value::as_str) == Some("erase"),
            dabs: Some(Dabs { flow, spacing, pressure_flow: flag(b, "pressureFlow", false) }),
        };
        let mut stroke = Stroke::new(brush);
        if let Some(pts) = s.get("pts").and_then(Value::as_array) {
            for (i, p) in pts.chunks_exact(3).enumerate() {
                let f = |v: &Value| v.as_f64().unwrap_or(0.0) as f32;
                stroke.push(Sample { pos: to_wall(f(&p[0]), f(&p[1])), pressure: f(&p[2]), time: i as f64 });
            }
        }
        if !stroke.samples.is_empty() {
            out[li].strokes.push(stroke);
        }
    }
    out.push(Layer { name: "VR".into(), ..Default::default() });
    Ok(Painting { layers: out, canvas: Some(canvas), ..Default::default() })
}
