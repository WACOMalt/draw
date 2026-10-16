//! One Euro filter (Casiez, Roussel, Vogel, CHI 2012) for 3D positions: strong smoothing when
//! the brush moves slowly (jitter), little when it moves fast (lag). The cutoff follows the
//! speed of the filtered position, shared by the three axes.

use glam::Vec3;

#[derive(Clone, Copy, Debug)]
pub struct OneEuro3 {
    /// Cutoff at rest, Hz.
    pub min_cutoff: f32,
    /// How fast the cutoff rises with speed, Hz per (m/s).
    pub beta: f32,
    /// Cutoff for the speed estimate, Hz.
    pub d_cutoff: f32,
    prev: Option<(f64, Vec3, Vec3)>, // time, value, derivative
}

impl Default for OneEuro3 {
    fn default() -> Self {
        Self::new(1.0, 5.0, 1.0)
    }
}

fn alpha(cutoff: f32, dt: f32) -> f32 {
    let tau = 1.0 / (2.0 * std::f32::consts::PI * cutoff);
    1.0 / (1.0 + tau / dt)
}

impl OneEuro3 {
    pub fn new(min_cutoff: f32, beta: f32, d_cutoff: f32) -> Self {
        Self { min_cutoff, beta, d_cutoff, prev: None }
    }

    pub fn reset(&mut self) {
        self.prev = None;
    }

    /// The filtered value of `x` at time `t` (seconds). Times must not go back.
    pub fn filter(&mut self, t: f64, x: Vec3) -> Vec3 {
        let Some((t0, x0, dx0)) = self.prev else {
            self.prev = Some((t, x, Vec3::ZERO));
            return x;
        };
        let dt = ((t - t0) as f32).max(1e-6);
        let dx = (x - x0) / dt;
        let dx = dx0.lerp(dx, alpha(self.d_cutoff, dt));
        let cutoff = self.min_cutoff + self.beta * dx.length();
        let y = x0.lerp(x, alpha(cutoff, dt));
        self.prev = Some((t, y, dx));
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_a_still_point() {
        let mut f = OneEuro3::default();
        let p = Vec3::new(1.0, 2.0, 3.0);
        for i in 0..200 {
            f.filter(i as f64 / 90.0, p);
        }
        assert!((f.filter(200.0 / 90.0, p) - p).length() < 1e-5);
    }

    #[test]
    fn smooths_jitter() {
        let mut f = OneEuro3::default();
        let mut worst: f32 = 0.0;
        for i in 0..400 {
            let jitter = if i % 2 == 0 { 0.001 } else { -0.001 };
            let y = f.filter(i as f64 / 90.0, Vec3::new(jitter, 0.0, 0.0));
            if i > 100 {
                worst = worst.max(y.x.abs());
            }
        }
        assert!(worst < 0.0005, "jitter left: {worst}");
    }
}
