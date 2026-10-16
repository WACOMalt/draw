//! A stroke: the brush settings and the raw samples of the brush tip, as recorded.

use glam::Vec3;

/// One sample of the brush tip: where it was, how hard it pressed (0..1) and when (seconds).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub pos: Vec3,
    pub pressure: f32,
    pub time: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Brush {
    /// Radius at full pressure, meters.
    pub radius: f32,
    /// Linear RGB.
    pub color: [f32; 3],
    /// Pressure scales the radius, down to `min_ratio` of it at zero pressure.
    pub pressure_size: bool,
    pub min_ratio: f32,
}

impl Default for Brush {
    fn default() -> Self {
        Self { radius: 0.01, color: [0.9, 0.3, 0.2], pressure_size: true, min_ratio: 0.2 }
    }
}

impl Brush {
    /// The radius at a pressure.
    pub fn radius_at(&self, pressure: f32) -> f32 {
        if !self.pressure_size {
            return self.radius;
        }
        let p = pressure.clamp(0.0, 1.0);
        self.radius * (self.min_ratio + (1.0 - self.min_ratio) * p)
    }
}

#[derive(Clone, Debug, Default)]
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
