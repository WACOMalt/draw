//! From samples to round cones: filter, resample by arc length, connect.

use crate::filter::OneEuro3;
use crate::stroke::{Brush, Stroke};
use bytemuck::{Pod, Zeroable};
use glam::Vec3;

/// One round cone, as the GPU reads it: four float4, so a port can also keep segments in a
/// float texture (four texels each). `a.w` and `b.w` are the radii; `color` is linear RGB and
/// the opacity; `style` is the hardness, the stroke number, and the strengths of the density
/// stamps at `a` (z) and at `b` (w, only on the last segment of a stroke). Segments of 2D app
/// strokes are tubes instead: z and w are their density per meter at `a` and `b` (see
/// `Stroke::tube_segments`).
///
/// A solid stroke is drawn as the round cones' surface. A soft stroke is a row of density
/// stamps, one at each resampled point: spheres whose density falls off from the center (the
/// brush falloff), all adding up, also where the stroke crosses itself.
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
            // An eraser's opacity is negative (it takes paint away).
            color: [c[0], c[1], c[2], brush.opacity.clamp(0.0, 1.0) * if brush.erase { -1.0 } else { 1.0 }],
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
    /// Bit 0: the stroke is soft (density stamps); bit 1: it is an eraser. 0: solid.
    pub flags: u32,
    /// The layer (the renderer's layer table), set by the renderer.
    pub layer: u32,
    /// The stroke number (as the segments' style.y).
    pub stroke: u32,
    pub pad: [u32; 3],
}

/// The chunks of `segs` (segments of a stroke are next to each other, in order).
pub fn chunks(segs: &[GpuSegment], out: &mut Vec<GpuChunk>) {
    out.clear();
    let mut i = 0;
    while i < segs.len() {
        let stroke = segs[i].style[1];
        let mut n = 1;
        // Up to CHUNK segments, and only while they stay within a few radii (long tube
        // segments would make wide chunks, which cull poorly).
        let (mut lo, mut hi) = (segs[i].a().min(segs[i].b()), segs[i].a().max(segs[i].b()));
        let mut r = segs[i].a[3].max(segs[i].b[3]);
        while n < CHUNK && i + n < segs.len() && segs[i + n].style[1] == stroke {
            let s = &segs[i + n];
            let (l, h) = (lo.min(s.a()).min(s.b()), hi.max(s.a()).max(s.b()));
            let rr = r.max(s.a[3]).max(s.b[3]);
            if (h - l).length() > 6.0 * rr {
                break;
            }
            (lo, hi, r) = (l, h, rr);
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
        let flags = !run[0].solid() as u32 | ((run[0].color[3] < 0.0) as u32) << 1;
        out.push(GpuChunk { sphere: [c.x, c.y, c.z, radius], first: i as u32, count: n as u32, flags, layer: 0, stroke: stroke as u32, pad: [0; 3] });
        i += n;
    }
}

/// The trail table: a tube's dabs along a ray. For a ray at distance q (radii) from a tube's
/// axis, the full-chord value integrated along the axis direction from the nearest point to v
/// (radii, scaled by the sine of the ray's angle to the axis): KH hardnesses x KQ distances x KV
/// lengths (0..1; past sqrt(1 - q^2) it stays the same), row by hardness, then distance.
pub const KH: usize = 17;
pub const KQ: usize = 33;
pub const KV: usize = 33;

/// The falloff integrated along a whole line through a stamp at distance q (radii).
pub fn chord_value(q: f32, hardness: f32) -> f32 {
    let half = (1.0 - q * q).max(0.0).sqrt();
    const N: usize = 128;
    let sum: f32 = (0..N).map(|i| {
        let y = half * (i as f32 + 0.5) / N as f32;
        falloff((q * q + y * y).sqrt(), hardness)
    }).sum();
    2.0 * sum * half / N as f32
}

pub fn trail_table() -> Vec<f32> {
    let mut out = Vec::with_capacity(KH * KQ * KV);
    for hi in 0..KH {
        let h = hi as f32 / (KH - 1) as f32;
        for qi in 0..KQ {
            let q = qi as f32 / (KQ - 1) as f32;
            // Integrate along v in fine steps, writing at each table step.
            const SUB: usize = 8;
            let dv = 1.0 / ((KV - 1) * SUB) as f32;
            let mut acc = 0.0;
            out.push(0.0);
            for vi in 1..KV {
                for s in 0..SUB {
                    let v = (((vi - 1) * SUB + s) as f32 + 0.5) * dv;
                    acc += chord_value((q * q + v * v).sqrt().min(1.0), h) * dv;
                }
                out.push(acc);
            }
        }
    }
    out
}

/// The full-chord table: the falloff integrated along a whole line through a stamp, at
/// distance q (radii) from its center, for CHORD_H hardnesses (0..1) x CHORD_Q distances (0..1),
/// row by hardness. A stamp's optical depth along a ray it crosses whole is its strength times
/// this.
pub const CHORD_Q: usize = 65;
pub const CHORD_H: usize = 17;

pub fn chord_table() -> Vec<f32> {
    let mut out = Vec::with_capacity(CHORD_Q * CHORD_H);
    for hi in 0..CHORD_H {
        let h = hi as f32 / (CHORD_H - 1) as f32;
        for qi in 0..CHORD_Q {
            let q = qi as f32 / (CHORD_Q - 1) as f32;
            let half = (1.0 - q * q).max(0.0).sqrt();
            const N: usize = 512;
            let sum: f32 = (0..N).map(|i| {
                let y = half * (i as f32 + 0.5) / N as f32;
                falloff((q * q + y * y).sqrt(), h)
            }).sum();
            out.push(2.0 * sum * half / N as f32);
        }
    }
    out
}

/// Chunks per cluster, at most.
pub const CLUSTER: usize = 16;

/// A run of up to `CLUSTER` consecutive chunks of one layer, in a sphere: the renderer's tiles
/// test clusters before chunks (so a tile's cost grows with the clusters, not every chunk).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuCluster {
    pub sphere: [f32; 4],
    pub first: u32,
    pub count: u32,
    pub pad: [u32; 2],
}

/// The clusters of `chunks` (appended to `out`; chunk numbers start at `base`).
pub fn clusters(chunks: &[GpuChunk], base: u32, out: &mut Vec<GpuCluster>) {
    let mut i = 0;
    while i < chunks.len() {
        let mut n = 1;
        while n < CLUSTER && i + n < chunks.len() && chunks[i + n].layer == chunks[i].layer {
            n += 1;
        }
        let run = &chunks[i..i + n];
        let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for c in run {
            let (p, r) = (Vec3::from_slice(&c.sphere[..3]), c.sphere[3]);
            lo = lo.min(p - r);
            hi = hi.max(p + r);
        }
        let center = (lo + hi) * 0.5;
        let radius = run.iter().map(|c| (Vec3::from_slice(&c.sphere[..3]) - center).length() + c.sphere[3]).fold(0.0, f32::max);
        out.push(GpuCluster { sphere: [center.x, center.y, center.z, radius], first: base + i as u32, count: n as u32, pad: [0; 2] });
        i += n;
    }
}

/// How far apart the resampled points are: a third of the radius (round cones then overlap
/// enough to look smooth), but at least 0.5 mm.
fn spacing(radius: f32) -> f32 {
    (radius * 0.35).max(0.0005)
}

/// The integral of the brush falloff over the plane through a stamp's center, in radii^2:
/// 2 pi times the integral of falloff(rho) * rho from 0 to 1, in closed form for the raised
/// cosine past `hardness`.
pub fn falloff_area(hardness: f32) -> f32 {
    let h = hardness.clamp(0.0, 1.0);
    let w = 1.0 - h;
    std::f32::consts::TAU * (h * h * 0.5 + (1.0 - h * h) * 0.25 - w * w / (std::f32::consts::PI * std::f32::consts::PI))
}

/// The brush falloff of the 2D app: 1 inside `hardness` of the radius, then a raised cosine
/// down to 0 at the edge. `u`: the distance from the center, in radii.
pub fn falloff(u: f32, hardness: f32) -> f32 {
    if u >= 1.0 {
        0.0
    } else if u <= hardness {
        1.0
    } else {
        0.5 + 0.5 * (std::f32::consts::PI * (u - hardness) / (1.0 - hardness).max(1e-6)).cos()
    }
}

/// The optical depth that `opacity` is through the middle of a stroke, seen from the side (at
/// most 98%, so a soft edge keeps a core that is not quite saturated).
fn depth_of(opacity: f32) -> f32 {
    -(1.0 - opacity.clamp(0.0, 0.98)).ln()
}

/// Stamp strengths for points `pts` (center, radius): scaled by the spacing around each, so a
/// straight stroke seen from the side is covered by `opacity` through its middle, whatever the
/// spacing. A stamp's optical depth along a ray is its strength times the line integral of the
/// falloff (in radii).
fn stamp_strengths(pts: &[(Vec3, f32)], brush: &Brush) -> Vec<f32> {
    let depth = depth_of(brush.opacity);
    if pts.len() == 1 {
        // One stamp: covered by `opacity` through its center (the line integral there is 1 +
        // hardness radii).
        return vec![depth / (1.0 + brush.hardness)];
    }
    let gap = |i: usize| (pts[i + 1].0 - pts[i].0).length();
    let area = falloff_area(brush.hardness);
    (0..pts.len())
        .map(|i| {
            // The spacing around this stamp: the mean of its gaps, or the one gap at an end.
            let spacing = match i {
                0 => gap(0),
                i if i == pts.len() - 1 => gap(i - 1),
                i => 0.5 * (gap(i - 1) + gap(i)),
            };
            depth * spacing / (pts[i].1 * area)
        })
        .collect()
}

/// Linear to sRGB (0..1).
pub fn to_srgb(c: [f32; 3]) -> [f32; 3] {
    c.map(|c| {
        let c = c.clamp(0.0, 1.0);
        if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
    })
}

/// sRGB (0..1) to linear.
pub fn to_linear(c: [f32; 3]) -> [f32; 3] {
    c.map(|c| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) })
}

impl Stroke {
    /// A 2D app stroke as tubes: its dabs spread evenly along each segment (the density per
    /// meter of trail, at a and b, in style.z and style.w), so a ray takes a segment's whole
    /// trail at once (the renderer integrates it from a table). Its points are kept as they are
    /// (they were smoothed in the 2D app), and merged into long segments where the path is
    /// smooth: a segment ends where the points stray from it by over a tenth of the radius (a
    /// corner, fine detail), where the radius or the flow changes by over 15%, or at six radii.
    /// A stroke of one point is one stamp: a == b, its strength in style.z.
    pub fn tube_segments(&self, id: u32, out: &mut Vec<GpuSegment>) {
        let brush = &self.brush;
        let Some(dabs) = brush.dabs else { return };
        let mut pts: Vec<(Vec3, f32)> = Vec::with_capacity(self.samples.len());
        for s in &self.samples {
            if pts.last().is_none_or(|&(p, _)| (s.pos - p).length() > 1e-4) {
                pts.push((s.pos, s.pressure));
            }
        }
        if pts.is_empty() {
            return;
        }
        // The dabs' sum through a trail's middle, flow x (1 + hardness) / (2 spacing) (the
        // brush's opacity caps the stroke where it is drawn, as in the 2D app); per meter of
        // trail, the density that sums to it. A brush whose pressure scales the flow: by the
        // pressure.
        let depth = dabs.flow * (1.0 + brush.hardness) / (2.0 * dabs.spacing.max(0.005));
        let area = falloff_area(brush.hardness);
        let flow = |q: f32| if dabs.pressure_flow { q.clamp(0.0, 1.0).max(0.02) } else { 1.0 };
        let density = |q: f32| depth * flow(q) / (brush.radius_at(q) * area);
        if pts.len() == 1 {
            let (p, q) = pts[0];
            let r = brush.radius_at(q);
            let mut seg = GpuSegment::new(p, r, p, r, brush, id);
            // One dab: covered by its flow through its center.
            seg.style[2] = -(1.0 - (dabs.flow * flow(q)).clamp(0.0, 0.999)).ln() / (1.0 + brush.hardness);
            out.push(seg);
            return;
        }
        let near = |a: f32, b: f32| a <= b * 1.15 && b <= a * 1.15;
        let mut i = 0;
        while i + 1 < pts.len() {
            let (a, qa) = pts[i];
            let (ra, da) = (brush.radius_at(qa), density(qa));
            let mut end = i + 1;
            for j in i + 2..pts.len() {
                let (b, qb) = pts[j];
                let rb = brush.radius_at(qb);
                if (b - a).length() > 6.0 * ra.min(rb) || !near(ra, rb) || !near(da, density(qb)) {
                    break;
                }
                let tol = (0.1 * ra.min(rb)).max(2e-4);
                let axis = (b - a).normalize_or_zero();
                let straight = pts[i + 1..j].iter().all(|&(p, q)| {
                    let d = p - a;
                    (d - axis * d.dot(axis)).length() <= tol && near(ra, brush.radius_at(q)) && near(da, density(q))
                });
                if !straight {
                    break;
                }
                end = j;
            }
            let (b, qb) = pts[end];
            let mut seg = GpuSegment::new(a, ra, b, brush.radius_at(qb), brush, id);
            seg.style[2] = da;
            seg.style[3] = density(qb);
            out.push(seg);
            i = end;
        }
    }

    /// The stroke's round cones, appended to `out`. A single sample is a sphere. `id`: the
    /// stroke's number in the painting (exact in an f32 up to 2^24).
    pub fn segments(&self, filter: OneEuro3, id: u32, out: &mut Vec<GpuSegment>) {
        let brush = &self.brush;
        if self.samples.is_empty() {
            return;
        }
        // Strokes from the 2D app (with its brush, `dabs`) are tubes.
        if brush.dabs.is_some() {
            self.tube_segments(id, out);
            return;
        }
        // 1. Filter the positions (the pressure stays raw).
        let mut f = filter;
        f.reset();
        let pts: Vec<(Vec3, f32)> = self.samples.iter().map(|s| (f.filter(s.time, s.pos), s.pressure)).collect();
        // 2. Resample by arc length, pressure interpolated. The step follows the radius at the
        //    last point, so thin parts of a stroke get points as close (in radii) as thick ones.
        let step_at = |q: f32| spacing(brush.radius_at(q));
        let mut res: Vec<(Vec3, f32)> = vec![pts[0]];
        let mut carry = 0.0f32; // length walked since the last resampled point
        for w in pts.windows(2) {
            let (p0, q0) = w[0];
            let (p1, q1) = w[1];
            let len = (p1 - p0).length();
            if len <= 0.0 {
                continue;
            }
            let mut at = 0.0; // along this piece
            loop {
                let need = step_at(res.last().unwrap().1) - carry;
                if at + need > len {
                    carry += len - at;
                    break;
                }
                at += need;
                carry = 0.0;
                let t = at / len;
                res.push((p0.lerp(p1, t), q0 + (q1 - q0) * t));
            }
        }
        let last = *pts.last().unwrap();
        if res.len() == 1 || (res.last().unwrap().0 - last.0).length() > step_at(last.1) * 0.25 {
            res.push(last);
        }
        // 3. Connect them, with the stamp strengths of a soft stroke.
        let centers: Vec<(Vec3, f32)> = res.iter().map(|&(p, q)| (p, brush.radius_at(q))).collect();
        let strengths = if brush.solid() { vec![0.0; centers.len()] } else { stamp_strengths(&centers, brush) };
        if centers.len() == 1 {
            let (p, r) = centers[0];
            let mut seg = GpuSegment::new(p, r, p, r, brush, id);
            seg.style[2] = strengths[0];
            out.push(seg);
            return;
        }
        for i in 0..centers.len() - 1 {
            let ((a, ra), (b, rb)) = (centers[i], centers[i + 1]);
            let mut seg = GpuSegment::new(a, ra, b, rb, brush, id);
            seg.style[2] = strengths[i];
            if i + 2 == centers.len() {
                seg.style[3] = strengths[i + 1];
            }
            out.push(seg);
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
    fn falloff_area_matches_a_numeric_integral() {
        for h in [0.0, 0.3, 0.8, 1.0] {
            let n = 20000;
            let num: f32 = (0..n).map(|i| {
                let u = (i as f32 + 0.5) / n as f32;
                falloff(u, h) * u / n as f32
            }).sum::<f32>() * std::f32::consts::TAU;
            assert!((num - falloff_area(h)).abs() < 1e-4, "{h}: {num} vs {}", falloff_area(h));
        }
    }

    #[test]
    fn a_soft_stroke_side_on_is_covered_by_its_opacity() {
        // A long straight soft stroke; a ray through its middle, square to it. The sum of the
        // stamps' line integrals through their centers' line, numerically.
        for (h, opacity) in [(0.0, 0.5), (0.6, 0.9), (0.95, 0.3)] {
            let brush = Brush { radius: 0.02, hardness: h, opacity, pressure_size: false, ..Default::default() };
            let mut s = Stroke::new(brush);
            for i in 0..=200 {
                s.push(Sample { pos: Vec3::new(i as f32 * 0.002, 0.0, 0.0), pressure: 1.0, time: i as f64 / 90.0 });
            }
            let mut out = Vec::new();
            s.segments(OneEuro3::new(1e6, 0.0, 1.0), 0, &mut out);
            assert!(out.iter().all(|g| g.style[2] > 0.0));
            // The ray: along y through (0.2, 0, 0). Stamp at x: distance q = |x - 0.2| / r.
            let line = |q: f32| -> f32 {
                let n = 400;
                let y1 = (1.0 - q * q).max(0.0).sqrt();
                (0..n).map(|i| {
                    let y = -y1 + 2.0 * y1 * (i as f32 + 0.5) / n as f32;
                    falloff((q * q + y * y).sqrt(), h) * 2.0 * y1 / n as f32
                }).sum()
            };
            let tau: f32 = out.iter().map(|g| g.style[2] * line((g.a[0] - 0.2).abs() / g.a[3])).sum();
            let covered = 1.0 - (-tau).exp();
            assert!((covered - opacity.min(0.98)).abs() < 0.02, "h {h}: covered {covered}, want {opacity}");
        }
    }

    #[test]
    fn a_2d_stroke_is_long_tubes_where_smooth_and_keeps_its_corners() {
        let dabs = crate::stroke::Dabs { flow: 0.5, spacing: 0.1, pressure_flow: false };
        let brush = Brush { radius: 0.01, pressure_size: false, hardness: 0.5, dabs: Some(dabs), ..Default::default() };
        // Straight, 100 points 1 mm apart: segments of about six radii.
        let mut s = Stroke::new(brush);
        for i in 0..100 {
            s.push(Sample { pos: Vec3::new(i as f32 * 0.001, 0.0, 0.0), pressure: 1.0, time: i as f64 });
        }
        let mut out = Vec::new();
        s.tube_segments(0, &mut out);
        assert!(out.len() <= 3, "{} segments", out.len());
        assert!(out.iter().all(|g| g.style[2] > 0.0 && g.style[3] == g.style[2]));
        // A zigzag with 4 mm teeth: every corner is an end.
        let mut z = Stroke::new(brush);
        for i in 0..=40 {
            let y = if (i / 4) % 2 == 0 { (i % 4) as f32 } else { 4.0 - (i % 4) as f32 };
            z.push(Sample { pos: Vec3::new(i as f32 * 0.001, y * 0.001, 0.0), pressure: 1.0, time: i as f64 });
        }
        out.clear();
        z.tube_segments(0, &mut out);
        assert_eq!(out.len(), 10);
        // One point: one stamp.
        let mut one = Stroke::new(brush);
        one.push(Sample { pos: Vec3::ZERO, pressure: 1.0, time: 0.0 });
        out.clear();
        one.tube_segments(0, &mut out);
        assert!(out.len() == 1 && out[0].a() == out[0].b());
    }

    #[test]
    fn the_trail_table_sums_a_tubes_dabs() {
        // The shader's tube integral (two trail lookups, nearest-sample here, on a fine
        // enough ray) against the dabs summed finely along the tube, for rays at angles.
        let tt = trail_table();
        let trail = |q: f32, v: f32, h: f32| {
            let at = |x: f32, n: usize| ((x * (n - 1) as f32).round() as usize).min(n - 1);
            let (hi, qi, vi) = (at(h, KH), at(q.clamp(0.0, 1.0), KQ), at(v.abs().min(1.0), KV));
            v.signum() * tt[(hi * KQ + qi) * KV + vi]
        };
        let (a, b, r, lam, h) = (Vec3::ZERO, Vec3::new(0.05, 0.0, 0.0), 0.01f32, 100.0f32, 0.5f32);
        for (o, dir) in [
            (Vec3::new(0.02, 0.0, 1.0), Vec3::NEG_Z),
            (Vec3::new(-0.3, 0.0, 0.3), Vec3::new(0.32, 0.0, -0.3).normalize()),
            (Vec3::new(0.025, -0.3, 0.3), Vec3::new(0.0, 0.3, -0.3).normalize()),
        ] {
            let len = (b - a).length();
            let u = (b - a) / len;
            let w0 = a - o;
            let ud = u.dot(dir);
            let s2 = 1.0 - ud * ud;
            let x0 = (ud * w0.dot(dir) - w0.dot(u)) / s2;
            let p = a + u * x0 - o;
            let q0 = (p - dir * p.dot(dir)).length() / r;
            let k = s2.sqrt() / r;
            let tube = lam / k * (trail(q0, (len - x0) * k, h) - trail(q0, -x0 * k, h));
            let n = 4000;
            let dx = len / n as f32;
            let dabs: f32 = (0..n)
                .map(|i| {
                    let c = a + u * ((i as f32 + 0.5) * dx) - o;
                    let q = (c - dir * c.dot(dir)).length() / r;
                    lam * dx * chord_value(q.min(1.0), h)
                })
                .sum();
            assert!((tube - dabs).abs() < 0.03 * dabs, "tube {tube} vs dabs {dabs}");
        }
    }

    #[test]
    fn spacing_follows_the_radius() {
        // Pressure 0.2 to 1: each step stays near 0.35 of the local radius.
        let mut s = Stroke::new(Brush { radius: 0.02, ..Default::default() });
        for i in 0..=100 {
            s.push(Sample { pos: Vec3::new(i as f32 * 0.003, 0.0, 0.0), pressure: i as f32 / 100.0, time: i as f64 / 90.0 });
        }
        let mut out = Vec::new();
        s.segments(OneEuro3::new(1e6, 0.0, 1.0), 0, &mut out);
        for g in &out[..out.len() - 1] {
            let ratio = (g.b() - g.a()).length() / g.a[3];
            assert!(ratio < 0.4, "step {ratio} radii");
        }
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
            assert!(run.iter().all(|s| s.style[1] == run[0].style[1] && s.solid() == (c.flags == 0)));
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
