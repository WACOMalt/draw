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

    #[test]
    fn degenerate() {
        // The same point twice, or one sphere inside the other: a sphere.
        assert!((round_cone(Vec3::Y, Vec3::ZERO, 0.5, Vec3::ZERO, 0.3) - 0.5).abs() < 1e-6);
        assert!((round_cone(Vec3::Y * 2.0, Vec3::ZERO, 1.0, Vec3::X * 0.1, 0.2) - 1.0).abs() < 1e-6);
    }
}
