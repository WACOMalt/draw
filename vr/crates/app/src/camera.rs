//! Projections for Vulkan clip space (x right, y down, depth 0..1), and the desktop's orbit camera.

use glam::{Mat4, Vec3, Vec4};

/// A symmetric perspective (the desktop window), y down for Vulkan.
pub fn perspective(fov_y: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
    Mat4::from_scale(Vec3::new(1.0, -1.0, 1.0)) * Mat4::perspective_rh(fov_y, aspect, near, far)
}

/// An asymmetric perspective from OpenXR field-of-view angles (radians; left and down are
/// negative), y down for Vulkan.
pub fn perspective_fov(left: f32, right: f32, up: f32, down: f32, near: f32, far: f32) -> Mat4 {
    let (l, r, u, d) = (left.tan(), right.tan(), up.tan(), down.tan());
    let w = r - l;
    let h = d - u; // negative: y down
    Mat4::from_cols(
        Vec4::new(2.0 / w, 0.0, 0.0, 0.0),
        Vec4::new(0.0, 2.0 / h, 0.0, 0.0),
        Vec4::new((r + l) / w, (u + d) / h, -far / (far - near), -1.0),
        Vec4::new(0.0, 0.0, -(far * near) / (far - near), 0.0),
    )
}

/// A projection for picking: in an image `width` x `height` pixels, the ray through the middle
/// of the top-left pixel goes straight ahead (-z), and a pixel spans 0.1 milliradian. (The
/// eyedropper renders only that corner of a view along the controller's ray.)
pub fn pick_projection(width: u32, height: u32, near: f32, far: f32) -> Mat4 {
    let (sx, sy) = (width as f32 * 1e-4, height as f32 * 1e-4);
    let (l, u) = (-sx / (2.0 * width as f32), sy / (2.0 * height as f32));
    perspective_fov(l.atan(), (l + sx).atan(), u.atan(), (u - sy).atan(), near, far)
}

/// Turns around a target point: yaw and pitch in radians, distance in meters.
#[derive(Clone, Copy, Debug)]
pub struct Orbit {
    pub target: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
}

impl Default for Orbit {
    fn default() -> Self {
        Self { target: Vec3::new(0.0, 1.2, 0.0), yaw: 0.35, pitch: 0.25, distance: 1.6 }
    }
}

impl Orbit {
    pub fn eye(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        self.target + Vec3::new(sy * cp, sp, cy * cp) * self.distance
    }

    pub fn view(&self) -> Mat4 {
        Mat4::look_at_rh(self.eye(), self.target, Vec3::Y)
    }

    /// Right and up of the view, for panning and for the paint plane.
    pub fn axes(&self) -> (Vec3, Vec3, Vec3) {
        let fwd = (self.target - self.eye()).normalize();
        let right = fwd.cross(Vec3::Y).normalize();
        let up = right.cross(fwd);
        (right, up, fwd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pick_ray_goes_straight_ahead() {
        // The shader's ray through pixel (0.5, 0.5): the inverse projection of its NDC point.
        let (w, h) = (1732, 1924);
        let inv = pick_projection(w, h, 0.02, 100.0).inverse();
        let ndc = glam::Vec2::new(0.5 / w as f32 * 2.0 - 1.0, 0.5 / h as f32 * 2.0 - 1.0);
        let far = inv * Vec4::new(ndc.x, ndc.y, 1.0, 1.0);
        let dir = (far.truncate() / far.w).normalize();
        assert!(dir.abs_diff_eq(Vec3::NEG_Z, 1e-5), "{dir}");
    }

    #[test]
    fn fov_matches_symmetric() {
        // A symmetric field of view gives the same matrix as `perspective`.
        let half = 0.6f32;
        let a = perspective_fov(-half, half, half, -half, 0.05, 100.0);
        let b = perspective(half * 2.0, 1.0, 0.05, 100.0);
        assert!(a.abs_diff_eq(b, 1e-5), "{a} {b}");
    }
}
