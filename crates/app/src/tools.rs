//! The tools, as the 2D app's toolbar has them (multiplayer-canvas Toolbar.svelte): the brush,
//! the eraser (a brush of its own settings, whose strokes take paint away), and the stroke
//! eraser (it takes whole strokes out: those whose center line its ball touches).

use glam::{Quat, Vec3};
use vdraw_core::sdf::segment_distance;
use vdraw_core::{Brush, GpuSegment, LayerRun};
use vdraw_render::OverlayLine;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Brush,
    Eraser,
    StrokeEraser,
    /// Picks the color of the painting where the pen points (all layers, as seen).
    Eyedropper,
}

impl Tool {
    /// The 2D app's name for it (the tooltip and the options bar).
    pub fn name(self) -> &'static str {
        match self {
            Tool::Brush => "Brush",
            Tool::Eraser => "Eraser",
            Tool::StrokeEraser => "Stroke eraser",
            Tool::Eyedropper => "Eyedropper",
        }
    }
}

/// The tools' settings. The brush and the eraser keep their own (as in the 2D app); the
/// foreground color is the brush's.
#[derive(Clone, Debug)]
pub struct Tools {
    pub tool: Tool,
    pub brush: Brush,
    /// The background color (linear RGB), as the 2D app's: swapped with the foreground.
    pub bg: [f32; 3],
    pub eraser: Brush,
    /// How far the tip turns about the pen's axis, degrees, clockwise as the pen sees it (the
    /// 2D app's Angle): the brush's and the eraser's. At 0 the tip is wide across the hand.
    pub angle: [f32; 2],
    /// The stroke eraser's ball: its diameter, meters.
    pub sweep_size: f32,
    /// The stroke eraser takes strokes from every visible layer; else from the active one.
    pub sweep_all: bool,
    /// How much the pen's path is smoothed as it paints (0..0.95, the 2D app's smoothing).
    pub smoothing: f32,
}

impl Default for Tools {
    fn default() -> Self {
        // The 2D app's eraser: hardness 0.6, no pressure to size.
        let eraser = Brush { radius: 0.02, hardness: 0.6, pressure_size: false, erase: true, ..Default::default() };
        Self { tool: Tool::Brush, brush: Brush::default(), bg: [1.0; 3], eraser, angle: [0.0; 2], sweep_size: 0.03, sweep_all: true, smoothing: 0.25 }
    }
}

impl Tools {
    /// The brush the trigger paints with (the eraser's takes paint away); None for the stroke
    /// eraser.
    pub fn paint(&self) -> Option<Brush> {
        match self.tool {
            Tool::Brush => Some(Brush { erase: false, ..self.brush }),
            Tool::Eraser => Some(Brush { erase: true, ..self.eraser }),
            Tool::StrokeEraser | Tool::Eyedropper => None,
        }
    }

    /// Swaps the foreground and background colors (the 2D app's X).
    pub fn swap_colors(&mut self) {
        std::mem::swap(&mut self.brush.color, &mut self.bg);
    }

    /// Black on white (the 2D app's D).
    pub fn default_colors(&mut self) {
        self.brush.color = [0.0; 3];
        self.bg = [1.0; 3];
    }

    /// The settings the panel shows for the painting tools, and their angle.
    pub fn current(&mut self) -> Option<(&mut Brush, &mut f32)> {
        match self.tool {
            Tool::Brush => Some((&mut self.brush, &mut self.angle[0])),
            Tool::Eraser => Some((&mut self.eraser, &mut self.angle[1])),
            Tool::StrokeEraser | Tool::Eyedropper => None,
        }
    }

    /// The pen's up direction, turned by the tool's angle about the pen's axis (`forward`).
    pub fn tip_up(&self, up: Vec3, forward: Vec3) -> Vec3 {
        let angle = match self.tool {
            Tool::Eraser => self.angle[1],
            _ => self.angle[0],
        };
        Quat::from_axis_angle(forward.normalize_or_zero(), angle.to_radians()) * up
    }
}

/// The segments the stroke eraser can take: every shown layer's (`only` None), or one step's.
fn eligible<'a>(segs: &'a [GpuSegment], runs: &[LayerRun], only: Option<usize>) -> impl Iterator<Item = &'a GpuSegment> {
    runs.iter()
        .filter(move |r| only.is_none_or(|s| r.step == s))
        .flat_map(move |r| &segs[r.first..r.first + r.count])
}

/// Strokes (by number) whose center line comes within `r` of the path `from`..`to` (the
/// ball's sweep this frame; the 2D app's strokesNear), but not those in `skip` (sorted).
#[allow(clippy::too_many_arguments)]
pub fn swept(segs: &[GpuSegment], runs: &[LayerRun], only: Option<usize>, from: Vec3, to: Vec3, r: f32, skip: &[u32]) -> Vec<u32> {
    let mut hit: Vec<u32> = Vec::new();
    let (lo, hi) = (from.min(to) - r, from.max(to) + r);
    for g in eligible(segs, runs, only) {
        let id = g.style[1] as u32;
        if hit.last() == Some(&id) || skip.binary_search(&id).is_ok() {
            continue;
        }
        let (a, b) = (g.a(), g.b());
        if a.min(b).cmpgt(hi).any() || a.max(b).cmplt(lo).any() {
            continue;
        }
        if segment_distance(a, b, from, to) <= r {
            hit.push(id);
        }
    }
    hit.sort_unstable();
    hit.dedup();
    hit
}

// The 2D app's path overlay (engine.ts drawPaths): a blue line over a faint dark halo, and
// the strokes under the circle in red over a darker one. sRGB colors, made linear.
const PATH: ([f32; 3], f32, f32, f32) = ([80.0 / 255.0, 190.0 / 255.0, 1.0], 0.95, 1.0, 2.5);
const PATH_HALO: f32 = 0.35;
const HOT: ([f32; 3], f32, f32, f32) = ([1.0, 0x4d as f32 / 255.0, 0x4f as f32 / 255.0], 1.0, 2.0, 3.5);
const HOT_HALO: f32 = 0.5;
/// Overlay lines drawn at most (the red ones first).
pub const MAX_OVERLAY: usize = 4096;

/// The stroke eraser's overlay: the whole center lines of the strokes in `hot` (sorted: under
/// the ball) in red, and the pieces of the others' it can take within `reach` of the ball (at
/// `tip`) in blue. Strokes in `skip` (sorted: taken this sweep) are left out. (The 2D app shows
/// every stroke's path; in VR the whole painting's would be a thicket around the hand.)
#[allow(clippy::too_many_arguments)]
pub fn overlay(segs: &[GpuSegment], runs: &[LayerRun], only: Option<usize>, tip: Vec3, reach: f32, hot: &[u32], skip: &[u32], out: &mut Vec<OverlayLine>) {
    let line = |g: &GpuSegment, (color, alpha, width, halo_width): ([f32; 3], f32, f32, f32), halo: f32| {
        let c = vdraw_core::segments::to_linear(color);
        OverlayLine { a: [g.a[0], g.a[1], g.a[2], width], b: [g.b[0], g.b[1], g.b[2], halo_width], color: [c[0], c[1], c[2], alpha], halo: [0.0, 0.0, 0.0, halo] }
    };
    // The red ones first, so the cap never leaves them out.
    for &id in hot {
        let from = segs.partition_point(|g| (g.style[1] as u32) < id);
        for g in segs[from..].iter().take_while(|g| g.style[1] as u32 == id).take(MAX_OVERLAY - out.len()) {
            out.push(line(g, HOT, HOT_HALO));
        }
    }
    for g in eligible(segs, runs, only) {
        if out.len() >= MAX_OVERLAY {
            break;
        }
        let id = g.style[1] as u32;
        if hot.binary_search(&id).is_ok() || skip.binary_search(&id).is_ok() || segment_distance(g.a(), g.b(), tip, tip) > reach {
            continue;
        }
        out.push(line(g, PATH, PATH_HALO));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vdraw_core::{Sample, Stroke};

    fn line(id: u32, y: f32) -> Vec<GpuSegment> {
        let mut s = Stroke::new(Brush { radius: 0.01, ..Default::default() });
        for i in 0..=10 {
            s.push(Sample::new(Vec3::new(i as f32 * 0.01, y, 0.0), 1.0, i as f64));
        }
        let mut out = Vec::new();
        s.segments(vdraw_core::OneEuro3::new(1e6, 0.0, 1.0), id, &mut out);
        out
    }

    #[test]
    fn the_sweep_takes_strokes_whose_center_line_it_touches() {
        let mut segs = line(0, 0.0);
        segs.extend(line(1, 0.05));
        let runs = [LayerRun { step: 0, first: 0, count: segs.len() }];
        // A sweep down across both lines, 1 cm ball: both.
        let both = swept(&segs, &runs, None, Vec3::new(0.05, 0.1, 0.0), Vec3::new(0.05, -0.1, 0.0), 0.01, &[]);
        assert_eq!(both, vec![0, 1]);
        // Within the second stroke's radius (1 cm) but not near its center line: nothing, as in
        // the 2D app (the ball must touch the path).
        let near = swept(&segs, &runs, None, Vec3::new(0.05, 0.035, 0.0), Vec3::new(0.05, 0.035, 0.0), 0.005, &[]);
        assert!(near.is_empty(), "{near:?}");
        // Taken already: skipped. One step only: a step not in the runs takes none.
        assert_eq!(swept(&segs, &runs, None, Vec3::new(0.05, 0.1, 0.0), Vec3::new(0.05, -0.1, 0.0), 0.01, &[0]), vec![1]);
        assert!(swept(&segs, &runs, Some(1), Vec3::new(0.05, 0.1, 0.0), Vec3::new(0.05, -0.1, 0.0), 0.01, &[]).is_empty());
    }

    #[test]
    fn the_tip_turns_about_the_pen() {
        let mut t = Tools::default();
        t.angle[0] = 90.0;
        // Pen pointing ahead (-z), up is +y: a quarter turn clockwise as the pen sees it.
        let up = t.tip_up(Vec3::Y, Vec3::NEG_Z);
        assert!(up.abs_diff_eq(Vec3::X, 1e-5), "{up}");
    }
}
