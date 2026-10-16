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
    let ob = o - b;
    let m1 = ba.dot(oa);
    let m2 = ba.dot(dir);
    let m3 = dir.dot(oa);
    let m5 = oa.dot(oa);
    let m6 = ob.dot(dir);
    let m7 = ob.dot(ob);
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
    fn degenerate() {
        // The same point twice, or one sphere inside the other: a sphere.
        assert!((round_cone(Vec3::Y, Vec3::ZERO, 0.5, Vec3::ZERO, 0.3) - 0.5).abs() < 1e-6);
        assert!((round_cone(Vec3::Y * 2.0, Vec3::ZERO, 1.0, Vec3::X * 0.1, 0.2) - 1.0).abs() < 1e-6);
    }
}
