//! A stroke: the brush settings and the raw samples of the brush tip, as recorded.

use glam::Vec3;
use serde::{Deserialize, Serialize};

/// One sample of the brush tip: where it was, how hard it pressed (0..1), when (seconds), and
/// which way the pen's up side faced.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    pub pos: Vec3,
    pub pressure: f32,
    pub time: f64,
    /// The pen's up direction (unit). A tip that is not round is flattened along it, as a flat
    /// brush held like a pen: wide across, thin up and down. (Files from before roundness have
    /// none: straight up.)
    #[serde(default = "up", skip_serializing_if = "is_up")]
    pub up: Vec3,
}

fn up() -> Vec3 {
    Vec3::Y
}

fn is_up(v: &Vec3) -> bool {
    *v == Vec3::Y
}

impl Sample {
    /// A sample with the pen upright.
    pub fn new(pos: Vec3, pressure: f32, time: f64) -> Self {
        Self { pos, pressure, time, up: Vec3::Y }
    }
}

/// A brush of the 2D app: a trail of dabs. Strokes brought in from a .bdraw keep it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Dabs {
    /// Alpha of one dab (it builds up where dabs overlap).
    pub flow: f32,
    /// Distance between dabs, as a part of the diameter.
    pub spacing: f32,
    /// Pressure scales the flow.
    pub pressure_flow: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Brush {
    /// Radius at full pressure, meters.
    pub radius: f32,
    /// Linear RGB.
    pub color: [f32; 3],
    /// Pressure scales the radius, down to `min_ratio` of it at zero pressure.
    pub pressure_size: bool,
    pub min_ratio: f32,
    /// How much a ray through the middle of the stroke is covered: 1 is opaque.
    pub opacity: f32,
    /// Where the density starts to fall off, as a part of the radius: 1 is a hard edge, 0
    /// falls off from the center (an airbrush).
    pub hardness: f32,
    /// The tip's thickness along the pen's up direction, as a part of its width: 1 is round,
    /// lower is flatter (a flat brush, or a calligraphy nib).
    pub roundness: f32,
    /// Takes paint away from its layer.
    pub erase: bool,
    /// A 2D app brush (a stroke brought in from a .bdraw): its points are kept as they are, and
    /// pressure scales the radius (and maybe the flow) as the 2D app does.
    pub dabs: Option<Dabs>,
    /// Paint per pass (0.005..1, the 2D app's flow): below 1, a pass lays down less, and passes
    /// build up where they cross. (A stroke in an ordered layer: per dab, as in the 2D app.)
    pub flow: f32,
    /// Distance between dabs, as a part of the diameter (the 2D app's spacing): over about a
    /// third, a soft stroke shows its dabs.
    pub spacing: f32,
    /// Pressure scales the flow.
    pub pressure_flow: bool,
    /// Airbrush: while the pen holds still, paint keeps building up (a dab every 30 ms).
    pub buildup: bool,
    /// The 2D app's dynamics, per dab: the size made smaller by up to this part, the tip
    /// turned by up to this part of a turn either way, moved across the stroke by up to this
    /// many diameters, the paint made less by up to this part.
    pub size_jitter: f32,
    pub angle_jitter: f32,
    pub scatter: f32,
    pub flow_jitter: f32,
    /// The random numbers' seed for the dynamics (the 2D app's, from the stroke's id).
    pub seed: u32,
}

/// Random number in [0, 1) for dab `i`, channel `c` (size 0, flow 1, angle 2, scatter 3): the
/// 2D app's dabRandom (brush.ts), so a stroke brought in gets the same dynamics.
pub fn dab_random(seed: u32, i: u32, c: u32) -> f32 {
    let mut h = seed ^ (i + 1).wrapping_mul(0x9e37_79b1) ^ (c + 1).wrapping_mul(0x85eb_ca77);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    h as f32 / 4_294_967_296.0
}

/// The seed of a 2D app stroke's dynamics, from its id (brush.ts strokeSeed: FNV-1a).
pub fn stroke_seed(id: &str) -> u32 {
    let mut h: u32 = 2_166_136_261;
    for c in id.encode_utf16() {
        h ^= c as u32;
        h = h.wrapping_mul(16_777_619);
    }
    h
}

impl Default for Brush {
    fn default() -> Self {
        Self { radius: 0.01, color: [0.9, 0.3, 0.2], pressure_size: true, min_ratio: 0.2, opacity: 1.0, hardness: 1.0, roundness: 1.0, erase: false, dabs: None, flow: 1.0, spacing: 0.1, pressure_flow: false, buildup: false, size_jitter: 0.0, angle_jitter: 0.0, scatter: 0.0, flow_jitter: 0.0, seed: 0 }
    }
}

impl Brush {
    /// Any per-dab dynamics (jitter, scatter).
    pub fn jitters(&self) -> bool {
        self.size_jitter > 0.0 || self.angle_jitter > 0.0 || self.scatter > 0.0 || self.flow_jitter > 0.0
    }

    /// The 2D app's dabs of this brush: an imported stroke's own, else from its flow and
    /// spacing.
    pub fn dab_settings(&self) -> Dabs {
        self.dabs.unwrap_or(Dabs { flow: self.flow, spacing: self.spacing, pressure_flow: self.pressure_flow })
    }

    /// Opaque with a hard edge, and not an eraser: drawn as a surface. Else drawn as density
    /// stamps.
    pub fn solid(&self) -> bool {
        self.opacity >= 0.999 && self.hardness >= 0.999 && self.flow >= 0.999 && self.flow_jitter <= 0.0 && !self.erase && self.dabs.is_none()
    }

    /// The radius at a pressure. A 2D app brush scales it as the 2D app does (by the pressure,
    /// down to `min_ratio`); a VR brush maps the pressure onto `min_ratio..1`.
    pub fn radius_at(&self, pressure: f32) -> f32 {
        if !self.pressure_size {
            return self.radius;
        }
        let p = pressure.clamp(0.0, 1.0);
        if self.dabs.is_some() {
            self.radius * p.max(self.min_ratio)
        } else {
            self.radius * (self.min_ratio + (1.0 - self.min_ratio) * p)
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Stroke {
    pub brush: Brush,
    /// Raw samples, in time order. Filtering happens when segments are made, so the filter can
    /// change after the fact.
    pub samples: Vec<Sample>,
}

impl Stroke {
    pub fn new(brush: Brush) -> Self {
        Self { brush, samples: Vec::new() }
    }

    /// Adds a sample; one at the same time or earlier than the last is dropped.
    pub fn push(&mut self, s: Sample) {
        if self.samples.last().is_some_and(|l| s.time <= l.time) {
            return;
        }
        self.samples.push(s);
    }

    /// The stroke moved by `m` (a kaleidoscope's copy): its points, the pen's up side, and its
    /// size by m's scale (the cube root of its volume change). None when m flattens it.
    pub fn transformed(&self, m: &glam::Mat4) -> Option<Stroke> {
        let k = m.determinant().abs().cbrt();
        if !(k > 1e-6 && k.is_finite()) {
            return None;
        }
        let mut out = self.clone();
        out.brush.radius *= k;
        for p in &mut out.samples {
            p.pos = m.transform_point3(p.pos);
            p.up = m.transform_vector3(p.up).normalize_or(p.up);
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamics_random_is_the_2d_apps() {
        // Reference values from the 2D app's brush.ts (run in node).
        let s = stroke_seed("Kx3_9fGq2");
        assert_eq!(s, 3580383907);
        for (i, c, want) in [(0, 0, 0.8737553833052516), (7, 2, 0.4697074848227203), (123, 3, 0.10526934964582324)] {
            assert!((dab_random(s, i, c) as f64 - want).abs() < 1e-6, "{i} {c}");
        }
    }
}
