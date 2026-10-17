//! Files: vdraw's own (.vdraw: gzip-compressed JSON of the painting), and the 2D app's
//! (.bdraw), brought in as 3D strokes on a wall.

use crate::doc::{Doc, DocLayer, DocStroke, Frame, Paper};
use crate::painting::{Layer, Painting};
use anyhow::{Result, bail};
use glam::Vec3;
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
    let mut painting = file.painting;
    painting.normalize();
    Ok(painting)
}

/// Where the strokes of a .bdraw go: on a vertical plane in front of the viewer, centered at
/// this point (the viewer stands at the origin and looks toward -z).
pub const WALL_CENTER: Vec3 = Vec3::new(0.0, 1.45, -1.3);
/// The drawing's longer side, meters.
pub const WALL_SIZE: f32 = 1.1;

/// Brings in a .bdraw (the 2D app's canvas) as 3D strokes on a wall: every stroke keeps its
/// path and pressure and its 2D brush (flow, spacing, hardness, opacity, eraser, the tip's
/// roundness and angle), all its points at one depth (a vertical plane in front of the
/// viewer). No paper. Its layers are ordered (strokes cover each other in their order, as in
/// the 2D app). Seen square on with no perspective it matches the 2D drawing; in perspective the
/// strokes show their thickness. The layers come as they are: their order, groups (passing
/// through or isolated), blend modes, opacity, visibility, clipping and masks, and the canvas's
/// paint mixing. A layer goes on top for painting in VR. What it cannot carry yet: adjustment
/// and shape layers, layer effects, brush tips other than round (square, chalk, ...), and
/// grain.
pub fn import_bdraw(path: &Path) -> Result<Painting> {
    let doc = read_bdraw(&read_maybe_gzip(path)?).map_err(|e| anyhow::anyhow!("{}: {e:#}", path.display()))?;
    // The drawing's extent, with a margin, fits the wall.
    let b = doc.bounds().unwrap_or([0.0, 0.0, 1000.0, 1000.0]);
    let margin = (b[2] - b[0]).max(b[3] - b[1]) * 0.04;
    let side = (b[2] - b[0]).max(b[3] - b[1]) + 2.0 * margin;
    let frame = Frame { anchor: [(b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5], k: WALL_SIZE as f64 / side.max(1e-30), offset: WALL_CENTER };
    let mut painting = doc.painting(&frame).painting;
    let id = painting.layers.iter().map(|l| l.id).max().unwrap_or(0) + 1;
    painting.layers.push(Layer { id, name: "VR".into(), ..Default::default() });
    painting.normalize();
    Ok(painting)
}

/// A .bdraw file's document (its layers, strokes, shapes, paper and paint mixing).
pub fn read_bdraw(bytes: &[u8]) -> Result<Doc> {
    #[derive(Deserialize)]
    struct File {
        format: String,
        #[serde(default)]
        layers: Vec<DocLayer>,
        #[serde(default)]
        strokes: Vec<DocStroke>,
        #[serde(default)]
        shapes: Vec<Value>,
        #[serde(default)]
        paper: Option<Paper>,
        #[serde(default)]
        mix: Option<String>,
    }
    let f: File = serde_json::from_slice(bytes)?;
    if f.format != "bdraw" {
        bail!("not a .bdraw file");
    }
    Ok(Doc::from_parts(f.layers, f.strokes, f.shapes, f.paper, f.mix))
}
