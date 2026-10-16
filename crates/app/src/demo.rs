//! A small painting to look at before anyone paints: a spiral, a wave and a knot, at standing
//! height (y about 1.2 m).

use glam::Vec3;
use std::f32::consts::TAU;
use vdraw_core::{Brush, Painting, Sample, Stroke};

fn stroke(brush: Brush, n: usize, f: impl Fn(f32) -> (Vec3, f32)) -> Stroke {
    turned(brush, n, |t| (f(t), Vec3::Y))
}

/// A stroke whose pen turns: `f` gives the tip and pressure, and the pen's up direction.
fn turned(brush: Brush, n: usize, f: impl Fn(f32) -> ((Vec3, f32), Vec3)) -> Stroke {
    let mut s = Stroke::new(brush);
    for i in 0..=n {
        let t = i as f32 / n as f32;
        let ((pos, pressure), up) = f(t);
        s.push(Sample { up, ..Sample::new(pos, pressure, i as f64 / 90.0) });
    }
    s
}

pub fn painting() -> Painting {
    let mut p = Painting::default();
    // A rising spiral, thicker in the middle.
    p.active().push(stroke(Brush { radius: 0.018, color: [0.85, 0.25, 0.15], ..Default::default() }, 240, |t| {
        let a = t * TAU * 2.5;
        (Vec3::new(a.cos() * 0.25, 0.95 + t * 0.5, a.sin() * 0.25), (t * std::f32::consts::PI).sin())
    }));
    // A wave in front.
    p.active().push(stroke(Brush { radius: 0.012, color: [0.15, 0.55, 0.9], pressure_size: false, ..Default::default() }, 160, |t| {
        (Vec3::new(-0.45 + t * 0.9, 1.15 + (t * TAU * 2.0).sin() * 0.08, 0.35), 1.0)
    }));
    // A trefoil knot to the side.
    p.active().push(stroke(Brush { radius: 0.01, color: [0.95, 0.8, 0.2], ..Default::default() }, 300, |t| {
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
    for s in p.active().iter_mut() {
        s.brush.hardness = 0.0;
        s.brush.radius *= 1.8;
    }
    for (i, color) in [[0.9, 0.2, 0.6], [0.2, 0.8, 0.5], [0.95, 0.6, 0.1]].into_iter().enumerate() {
        let a = i as f32 * 1.05;
        p.active().push(stroke(Brush { radius: 0.04, color, hardness: 0.0, opacity: 0.8, pressure_size: false, ..Default::default() }, 120, move |t| {
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
        p.active().push(stroke(Brush { radius: 0.012, color: [0.85, 0.85, 0.85], pressure_size: false, ..Default::default() }, 60, move |t| {
            (Vec3::new(x, 0.9 + t * 0.7, -0.12), 1.0)
        }));
    }
    for (row, hardness) in [1.0f32, 0.75, 0.5, 0.25, 0.0].into_iter().enumerate() {
        let y = 1.45 - row as f32 * 0.1;
        let color = [[0.9, 0.25, 0.15], [0.95, 0.65, 0.1], [0.3, 0.75, 0.3], [0.15, 0.55, 0.9], [0.6, 0.3, 0.85]][row];
        for (x0, opacity) in [(-0.5f32, 1.0f32), (0.04, 0.4)] {
            p.active().push(stroke(Brush { radius: 0.03, color, hardness, opacity, pressure_size: false, ..Default::default() }, 80, move |t| {
                (Vec3::new(x0 + t * 0.46, y + (t * TAU).sin() * 0.012, 0.0), 1.0)
            }));
        }
    }
    p
}

/// A load test: 24 tangled strokes in a ball of about 0.4 m around standing height, half solid
/// and half soft, about as dense as a few minutes of painting in one place. VDRAW_DENSE=solid
/// or =soft makes them all one kind (to time each).
pub fn dense() -> Painting {
    let mut seed = 12345u64;
    let mut rnd = move || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 40) as f32 / (1u64 << 24) as f32
    };
    let mut p = Painting::default();
    for i in 0..24 {
        let phase: [f32; 6] = std::array::from_fn(|_| rnd() * TAU);
        let freq: [f32; 3] = std::array::from_fn(|_| 1.0 + rnd());
        let soft = match std::env::var("VDRAW_DENSE").as_deref() {
            Ok("solid") => false,
            Ok("soft") => true,
            _ => i % 2 == 1,
        };
        let brush = Brush {
            radius: 0.01 + rnd() * 0.025,
            color: [0.2 + rnd() * 0.8, 0.2 + rnd() * 0.8, 0.2 + rnd() * 0.8],
            hardness: if soft { rnd() * 0.5 } else { 1.0 },
            opacity: if soft { 0.4 + rnd() * 0.6 } else { 1.0 },
            ..Default::default()
        };
        p.active().push(stroke(brush, 200, move |t| {
            let a = t * TAU;
            let v = Vec3::new(
                (a * freq[0] + phase[0]).sin() + 0.5 * (a * 2.0 * freq[1] + phase[3]).sin(),
                (a * freq[1] + phase[1]).sin() + 0.5 * (a * 2.0 * freq[2] + phase[4]).sin(),
                (a * freq[2] + phase[2]).sin() + 0.5 * (a * 2.0 * freq[0] + phase[5]).sin(),
            );
            (Vec3::new(0.0, 1.3, 0.0) + v * 0.13, 0.5 + 0.5 * (a * 3.0).sin().abs())
        }));
    }
    p
}

/// Big soft strokes that overlap themselves: a loop that crosses itself across the view, and
/// one that folds back in depth. Where a stroke overlaps itself, its density adds up.
pub fn overlap() -> Painting {
    let mut p = Painting::default();
    let soft = |color| Brush { radius: 0.06, color, hardness: 0.0, opacity: 0.45, pressure_size: false, ..Default::default() };
    // A figure-eight in the plane facing the viewer.
    p.active().push(stroke(soft([0.95, 0.35, 0.2]), 300, |t| {
        let a = t * TAU;
        (Vec3::new(-0.3 + (a).sin() * 0.22, 1.3 + (2.0 * a).sin() * 0.12, 0.0), 1.0)
    }));
    // A hairpin that folds back toward the viewer: its two halves line up along the view.
    p.active().push(stroke(soft([0.2, 0.55, 0.95]), 300, |t| {
        // Out toward the viewer and back, a little lower: from the front, the halves overlap.
        let a = t * std::f32::consts::PI;
        (Vec3::new(0.3 + (t - 0.5) * 0.06, 1.3 - t * 0.06, a.sin() * 0.3), 1.0)
    }));
    p
}

/// Flat tips (roundness 0.15): a wave with the pen upright (thin where it runs level, wide where
/// it climbs), the same wave with the pen rolling a half turn along it (a twisted ribbon), a
/// calligraphy loop with the pen held at 45 degrees, and a soft flat stroke.
pub fn flat() -> Painting {
    let mut p = Painting::default();
    let flat = |color, hardness: f32, opacity: f32| Brush { radius: 0.035, color, roundness: 0.15, hardness, opacity, pressure_size: false, ..Default::default() };
    p.active().push(stroke(flat([0.9, 0.3, 0.15], 1.0, 1.0), 200, |t| {
        (Vec3::new(-0.45 + t * 0.9, 1.6 + (t * TAU * 1.5).sin() * 0.07, 0.0), 1.0)
    }));
    p.active().push(turned(flat([0.2, 0.6, 0.9], 1.0, 1.0), 200, |t| {
        let roll = t * std::f32::consts::PI;
        ((Vec3::new(-0.45 + t * 0.9, 1.4, 0.0), 1.0), Vec3::new(0.0, roll.cos(), roll.sin()))
    }));
    let pen = Vec3::new(1.0, 1.0, 0.0).normalize();
    p.active().push(turned(flat([0.95, 0.8, 0.2], 1.0, 1.0), 200, move |t| {
        let a = t * TAU;
        ((Vec3::new(-0.25 + a.cos() * 0.13, 1.12 + a.sin() * 0.13, 0.0), 1.0), pen)
    }));
    p.active().push(turned(flat([0.6, 0.3, 0.85], 0.3, 0.8), 200, move |t| {
        let a = t * TAU;
        ((Vec3::new(0.25 + a.cos() * 0.13, 1.12 + a.sin() * 0.13, 0.0), 1.0), pen)
    }));
    p
}

/// Paint over paint: yellow under blue, yellow under red, blue under red, white under blue
/// (top to bottom), each pair a soft stroke at 70% over a solid one; on the right, the same as
/// thin glazes (soft over soft, 40%). With `--mix pigment` they mix as paint.
pub fn mix() -> Painting {
    let mut p = Painting::default();
    let srgb = |c: [f32; 3]| vdraw_core::segments::to_linear(c);
    let pairs = [([0.98, 0.85, 0.1], [0.1, 0.3, 0.85]), ([0.98, 0.85, 0.1], [0.85, 0.1, 0.1]), ([0.1, 0.3, 0.85], [0.85, 0.1, 0.1]), ([1.0, 1.0, 1.0], [0.1, 0.3, 0.85])];
    for (row, (under, over)) in pairs.into_iter().enumerate() {
        let y = 1.58 - row as f32 * 0.15;
        for (x0, under_brush, opacity) in [(-0.42f32, true, 0.7f32), (0.04, false, 0.4)] {
            let base = Brush { radius: 0.03, color: srgb(under), pressure_size: false, hardness: if under_brush { 1.0 } else { 0.4 }, opacity: if under_brush { 1.0 } else { opacity }, ..Default::default() };
            p.active().push(stroke(base, 60, move |t| (Vec3::new(x0 + t * 0.38, y, -0.02), 1.0)));
            let top = Brush { radius: 0.03, color: srgb(over), pressure_size: false, hardness: 0.4, opacity, ..Default::default() };
            p.active().push(stroke(top, 60, move |t| (Vec3::new(x0 + 0.12 + t * 0.26, y + 0.02, 0.02), 1.0)));
        }
    }
    p
}
