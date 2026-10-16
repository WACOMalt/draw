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

/// The demo shapes as soft strokes (hardness 0), and two soft strokes that cross a third, to
/// show how strokes add up where they overlap.
pub fn soft() -> Painting {
    let mut p = painting();
    for s in &mut p.strokes {
        s.brush.hardness = 0.0;
        s.brush.radius *= 1.8;
    }
    for (i, color) in [[0.9, 0.2, 0.6], [0.2, 0.8, 0.5], [0.95, 0.6, 0.1]].into_iter().enumerate() {
        let a = i as f32 * 1.05;
        p.strokes.push(stroke(Brush { radius: 0.04, color, hardness: 0.0, opacity: 0.8, pressure_size: false, ..Default::default() }, 120, move |t| {
            let (s, c) = a.sin_cos();
            let x = (t - 0.5) * 0.5;
            (Vec3::new(-0.05 + x * c, 1.55 + x * s, 0.15), 1.0)
        }));
    }
    p
}

/// Rows of hardness 1, 0.75, 0.5, 0.25, 0 (top to bottom): opaque on the left, opacity 0.4 on
/// the right, in front of two solid white strokes.
pub fn compare() -> Painting {
    let mut p = Painting::default();
    for x in [-0.27f32, 0.27] {
        p.strokes.push(stroke(Brush { radius: 0.012, color: [0.85, 0.85, 0.85], pressure_size: false, ..Default::default() }, 60, move |t| {
            (Vec3::new(x, 0.9 + t * 0.7, -0.12), 1.0)
        }));
    }
    for (row, hardness) in [1.0f32, 0.75, 0.5, 0.25, 0.0].into_iter().enumerate() {
        let y = 1.45 - row as f32 * 0.1;
        let color = [[0.9, 0.25, 0.15], [0.95, 0.65, 0.1], [0.3, 0.75, 0.3], [0.15, 0.55, 0.9], [0.6, 0.3, 0.85]][row];
        for (x0, opacity) in [(-0.5f32, 1.0f32), (0.04, 0.4)] {
            p.strokes.push(stroke(Brush { radius: 0.03, color, hardness, opacity, pressure_size: false, ..Default::default() }, 80, move |t| {
                (Vec3::new(x0 + t * 0.46, y + (t * TAU).sin() * 0.012, 0.0), 1.0)
            }));
        }
    }
    p
}
