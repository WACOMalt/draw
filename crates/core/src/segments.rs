//! From samples to round cones: filter, resample by arc length, connect.

use crate::filter::OneEuro3;
use crate::stroke::{Brush, Stroke};
use bytemuck::{Pod, Zeroable};
use glam::Vec3;

/// One round cone, as the GPU reads it: four float4, so a port can also keep segments in a
/// float texture (four texels each). `a.w` and `b.w` are the radii; `color` is linear RGB and
/// the opacity; `style` is the hardness and the stroke number (segments of one stroke do not
/// add up where they overlap).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuSegment {
    pub a: [f32; 4],
    pub b: [f32; 4],
    pub color: [f32; 4],
    pub style: [f32; 4],
}

impl GpuSegment {
    pub fn new(a: Vec3, ra: f32, b: Vec3, rb: f32, brush: &Brush, stroke: u32) -> Self {
        let c = brush.color;
        Self {
            a: [a.x, a.y, a.z, ra],
            b: [b.x, b.y, b.z, rb],
            color: [c[0], c[1], c[2], brush.opacity.clamp(0.0, 1.0)],
            style: [brush.hardness.clamp(0.0, 1.0), stroke as f32, 0.0, 0.0],
        }
    }

    /// Opaque with a hard edge: drawn as a surface. Else drawn as a volume.
    pub fn solid(&self) -> bool {
        self.color[3] >= 0.999 && self.style[0] >= 0.999
    }

    pub fn a(&self) -> Vec3 {
        Vec3::new(self.a[0], self.a[1], self.a[2])
    }

    pub fn b(&self) -> Vec3 {
        Vec3::new(self.b[0], self.b[1], self.b[2])
    }
}

/// Segments per chunk, at most.
pub const CHUNK: usize = 4;

/// A run of up to `CHUNK` consecutive segments of one stroke, with a sphere around them all.
/// The renderer culls chunks first, and looks at the segments of a chunk only when a ray
/// crosses its sphere.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuChunk {
    /// Center xyz, radius w.
    pub sphere: [f32; 4],
    pub first: u32,
    pub count: u32,
    /// 1 when the stroke is soft (drawn as a layer), 0 when solid.
    pub soft: u32,
    pub pad: u32,
}

/// The chunks of `segs` (segments of a stroke are next to each other, in order).
pub fn chunks(segs: &[GpuSegment], out: &mut Vec<GpuChunk>) {
    out.clear();
    let mut i = 0;
    while i < segs.len() {
        let stroke = segs[i].style[1];
        let mut n = 1;
        while n < CHUNK && i + n < segs.len() && segs[i + n].style[1] == stroke {
            n += 1;
        }
        let run = &segs[i..i + n];
        let ends = || run.iter().flat_map(|s| [(s.a(), s.a[3]), (s.b(), s.b[3])]);
        let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for (p, r) in ends() {
            lo = lo.min(p - r);
            hi = hi.max(p + r);
        }
        let c = (lo + hi) * 0.5;
        let radius = ends().map(|(p, r)| (p - c).length() + r).fold(0.0, f32::max);
        out.push(GpuChunk { sphere: [c.x, c.y, c.z, radius], first: i as u32, count: n as u32, soft: !run[0].solid() as u32, pad: 0 });
        i += n;
    }
}

/// How far apart the resampled points are: a third of the radius (round cones then overlap
/// enough to look smooth), but at least 0.5 mm.
fn spacing(radius: f32) -> f32 {
    (radius * 0.35).max(0.0005)
}

impl Stroke {
    /// The stroke's round cones, appended to `out`. A single sample is a sphere. `id`: the
    /// stroke's number in the painting (exact in an f32 up to 2^24).
    pub fn segments(&self, filter: OneEuro3, id: u32, out: &mut Vec<GpuSegment>) {
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
            out.push(GpuSegment::new(p, r, p, r, brush, id));
            return;
        }
        for w in res.windows(2) {
            out.push(GpuSegment::new(w[0].0, brush.radius_at(w[0].1), w[1].0, brush.radius_at(w[1].1), brush, id));
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
        s.segments(OneEuro3::new(1e6, 0.0, 1.0), 0, &mut out);
        let step = spacing(0.01);
        for seg in &out[..out.len() - 1] {
            assert!(((seg.b() - seg.a()).length() - step).abs() < 1e-4);
        }
        assert!((out.last().unwrap().b().x - 0.1).abs() < 1e-5);
    }

    #[test]
    fn chunks_hold_their_segments() {
        let mut out = Vec::new();
        for id in 0..3u32 {
            let mut s = Stroke::new(Brush { hardness: if id == 1 { 0.0 } else { 1.0 }, ..Default::default() });
            for i in 0..=40 {
                let t = i as f32 / 40.0;
                s.push(Sample { pos: Vec3::new(t.cos(), t * 0.3, (t * 3.0).sin()) * 0.4, pressure: t, time: i as f64 / 90.0 });
            }
            s.segments(OneEuro3::default(), id, &mut out);
        }
        let mut ch = Vec::new();
        chunks(&out, &mut ch);
        let mut next = 0;
        for c in &ch {
            assert_eq!(c.first, next);
            assert!(c.count as usize <= CHUNK);
            let run = &out[c.first as usize..(c.first + c.count) as usize];
            assert!(run.iter().all(|s| s.style[1] == run[0].style[1] && s.solid() == (c.soft == 0)));
            let center = Vec3::from_slice(&c.sphere[..3]);
            for s in run {
                assert!((s.a() - center).length() + s.a[3] <= c.sphere[3] + 1e-5);
                assert!((s.b() - center).length() + s.b[3] <= c.sphere[3] + 1e-5);
            }
            next += c.count;
        }
        assert_eq!(next as usize, out.len());
    }

    #[test]
    fn one_sample_is_a_sphere() {
        let mut s = Stroke::new(Brush::default());
        s.push(Sample { pos: Vec3::ONE, pressure: 1.0, time: 0.0 });
        let mut out = Vec::new();
        s.segments(OneEuro3::default(), 0, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].a(), out[0].b());
    }
}
