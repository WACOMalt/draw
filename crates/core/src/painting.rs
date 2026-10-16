//! A painting: its strokes, and the segment list the renderer draws.

use crate::filter::OneEuro3;
use crate::segments::GpuSegment;
use crate::stroke::Stroke;

#[derive(Clone, Debug, Default)]
pub struct Painting {
    pub strokes: Vec<Stroke>,
    /// The filter for every stroke's path.
    pub filter: OneEuro3,
}

impl Painting {
    /// All strokes as round cones, in stroke order (`active`, the stroke being drawn, last).
    pub fn segments(&self, active: Option<&Stroke>, out: &mut Vec<GpuSegment>) {
        out.clear();
        for s in self.strokes.iter().chain(active) {
            s.segments(self.filter, out);
        }
    }
}
