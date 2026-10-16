//! From samples to round cones: filter, resample by arc length, connect.

use crate::filter::OneEuro3;
use crate::stroke::Stroke;
use bytemuck::{Pod, Zeroable};
use glam::Vec3;

/// One round cone, as the GPU reads it: three float4, so a port can also keep segments in a
/// float texture (three texels each). `a.w` and `b.w` are the radii; `color` is linear RGB and
/// alpha (1 for now).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuSegment {
    pub a: [f32; 4],
    pub b: [f32; 4],
    pub color: [f32; 4],
}

impl GpuSegment {
    pub fn new(a: Vec3, ra: f32, b: Vec3, rb: f32, color: [f32; 3]) -> Self {
        Self { a: [a.x, a.y, a.z, ra], b: [b.x, b.y, b.z, rb], color: [color[0], color[1], color[2], 1.0] }
    }

    pub fn a(&self) -> Vec3 {
        Vec3::new(self.a[0], self.a[1], self.a[2])
    }

    pub fn b(&self) -> Vec3 {
        Vec3::new(self.b[0], self.b[1], self.b[2])
    }
}

/// How far apart the resampled points are: a third of the radius (round cones then overlap
/// enough to look smooth), but at least 0.5 mm.
fn spacing(radius: f32) -> f32 {
    (radius * 0.35).max(0.0005)
}

impl Stroke {
    /// The stroke's round cones, appended to `out`. A single sample is a sphere.
    pub fn segments(&self, filter: OneEuro3, out: &mut Vec<GpuSegment>) {
        let brush = &self.brush;
        if self.samples.is_empty() {
            return;
        }
        // 1. Filter the positions (the pressure stays raw).
        let mut f = filter;
        f.reset();
        let pts: Vec<(Vec3, f32)> = self.samples.iter().map(|s| (f.filter(s.time, s.pos), s.pressure)).collect();
        // 2. Resample by arc length, pressure interpolated.
        let step = spacing(brush.radius);
        let mut res: Vec<(Vec3, f32)> = vec![pts[0]];
        let mut carry = 0.0f32; // length walked since the last resampled point
        for w in pts.windows(2) {
            let (p0, q0) = w[0];
            let (p1, q1) = w[1];
            let len = (p1 - p0).length();
            if len <= 0.0 {
                continue;
            }
            let mut d = step - carry;
            while d <= len {
                let t = d / len;
                res.push((p0.lerp(p1, t), q0 + (q1 - q0) * t));
                d += step;
            }
            carry = len - (d - step);
        }
        let last = *pts.last().unwrap();
        if res.len() == 1 || (res.last().unwrap().0 - last.0).length() > step * 0.25 {
            res.push(last);
        }
        // 3. Connect them.
        if res.len() == 1 {
            let (p, q) = res[0];
            let r = brush.radius_at(q);
            out.push(GpuSegment::new(p, r, p, r, brush.color));
            return;
        }
        for w in res.windows(2) {
            out.push(GpuSegment::new(w[0].0, brush.radius_at(w[0].1), w[1].0, brush.radius_at(w[1].1), brush.color));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stroke::{Brush, Sample};

    #[test]
    fn straight_line_is_evenly_resampled() {
        let mut s = Stroke::new(Brush { radius: 0.01, pressure_size: false, ..Default::default() });
        for i in 0..=10 {
            s.push(Sample { pos: Vec3::new(i as f32 * 0.01, 0.0, 0.0), pressure: 1.0, time: i as f64 / 90.0 });
        }
        let mut out = Vec::new();
        // No smoothing: a very high cutoff.
        s.segments(OneEuro3::new(1e6, 0.0, 1.0), &mut out);
        let step = spacing(0.01);
        for seg in &out[..out.len() - 1] {
            assert!(((seg.b() - seg.a()).length() - step).abs() < 1e-4);
        }
        assert!((out.last().unwrap().b().x - 0.1).abs() < 1e-5);
    }

    #[test]
    fn one_sample_is_a_sphere() {
        let mut s = Stroke::new(Brush::default());
        s.push(Sample { pos: Vec3::ONE, pressure: 1.0, time: 0.0 });
        let mut out = Vec::new();
        s.segments(OneEuro3::default(), &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].a(), out[0].b());
    }
}
