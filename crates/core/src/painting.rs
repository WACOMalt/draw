//! A painting: layers of strokes, maybe a canvas on a wall, and what the renderer draws.
//!
//! Two kinds of layer:
//!   - Volume layers hold strokes painted in VR, in 3D. The renderer draws them as surfaces or
//!     density stamps, in depth order.
//!   - Flat layers lie on the painting's canvas, a plane (a canvas on a wall). Strokes brought
//!     in from the 2D app (.bdraw) go there, still as strokes. The renderer draws them on the
//!     plane as the 2D app does: each stroke a trail of dabs, the strokes in order (erasers
//!     included), then the layers in order with their blend modes, over the paper.

use crate::filter::OneEuro3;
use crate::segments::{GpuChunk, GpuSegment, chunks};
use crate::stroke::Stroke;
use bytemuck::{Pod, Zeroable};
use glam::{Vec2, Vec3};
use serde::{Deserialize, Serialize};

/// The 2D app's blend modes, in its order (the shader's mode numbers).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Blend {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
    Add,
}

impl Blend {
    /// From the 2D app's name ("color-burn"); unknown names (and "pass") are normal.
    pub fn from_name(name: &str) -> Self {
        serde_json::from_value(serde_json::Value::String(name.to_string())).unwrap_or_default()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Layer {
    pub name: String,
    pub blend: Blend,
    pub opacity: f32,
    pub visible: bool,
    /// On the painting's canvas (drawn as the 2D app draws), not in the volume.
    pub flat: bool,
    pub strokes: Vec<Stroke>,
}

impl Default for Layer {
    fn default() -> Self {
        Self { name: "Layer".into(), blend: Blend::Normal, opacity: 1.0, visible: true, flat: false, strokes: Vec::new() }
    }
}

/// A plane in the room: an origin and the unit directions of its x (right) and y (up).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Plane {
    pub origin: Vec3,
    pub right: Vec3,
    pub up: Vec3,
}

impl Plane {
    /// A room point's place on the plane (meters).
    pub fn to_plane(&self, p: Vec3) -> Vec2 {
        let d = p - self.origin;
        Vec2::new(d.dot(self.right), d.dot(self.up))
    }

    pub fn to_room(&self, p: Vec2) -> Vec3 {
        self.origin + self.right * p.x + self.up * p.y
    }
}

/// A canvas on a wall: the plane its flat layers lie on, the rectangle it covers (in plane
/// meters), and its paper.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Canvas {
    pub plane: Plane,
    pub min: Vec2,
    pub max: Vec2,
    /// The paper color (sRGB), or none (the room shows through).
    pub paper: Option<[f32; 3]>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Painting {
    /// Bottom to top.
    pub layers: Vec<Layer>,
    pub canvas: Option<Canvas>,
    /// The filter for every VR stroke's path.
    #[serde(skip)]
    pub filter: OneEuro3,
}

impl Default for Painting {
    fn default() -> Self {
        Self { layers: vec![Layer { name: "Layer 1".into(), ..Default::default() }], canvas: None, filter: OneEuro3::default() }
    }
}

/// Cells across each side of a flat layer's grid.
pub const GRID: u32 = 64;

/// A flat layer as the GPU reads it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuFlatLayer {
    pub blend: u32,
    pub opacity: f32,
    pub visible: u32,
    /// Where this layer's cells start in `FlatData::cells`.
    pub cell_base: u32,
}

/// The flat layers, ready for the GPU: their segments in plane coordinates (meters; z 0), the
/// chunks, and a grid over the canvas. Each cell lists the chunks that touch it, in stroke
/// order, as ranges in `items`: cell c of a layer is items[cells[base + c] .. cells[base + c + 1]].
#[derive(Clone, Debug, Default)]
pub struct FlatData {
    pub segments: Vec<GpuSegment>,
    pub chunks: Vec<GpuChunk>,
    pub layers: Vec<GpuFlatLayer>,
    pub cells: Vec<u32>,
    pub items: Vec<u32>,
}

impl Painting {
    /// A painting of one volume layer with these strokes.
    pub fn with_strokes(strokes: Vec<Stroke>) -> Self {
        let mut p = Self::default();
        p.layers[0].strokes = strokes;
        p
    }

    /// The layer new VR strokes go to: the top volume layer (made when there is none).
    pub fn active_layer(&mut self) -> usize {
        if let Some(i) = self.layers.iter().rposition(|l| !l.flat) {
            return i;
        }
        self.layers.push(Layer { name: "VR".into(), ..Default::default() });
        self.layers.len() - 1
    }

    /// The strokes of the active layer.
    pub fn active(&mut self) -> &mut Vec<Stroke> {
        let i = self.active_layer();
        &mut self.layers[i].strokes
    }

    /// The visible volume layers' strokes as round cones, in stroke order, with `active` (the
    /// stroke being drawn) last. Stroke numbers count on across layers.
    pub fn segments(&self, active: Option<&Stroke>, out: &mut Vec<GpuSegment>) {
        out.clear();
        let strokes = self.layers.iter().filter(|l| !l.flat && l.visible).flat_map(|l| &l.strokes);
        for (i, s) in strokes.chain(active).enumerate() {
            s.segments(self.filter, i as u32, out);
        }
    }

    /// The flat layers for the GPU. Empty without a canvas.
    pub fn flat(&self) -> FlatData {
        let mut data = FlatData::default();
        let Some(canvas) = self.canvas else { return data };
        let size = (canvas.max - canvas.min).max(Vec2::splat(1e-6));
        let cell = size / GRID as f32;
        let mut id = 0u32;
        for layer in self.layers.iter().filter(|l| l.flat) {
            let first_seg = data.segments.len();
            for s in &layer.strokes {
                s.flat_segments(&canvas.plane, id, &mut data.segments);
                id += 1;
            }
            let mut layer_chunks = Vec::new();
            chunks(&data.segments[first_seg..], &mut layer_chunks);
            let chunk_base = data.chunks.len() as u32;
            // Each chunk into the cells its circle touches, in order.
            let mut lists: Vec<Vec<u32>> = vec![Vec::new(); (GRID * GRID) as usize];
            for (i, c) in layer_chunks.iter_mut().enumerate() {
                c.first += first_seg as u32;
                let center = Vec2::new(c.sphere[0], c.sphere[1]);
                let r = c.sphere[3];
                let lo = ((center - r - canvas.min) / cell).floor().max(Vec2::ZERO);
                let hi = ((center + r - canvas.min) / cell).floor().min(Vec2::splat(GRID as f32 - 1.0));
                if lo.x > hi.x || lo.y > hi.y {
                    continue;
                }
                for y in lo.y as u32..=hi.y as u32 {
                    for x in lo.x as u32..=hi.x as u32 {
                        lists[(y * GRID + x) as usize].push(chunk_base + i as u32);
                    }
                }
            }
            data.chunks.extend(layer_chunks);
            let cell_base = data.cells.len() as u32;
            for list in &lists {
                data.cells.push(data.items.len() as u32);
                data.items.extend(list);
            }
            data.cells.push(data.items.len() as u32);
            data.layers.push(GpuFlatLayer { blend: layer.blend as u32, opacity: layer.opacity, visible: layer.visible as u32, cell_base });
        }
        data
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stroke::{Brush, Dabs, Sample};

    #[test]
    fn blend_names_are_the_2d_apps() {
        assert_eq!(Blend::from_name("color-burn"), Blend::ColorBurn);
        assert_eq!(Blend::from_name("add") as u32, 16);
        assert_eq!(Blend::from_name("pass"), Blend::Normal);
    }

    #[test]
    fn a_flat_stroke_is_listed_in_the_cells_it_crosses() {
        let plane = Plane { origin: Vec3::new(0.0, 1.0, -1.0), right: Vec3::X, up: Vec3::Y };
        let brush = Brush { radius: 0.01, dabs: Some(Dabs { flow: 0.5, spacing: 0.1, pressure_flow: false }), ..Default::default() };
        let mut stroke = Stroke::new(brush);
        for i in 0..=20 {
            stroke.push(Sample { pos: plane.to_room(Vec2::new(-0.4 + i as f32 * 0.04, 0.0)), pressure: 1.0, time: i as f64 });
        }
        let layer = Layer { flat: true, strokes: vec![stroke], ..Default::default() };
        let painting = Painting { layers: vec![layer], canvas: Some(Canvas { plane, min: Vec2::splat(-0.5), max: Vec2::splat(0.5), paper: None }), ..Default::default() };
        let flat = painting.flat();
        assert_eq!(flat.layers.len(), 1);
        assert_eq!(flat.cells.len(), (GRID * GRID + 1) as usize);
        // The cell at the stroke's middle (plane 0, 0) lists a chunk; one far above, none.
        let cell = |p: Vec2| {
            let c = ((p + 0.5) * GRID as f32).floor();
            (c.y as u32 * GRID + c.x as u32) as usize
        };
        let count = |c: usize| flat.cells[c + 1] - flat.cells[c];
        assert!(count(cell(Vec2::ZERO)) > 0);
        assert_eq!(count(cell(Vec2::new(0.0, 0.4))), 0);
        // Segments are on the plane, in plane meters.
        assert!(flat.segments.iter().all(|s| s.a[2] == 0.0 && s.a[1].abs() < 1e-5));
    }

    #[test]
    fn a_painting_saves_and_loads() {
        let mut p = Painting::with_strokes(vec![Stroke::new(Brush::default())]);
        p.active()[0].push(Sample { pos: Vec3::ONE, pressure: 0.5, time: 1.0 });
        p.layers[0].blend = Blend::Multiply;
        let path = std::env::temp_dir().join(format!("vdraw-test-{}.vdraw", std::process::id()));
        crate::file::save(&path, &p).unwrap();
        let back = crate::file::load(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(back.layers[0].blend, Blend::Multiply);
        assert_eq!(back.layers[0].strokes[0].samples[0].pos, Vec3::ONE);
    }
}
