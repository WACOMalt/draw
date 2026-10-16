//! Distance functions, the same as `shaders/sdf.slang` (keep both in step). The CPU uses them
//! for picking and erasing, and the tests check the shapes.

use glam::Vec3;

/// Signed distance from `p` to a round cone: the hull of a sphere at `a` (radius `ra`) and a
/// sphere at `b` (radius `rb`). Exact (Inigo Quilez, "distance functions"). When one sphere
/// holds the other, the shape is the larger sphere.
pub fn round_cone(p: Vec3, a: Vec3, ra: f32, b: Vec3, rb: f32) -> f32 {
    let ba = b - a;
    let l2 = ba.dot(ba);
    let rr = ra - rb;
    if rr * rr >= l2 {
        // One sphere inside the other (also a == b).
        return if ra >= rb { (p - a).length() - ra } else { (p - b).length() - rb };
    }
    let a2 = l2 - rr * rr;
    let il2 = 1.0 / l2;
    let pa = p - a;
    let y = pa.dot(ba);
    let z = y - l2;
    let w = pa * l2 - ba * y;
    let x2 = w.dot(w);
    let y2 = y * y * l2;
    let z2 = z * z * l2;
    let k = rr.signum() * rr * rr * x2;
    if z.signum() * a2 * z2 > k {
        return (x2 + z2).sqrt() * il2 - rb;
    }
    if y.signum() * a2 * y2 < k {
        return (x2 + y2).sqrt() * il2 - ra;
    }
    ((x2 * a2 * il2).sqrt() + y * rr) * il2 - ra
}

/// Where a ray (from `o`, unit `dir`) first enters a sphere, at `t >= 0` along it, and the
/// normal there. None when it misses, or starts inside.
pub fn ray_sphere(o: Vec3, dir: Vec3, c: Vec3, r: f32) -> Option<(f32, Vec3)> {
    let oc = o - c;
    let b = oc.dot(dir);
    let h = b * b - (oc.dot(oc) - r * r);
    if h < 0.0 {
        return None;
    }
    let t = -b - h.sqrt();
    (t >= 0.0).then(|| (t, (oc + dir * t) / r))
}

/// Where a ray (from `o`, unit `dir`) first enters a round cone, at `t >= 0` along it, and the
/// normal there. Exact (Inigo Quilez, "rounded cone intersection"): the cone's side when the
/// hit is between the two spheres, else the nearer sphere. None when it misses, or starts
/// inside.
pub fn ray_round_cone(o: Vec3, dir: Vec3, a: Vec3, ra: f32, b: Vec3, rb: f32) -> Option<(f32, Vec3)> {
    let ba = b - a;
    let m0 = ba.dot(ba);
    let rr = ra - rb;
    if rr * rr >= m0 {
        // One sphere inside the other (also a == b).
        return if ra >= rb { ray_sphere(o, dir, a, ra) } else { ray_sphere(o, dir, b, rb) };
    }
    let oa = o - a;
    let m1 = ba.dot(oa);
    let m2 = ba.dot(dir);
    let m3 = dir.dot(oa);
    let m5 = oa.dot(oa);
    // The side: a quadratic in t.
    let d2 = m0 - rr * rr;
    let k2 = d2 - m2 * m2;
    let k1 = d2 * m3 - m1 * m2 + m2 * rr * ra;
    let k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2.0 - m0 * ra * ra;
    let h = k1 * k1 - k0 * k2;
    if h < 0.0 {
        return None;
    }
    let t = (-h.sqrt() - k1) / k2;
    let y = m1 - ra * rr + t * m2;
    if y > 0.0 && y < d2 {
        return (t >= 0.0).then(|| (t, (d2 * (oa + dir * t) - ba * y).normalize()));
    }
    // The ends: the first entry of either sphere.
    match (ray_sphere(o, dir, a, ra), ray_sphere(o, dir, b, rb)) {
        (Some(x), Some(y)) => Some(if x.0 <= y.0 { x } else { y }),
        (x, y) => x.or(y),
    }
}

/// A vector in a flat tip's round space: stretched along its flat axis `up` (unit) by
/// 1 / `roundness`, where the tip is round again (`stretch` in shaders/sdf.slang).
pub fn stretch(up: Vec3, roundness: f32, v: Vec3) -> Vec3 {
    v + up * ((1.0 / roundness - 1.0) * up.dot(v))
}

/// Where a ray (from `o`, unit `dir`) first enters a segment whose tip is flattened along
/// `up` to `roundness` of its radius: the round cone in the round space (`raySegment` in
/// shaders/sdf.slang).
#[allow(clippy::too_many_arguments)]
pub fn ray_flat_cone(o: Vec3, dir: Vec3, a: Vec3, ra: f32, b: Vec3, rb: f32, up: Vec3, roundness: f32) -> Option<(f32, Vec3)> {
    if roundness >= 0.999 {
        return ray_round_cone(o, dir, a, ra, b, rb);
    }
    let s = |v| stretch(up, roundness, v);
    let d = s(dir);
    let scale = d.length();
    let (t, n) = ray_round_cone(s(o - a), d / scale, Vec3::ZERO, ra, s(b - a), rb)?;
    Some((t / scale, s(n).normalize()))
}

/// How far `p` is from a segment with a flat tip, about: the distance in the round space,
/// which is at most the true one (and at least `roundness` times it).
#[allow(clippy::too_many_arguments)]
pub fn flat_cone(p: Vec3, a: Vec3, ra: f32, b: Vec3, rb: f32, up: Vec3, roundness: f32) -> f32 {
    if roundness >= 0.999 {
        return round_cone(p, a, ra, b, rb);
    }
    let s = |v| stretch(up, roundness, v);
    round_cone(s(p - a), Vec3::ZERO, ra, s(b - a), rb) * roundness
}

/// The distance between two segments, p0..p1 and q0..q1 (either may be a point).
pub fn segment_distance(p0: Vec3, p1: Vec3, q0: Vec3, q1: Vec3) -> f32 {
    let (d1, d2, r) = (p1 - p0, q1 - q0, p0 - q0);
    let (a, e, f) = (d1.dot(d1), d2.dot(d2), d2.dot(r));
    let (s, t) = if a <= 1e-12 && e <= 1e-12 {
        (0.0, 0.0)
    } else if a <= 1e-12 {
        (0.0, (f / e).clamp(0.0, 1.0))
    } else {
        let c = d1.dot(r);
        if e <= 1e-12 {
            ((-c / a).clamp(0.0, 1.0), 0.0)
        } else {
            // The closest points of the two lines, held to the segments (Ericson, "Real-Time
            // Collision Detection", 5.1.9).
            let b = d1.dot(d2);
            let den = a * e - b * b;
            let mut s = if den > 1e-12 { ((b * f - c * e) / den).clamp(0.0, 1.0) } else { 0.0 };
            let mut t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            }
            (s, t)
        }
    };
    ((p0 + d1 * s) - (q0 + d2 * t)).length()
}

/// Smooth minimum (polynomial, Inigo Quilez): blends two distances over `k`.
pub fn smin(a: f32, b: f32, k: f32) -> f32 {
    if k <= 0.0 {
        return a.min(b);
    }
    let h = (k - (a - b).abs()).max(0.0) / k;
    a.min(b) - h * h * k * 0.25
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sphere_ends() {
        let a = Vec3::ZERO;
        let b = Vec3::new(1.0, 0.0, 0.0);
        // Beyond each end, the distance is to that end's sphere.
        assert!((round_cone(Vec3::new(-1.0, 0.0, 0.0), a, 0.2, b, 0.1) - 0.8).abs() < 1e-5);
        assert!((round_cone(Vec3::new(2.0, 0.0, 0.0), a, 0.2, b, 0.1) - 0.9).abs() < 1e-5);
    }

    #[test]
    fn capsule_side() {
        // Equal radii: a capsule; beside the middle, the distance is to the side.
        let d = round_cone(Vec3::new(0.5, 1.0, 0.0), Vec3::ZERO, 0.1, Vec3::X, 0.1);
        assert!((d - 0.9).abs() < 1e-5);
        assert!(round_cone(Vec3::new(0.5, 0.0, 0.0), Vec3::ZERO, 0.1, Vec3::X, 0.1) < 0.0);
    }

    /// A small random generator for the tests (no dependency).
    struct Lcg(u64);
    impl Lcg {
        fn f(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 40) as f32 / (1u64 << 24) as f32
        }
        fn v(&mut self) -> Vec3 {
            Vec3::new(self.f(), self.f(), self.f()) * 2.0 - 1.0
        }
    }

    #[test]
    fn ray_matches_sphere_tracing() {
        // The exact intersection agrees with sphere tracing the distance function.
        let mut rng = Lcg(7);
        let mut hits = 0;
        for _ in 0..4000 {
            let a = rng.v() * 0.3;
            let b = if rng.f() < 0.1 { a } else { a + rng.v() * 0.3 };
            let (ra, rb) = (0.01 + rng.f() * 0.1, 0.01 + rng.f() * 0.1);
            let o = rng.v().normalize() * 1.5;
            let dir = ((a + b) * 0.5 + rng.v() * 0.15 - o).normalize();
            // Trace: the first t where the distance is ~0, and the closest approach.
            let (mut t, mut traced, mut closest) = (0.0f32, None, f32::MAX);
            for _ in 0..2000 {
                let d = round_cone(o + dir * t, a, ra, b, rb);
                closest = closest.min(d);
                if d < 1e-6 {
                    traced = Some(t);
                    break;
                }
                t += d;
                if t > 4.0 {
                    break;
                }
            }
            let exact = ray_round_cone(o, dir, a, ra, b, rb);
            match (traced, exact) {
                (Some(tt), Some((te, n))) => {
                    hits += 1;
                    assert!((tt - te).abs() < 1e-3, "t {tt} vs {te}");
                    let p = o + dir * te;
                    let e = 1e-4;
                    let g = Vec3::new(
                        round_cone(p + Vec3::X * e, a, ra, b, rb) - round_cone(p - Vec3::X * e, a, ra, b, rb),
                        round_cone(p + Vec3::Y * e, a, ra, b, rb) - round_cone(p - Vec3::Y * e, a, ra, b, rb),
                        round_cone(p + Vec3::Z * e, a, ra, b, rb) - round_cone(p - Vec3::Z * e, a, ra, b, rb),
                    )
                    .normalize();
                    assert!(n.dot(g) > 0.99, "normal {n} vs {g}");
                }
                (None, None) => {}
                // A ray that only grazes the surface can go either way.
                _ => assert!(closest.abs() < 1e-3, "traced {traced:?} exact {exact:?} closest {closest}"),
            }
        }
        assert!(hits > 1000, "{hits} hits: the test rays miss too often");
    }

    #[test]
    fn a_flat_tip_is_an_ellipsoid() {
        // One point (a == b), flattened along a tilted axis: the ray's hit is where the
        // ellipsoid's equation is 1, and the normal is its gradient.
        let mut rng = Lcg(11);
        let mut hits = 0;
        for _ in 0..2000 {
            let up = rng.v().normalize();
            let (r, k) = (0.05 + rng.f() * 0.1, 0.1 + rng.f() * 0.9);
            let c = rng.v() * 0.2;
            let o = rng.v().normalize() * 1.5;
            let dir = (c + rng.v() * 0.12 - o).normalize();
            // In the ellipsoid's frame: |p|^2 + (1/k^2 - 1) (p.up)^2 = r^2.
            let f = |p: Vec3| p.dot(p) + (1.0 / (k * k) - 1.0) * p.dot(up).powi(2) - r * r;
            let Some((t, n)) = ray_flat_cone(o, dir, c, r, c, r, up, k) else { continue };
            hits += 1;
            let p = o + dir * t - c;
            assert!(f(p).abs() < 1e-4, "off the surface: {}", f(p));
            let g = (p + up * ((1.0 / (k * k) - 1.0) * p.dot(up))).normalize();
            assert!(n.dot(g) > 0.999, "normal {n} vs {g}");
            assert!(f(o + dir * (t - 1e-3) - c) > 0.0, "not the first entry");
        }
        assert!(hits > 500, "{hits}");
    }

    #[test]
    fn segments_apart_and_crossing() {
        let d = |a: [f32; 3], b: [f32; 3], c: [f32; 3], e: [f32; 3]| segment_distance(a.into(), b.into(), c.into(), e.into());
        // Crossing at right angles, 0.5 apart in z.
        assert!((d([-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, -1.0, 0.5], [0.0, 1.0, 0.5]) - 0.5).abs() < 1e-6);
        // Parallel, overlapping.
        assert!((d([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, 0.2, 0.0], [2.0, 0.2, 0.0]) - 0.2).abs() < 1e-6);
        // End to end along a line.
        assert!((d([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.5, 0.0, 0.0], [3.0, 0.0, 0.0]) - 0.5).abs() < 1e-6);
        // A point and a segment; two points.
        assert!((d([0.5, 1.0, 0.0], [0.5, 1.0, 0.0], [0.0, 0.0, 0.0], [1.0, 0.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!((d([0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 3.0, 4.0], [0.0, 3.0, 4.0]) - 5.0).abs() < 1e-6);
        // Against brute force, at random.
        let mut rng = Lcg(3);
        for _ in 0..500 {
            let (p0, p1, q0, q1) = (rng.v(), rng.v(), rng.v(), rng.v());
            let mut best = f32::MAX;
            for i in 0..=200 {
                for j in 0..=200 {
                    let (s, t) = (i as f32 / 200.0, j as f32 / 200.0);
                    best = best.min((p0.lerp(p1, s) - q0.lerp(q1, t)).length());
                }
            }
            let got = segment_distance(p0, p1, q0, q1);
            assert!(got <= best + 1e-5 && got >= best - 0.02, "{got} vs {best}");
        }
    }

    #[test]
    fn degenerate() {
        // The same point twice, or one sphere inside the other: a sphere.
        assert!((round_cone(Vec3::Y, Vec3::ZERO, 0.5, Vec3::ZERO, 0.3) - 0.5).abs() < 1e-6);
        assert!((round_cone(Vec3::Y * 2.0, Vec3::ZERO, 1.0, Vec3::X * 0.1, 0.2) - 1.0).abs() < 1e-6);
    }
}
