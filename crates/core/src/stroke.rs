//! A stroke: the brush settings and the raw samples of the brush tip, as recorded.

use glam::Vec3;
use serde::{Deserialize, Serialize};

/// One sample of the brush tip: where it was, how hard it pressed (0..1) and when (seconds).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    pub pos: Vec3,
    pub pressure: f32,
    pub time: f64,
}

/// A brush of the 2D app: a trail of dabs. Strokes brought in from a .bdraw keep it, and are
/// drawn as the 2D app draws them (on a flat layer).
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
    /// Takes paint away (on a flat layer, from the strokes before it).
    pub erase: bool,
    /// A 2D app brush.
    pub dabs: Option<Dabs>,
}

impl Default for Brush {
    fn default() -> Self {
        Self { radius: 0.01, color: [0.9, 0.3, 0.2], pressure_size: true, min_ratio: 0.2, opacity: 1.0, hardness: 1.0, erase: false, dabs: None }
    }
}

impl Brush {
    /// Opaque with a hard edge: drawn as a surface. Else drawn as density stamps.
    pub fn solid(&self) -> bool {
        self.opacity >= 0.999 && self.hardness >= 0.999
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
}
