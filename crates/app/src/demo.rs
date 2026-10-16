//! A small painting to look at before anyone paints: a spiral, a wave and a knot, at standing
//! height (y about 1.2 m).

use glam::Vec3;
use std::f32::consts::TAU;
use vdraw_core::{Brush, Painting, Sample, Stroke};

fn stroke(brush: Brush, n: usize, f: impl Fn(f32) -> (Vec3, f32)) -> Stroke {
    let mut s = Stroke::new(brush);
    for i in 0..=n {
        let t = i as f32 / n as f32;
        let (pos, pressure) = f(t);
        s.push(Sample { pos, pressure, time: i as f64 / 90.0 });
    }
    s
}

pub fn painting() -> Painting {
    let mut p = Painting::default();
    // A rising spiral, thicker in the middle.
    p.strokes.push(stroke(Brush { radius: 0.018, color: [0.85, 0.25, 0.15], ..Default::default() }, 240, |t| {
        let a = t * TAU * 2.5;
        (Vec3::new(a.cos() * 0.25, 0.95 + t * 0.5, a.sin() * 0.25), (t * std::f32::consts::PI).sin())
    }));
    // A wave in front.
    p.strokes.push(stroke(Brush { radius: 0.012, color: [0.15, 0.55, 0.9], pressure_size: false, ..Default::default() }, 160, |t| {
        (Vec3::new(-0.45 + t * 0.9, 1.15 + (t * TAU * 2.0).sin() * 0.08, 0.35), 1.0)
    }));
    // A trefoil knot to the side.
    p.strokes.push(stroke(Brush { radius: 0.01, color: [0.95, 0.8, 0.2], ..Default::default() }, 300, |t| {
        let a = t * TAU;
        let k = Vec3::new(a.sin() + 2.0 * (2.0 * a).sin(), a.cos() - 2.0 * (2.0 * a).cos(), -(3.0 * a).sin());
        (Vec3::new(0.55, 1.25, -0.1) + k * 0.05, 0.6 + 0.4 * (3.0 * a).cos().abs())
    }));
    p
}
