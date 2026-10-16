//! Debug snapshots: what the headset showed (both eyes, the panel and all, as PNGs) and the
//! state behind it (the view, the hands, the tools, the layers, the GPU time, and the painting
//! itself), written to a folder under the painting's, so it can be looked at and measured. The
//! view can be drawn again offline: `vdraw --snapshot out.png --replay <folder>`.

use anyhow::{Context, Result};
use glam::{Mat4, Quat, Vec3};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A pose: where, and which way (a quaternion, x y z w).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Pose {
    pub pos: Vec3,
    pub rot: Quat,
}

impl Pose {
    pub fn of(m: Mat4) -> Self {
        let (_, rot, pos) = m.to_scale_rotation_translation();
        Self { pos, rot }
    }
}

/// One eye as drawn: its pose in the room (stage space) and in the painting, its field of
/// view (radians: left, right, up, down; left and down negative), and the world-to-clip matrix
/// the raymarcher used (Vulkan clip space, column-major).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Eye {
    pub stage: Pose,
    pub world: Pose,
    pub fov: [f32; 4],
    pub view_proj: Mat4,
}

/// A layer, in short.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LayerInfo {
    pub name: String,
    pub blend: vdraw_core::Blend,
    pub opacity: f32,
    pub visible: bool,
    pub ordered: bool,
    pub strokes: usize,
}

/// Everything about the moment, but the images and the painting (files beside it).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Info {
    /// Seconds since the Unix epoch.
    pub time: f64,
    pub runtime: String,
    /// Per eye, pixels.
    pub size: [u32; 2],
    pub eyes: Vec<Eye>,
    pub head: Pose,
    /// The aim poses of the left and the right hand (stage space), when tracked.
    pub hands: [Option<Pose>; 2],
    pub painting_hand: usize,
    /// Where the room is in the painting: the rig's position and turn (radians).
    pub rig_pos: Vec3,
    pub rig_yaw: f32,
    /// The tools' settings and what the hands are doing, as text.
    pub tools: String,
    pub panel_shown: bool,
    /// The last GPU time logged (ms per frame, both eyes), frames per second, and late frames.
    pub gpu_ms: f64,
    pub fps: f32,
    pub late: u32,
    pub segments: usize,
    pub layers: Vec<LayerInfo>,
    pub active_layer: usize,
    pub mix: vdraw_core::Mix,
    pub undo: usize,
    pub redo: usize,
}

/// A new folder for a snapshot, beside the painting: debug/<seconds since the epoch>.
pub fn folder(painting_path: Option<&Path>) -> PathBuf {
    let base = painting_path.and_then(Path::parent).map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    base.join("debug").join(format!("{:.0}", now()))
}

pub fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

/// Writes the snapshot: left.png and right.png (`pixels`: both eyes, one after the other, 8-bit
/// sRGB, BGRA when `bgra`), info.json and painting.vdraw.
pub fn write(dir: &Path, info: &Info, pixels: &[u8], bgra: bool, painting: &vdraw_core::Painting) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
    let [w, h] = info.size;
    let eye_bytes = (w * h * 4) as usize;
    for (i, name) in ["left.png", "right.png"].into_iter().enumerate() {
        let mut rgba = pixels[i * eye_bytes..(i + 1) * eye_bytes].to_vec();
        for px in rgba.chunks_exact_mut(4) {
            if bgra {
                px.swap(0, 2);
            }
            px[3] = 255;
        }
        let file = std::fs::File::create(dir.join(name))?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header()?.write_image_data(&rgba)?;
    }
    std::fs::write(dir.join("info.json"), serde_json::to_vec_pretty(info)?)?;
    vdraw_core::file::save(&dir.join("painting.vdraw"), painting)?;
    Ok(())
}

/// A snapshot folder read back: its info, and its painting.
pub fn read(dir: &Path) -> Result<(Info, vdraw_core::Painting)> {
    let info: Info = serde_json::from_slice(&std::fs::read(dir.join("info.json")).with_context(|| format!("{}: no info.json", dir.display()))?)?;
    let painting = vdraw_core::file::load(&dir.join("painting.vdraw"))?;
    Ok((info, painting))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A snapshot of the demo, seen from 1.1 m in front of it, as VR would write it.
    pub fn sample(dir: &Path) -> Info {
        let (w, h) = (64u32, 48u32);
        let proj = crate::camera::perspective_fov(-0.8, 0.8, 0.7, -0.7, 0.02, 100.0);
        let eye_at = |x: f32| {
            let pose = Mat4::from_translation(Vec3::new(x, 1.3, 1.1));
            Eye { stage: Pose::of(pose), world: Pose::of(pose), fov: [-0.8, 0.8, 0.7, -0.7], view_proj: proj * pose.inverse() }
        };
        let info = Info {
            time: now(),
            runtime: "test".into(),
            size: [w, h],
            eyes: vec![eye_at(-0.032), eye_at(0.032)],
            head: Pose::of(Mat4::from_translation(Vec3::new(0.0, 1.3, 1.1))),
            hands: [None, Some(Pose::of(Mat4::IDENTITY))],
            painting_hand: 1,
            rig_pos: Vec3::ZERO,
            rig_yaw: 0.0,
            tools: format!("{:#?}", crate::tools::Tools::default()),
            panel_shown: true,
            gpu_ms: 1.5,
            fps: 144.0,
            late: 0,
            segments: 0,
            layers: Vec::new(),
            active_layer: 0,
            mix: vdraw_core::Mix::Normal,
            undo: 0,
            redo: 0,
        };
        let pixels: Vec<u8> = (0..2 * w * h * 4).map(|i| (i % 251) as u8).collect();
        write(dir, &info, &pixels, true, &crate::demo::painting()).unwrap();
        info
    }

    #[test]
    fn a_snapshot_reads_back() {
        let dir = std::env::temp_dir().join(format!("vdraw-debug-{}", std::process::id()));
        let info = sample(&dir);
        let (back, painting) = read(&dir).unwrap();
        assert_eq!(back.size, info.size);
        assert!(back.eyes[1].view_proj.abs_diff_eq(info.eyes[1].view_proj, 1e-6));
        assert_eq!(painting.layers[0].strokes.len(), crate::demo::painting().layers[0].strokes.len());
        // The images: the size asked for, BGRA turned to RGBA.
        let decoder = png::Decoder::new(std::fs::File::open(dir.join("right.png")).unwrap());
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut buf).unwrap();
        assert_eq!((frame.width, frame.height), (64, 48));
        let first = (64 * 48 * 4) % 251; // the right eye's first byte
        assert_eq!(buf[0] as usize, (first + 2) % 251);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
