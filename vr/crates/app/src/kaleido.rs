//! The Kaleidoscope tool: the active layer's kaleidoscope (the 2D app's effect, on a shared
//! canvas), set by hand. Two balls: the pivot, and the step (where copy 1 of a point beside
//! the pivot goes). Hold a ball with the trigger: the pivot follows the hand; the step follows
//! the hand as copy 1 would (moving it moves the step, turning the wrist turns it, the stick
//! scales it). The step changes by the hand's change divided by the copies, so the far copies
//! do not swing wildly; the other hand's trigger makes it ten times finer still.

use crate::painter::Painter;
use glam::{DMat4, DQuat, DVec3, Mat4, Quat, Vec3};
use vdraw_render::OverlayLine;

/// The balls' radius and the step ball's point's distance from the pivot, meters as they look.
const BALL: f32 = 0.025;
const ARM: f32 = 0.12;
/// How far from a ball the hand takes hold of it, in balls.
const REACH: f32 = 1.6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Handle {
    Pivot,
    Step,
}

/// A trigger held with the Kaleidoscope tool: the hand, the ball it took (None: it took none,
/// and takes none until let go), the hand's pose then (scene), the kaleidoscope then, the
/// ball's place then, and how far the stick has scaled the step (its log).
#[derive(Clone, Debug)]
pub struct Hold {
    hand: usize,
    handle: Option<Handle>,
    start: Mat4,
    base: Option<vdraw_core::doc::Kaleido>,
    ball: Vec3,
    grow: f64,
}

/// Where the balls are (scene): the pivot, the point beside it, and that point's copies in
/// order (copy 1 first: the step ball).
pub struct Balls {
    pub pivot: Vec3,
    pub arm: Vec3,
    pub path: Vec<Vec3>,
}

impl Painter {
    /// The active layer's place, if it is shown and has a kaleidoscope that is on.
    pub fn kaleido_layer(&self) -> Option<usize> {
        let i = self.active_index();
        let k = self.painting.layers[i].kaleido.as_ref()?;
        (k.on() && k.count() > 0 && self.painting.shown(i)).then_some(i)
    }

    pub fn kaleido_balls(&self) -> Option<Balls> {
        let i = self.kaleido_layer()?;
        let l = &self.painting.layers[i];
        let k = l.kaleido.as_ref()?;
        let pivot = k.pivot_scene();
        let arm = pivot + Vec3::X * ARM * self.scale;
        // The copies as drawn (behind: the last first).
        let n = k.count().min(l.copies.len().saturating_sub(1));
        let copy = |c: usize| if k.behind() { l.copies[n - c] } else { l.copies[c] };
        let path = (1..=n).map(|c| copy(c).transform_point3(arm)).collect();
        Some(Balls { pivot, arm, path })
    }

    /// A new kaleidoscope for layer `i` (by place), its pivot in the middle of the layer's
    /// strokes (a group's: of its layers'), else of the view. None before a shared canvas's
    /// frame is known.
    pub fn new_kaleido(&self, i: usize) -> Option<vdraw_core::doc::Kaleido> {
        let frame = self.frame?;
        let block = self.painting.block(i);
        let paint: Vec<&vdraw_core::Layer> = self.painting.layers[block].iter().filter(|l| !l.group && l.adjust.is_none()).collect();
        let depth = !paint.is_empty() && paint.iter().all(|l| l.threed);
        let mut points = paint.iter().flat_map(|l| &l.strokes).flat_map(|s| &s.samples).map(|s| s.pos);
        let middle = points.next().map(|first| {
            let (lo, hi) = points.fold((first, first), |(lo, hi), p| (lo.min(p), hi.max(p)));
            (lo + hi) * 0.5
        });
        let [cx, cy, _] = middle.map_or([frame.anchor[0], frame.anchor[1], 0.0], |m| frame.canvas(m));
        Some(vdraw_core::doc::Kaleido::new((cx * 1e3).round() / 1e3, (cy * 1e3).round() / 1e3, depth, frame))
    }

    /// The ball within reach of `at` (scene), the nearest.
    fn handle_at(&self, at: Vec3) -> Option<Handle> {
        let b = self.kaleido_balls()?;
        let reach = BALL * REACH * self.scale;
        let mut best = None;
        for (h, p) in [(Handle::Pivot, Some(b.pivot)), (Handle::Step, b.path.first().copied())] {
            let Some(p) = p else { continue };
            let d = (p - at).length();
            if d <= reach && best.is_none_or(|(_, bd)| d < bd) {
                best = Some((h, d));
            }
        }
        best.map(|(h, _)| h)
    }

    /// The Kaleidoscope tool, each frame: the hand's pose (scene), its trigger, its stick (up
    /// scales the step), whether to go ten times finer, and the frame's time.
    pub fn kaleido(&mut self, hand: usize, pose: Mat4, down: bool, stick: f32, fine: bool, dt: f32) {
        let at = pose.w_axis.truncate();
        match (&mut self.kaleido_hold, down) {
            (None, true) => {
                let handle = self.handle_at(at);
                let i = self.active_index();
                let base = self.painting.layers[i].kaleido.clone().filter(|_| handle.is_some());
                let ball = match (handle, self.kaleido_balls()) {
                    (Some(Handle::Step), Some(b)) => b.path[0],
                    (_, Some(b)) => b.pivot,
                    _ => at,
                };
                self.kaleido_hold = Some(Hold { hand, handle, start: pose, base, ball, grow: 0.0 });
            }
            (Some(h), true) if h.hand == hand => {
                let (Some(handle), Some(base)) = (h.handle, h.base.clone()) else { return };
                let gain = if fine { 0.1 } else { 1.0 };
                let mut k = base.clone();
                match handle {
                    Handle::Pivot => k.set_pivot_scene(base.pivot_scene() + (at - h.start.w_axis.truncate()) * gain as f32),
                    Handle::Step => {
                        let g = gain / base.count().max(1) as f64;
                        if stick.abs() > 0.15 {
                            h.grow += stick as f64 * dt as f64 * 0.8 * gain;
                        }
                        // The hand's change, about the ball, a part g of it.
                        let (_, r1, t1) = pose.as_dmat4().to_scale_rotation_translation();
                        let (_, r0, t0) = h.start.as_dmat4().to_scale_rotation_translation();
                        let turn = DQuat::IDENTITY.slerp((r1 * r0.inverse()).normalize(), g);
                        let ball = h.ball.as_dvec3();
                        let d = DMat4::from_translation(ball + (t1 - t0) * g) * DMat4::from_quat(turn) * DMat4::from_translation(-ball);
                        // The stick scales each step about the pivot.
                        let c = base.pivot_scene().as_dvec3();
                        let grow = DMat4::from_translation(c) * DMat4::from_scale(DVec3::splat(h.grow.exp())) * DMat4::from_translation(-c);
                        k.set_step_scene(d * base.step_scene() * grow);
                    }
                }
                let i = self.active_index();
                let l = &mut self.painting.layers[i];
                if l.kaleido.as_ref() != Some(&k) {
                    l.kaleido = Some(k);
                    l.update_copies();
                    self.rebuild();
                }
            }
            (Some(h), false) if h.hand == hand => self.kaleido_hold = None,
            _ => {}
        }
    }

    /// The balls and the copies' path, as lines (the ball held or in reach of `tip` bright).
    pub fn kaleido_lines(&self, tip: Option<Vec3>, out: &mut Vec<OverlayLine>) {
        let Some(b) = self.kaleido_balls() else { return };
        let lit = match &self.kaleido_hold {
            Some(h) if h.handle.is_some() => h.handle,
            _ => tip.and_then(|t| self.handle_at(t)),
        };
        let line = |a: Vec3, c: Vec3, color: [f32; 3], width: f32, out: &mut Vec<OverlayLine>| {
            let c2 = vdraw_core::segments::to_linear(color);
            out.push(OverlayLine { a: [a.x, a.y, a.z, width], b: [c.x, c.y, c.z, width + 2.5], color: [c2[0], c2[1], c2[2], 0.95], halo: [0.0, 0.0, 0.0, 0.4] });
        };
        let r = BALL * self.scale;
        let ball = |at: Vec3, color: [f32; 3], on: bool, out: &mut Vec<OverlayLine>| {
            let (width, r) = if on { (2.5, r * 1.15) } else { (1.5, r) };
            for axis in [Quat::IDENTITY, Quat::from_rotation_x(std::f32::consts::FRAC_PI_2), Quat::from_rotation_y(std::f32::consts::FRAC_PI_2)] {
                let p = |k: usize| {
                    let a = k as f32 / 20.0 * std::f32::consts::TAU;
                    at + axis * Vec3::new(a.cos(), a.sin(), 0.0) * r
                };
                for k in 0..20 {
                    line(p(k), p(k + 1), color, width, out);
                }
            }
        };
        const PIVOT: [f32; 3] = [1.0, 0.85, 0.3];
        const STEP: [f32; 3] = [0.3, 0.75, 1.0];
        const PATH: [f32; 3] = [0.85, 0.85, 0.85];
        ball(b.pivot, PIVOT, lit == Some(Handle::Pivot), out);
        line(b.pivot, b.arm, PIVOT, 1.0, out);
        // The path of the point beside the pivot through the copies, a dot at each.
        let mut from = b.arm;
        for (c, &p) in b.path.iter().enumerate() {
            line(from, p, PATH, 1.0, out);
            if c > 0 {
                let d = r * 0.25;
                line(p - Vec3::X * d, p + Vec3::X * d, PATH, 2.5, out);
                line(p - Vec3::Y * d, p + Vec3::Y * d, PATH, 2.5, out);
            }
            from = p;
        }
        if let Some(&s) = b.path.first() {
            ball(s, STEP, lit == Some(Handle::Step), out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vdraw_core::doc::{Frame, Kaleido};

    fn painter(depth: bool) -> (Painter, Frame) {
        let frame = Frame { anchor: [100.0, 50.0], k: 0.01, offset: Vec3::new(0.0, 1.0, -1.0) };
        let mut k = Kaleido::new(120.0, 40.0, depth, frame);
        k.set("count", 4);
        k.set("angle", 30);
        k.set("dx", 5);
        let mut p = Painter::new(vdraw_core::Painting::default());
        p.painting.layers[0].threed = depth;
        p.painting.layers[0].kaleido = Some(k);
        p.painting.layers[0].update_copies();
        p.rebuild();
        (p, frame)
    }

    fn kal(p: &Painter) -> &Kaleido {
        p.painting.layers[0].kaleido.as_ref().unwrap()
    }

    #[test]
    fn a_step_comes_back_as_it_was() {
        for depth in [false, true] {
            let (p, _) = painter(depth);
            let mut k = kal(&p).clone();
            if depth {
                k.set("turn", serde_json::json!([0.2, 0.1, 0.3, (1.0f64 - 0.04 - 0.01 - 0.09).sqrt()]));
                k.set("cz", 7.0);
                k.set("dz", -3.0);
            }
            let before = k.step();
            k.set_step_scene(k.step_scene());
            assert!((k.step() - before).to_cols_array().iter().all(|v| v.abs() < 1e-6), "{depth}: {:?}", k.effect);
            assert_eq!(k.num("angle", 0.0), if depth { 0.0 } else { 30.0 });
        }
    }

    #[test]
    fn the_hand_sets_the_step_a_part_at_a_time() {
        let (mut p, frame) = painter(false);
        let b = p.kaleido_balls().unwrap();
        let ball = b.path[0];
        let at = |pos: Vec3, turn: f32| Mat4::from_rotation_translation(Quat::from_rotation_z(turn), pos);
        // Take the step ball and move the hand 0.04 along x: the step moves a quarter of it
        // (four copies), 1 canvas unit.
        p.kaleido(0, at(ball, 0.0), true, 0.0, false, 0.01);
        p.kaleido(0, at(ball + Vec3::X * 0.04, 0.0), true, 0.0, false, 0.01);
        assert!((kal(&p).num("dx", 0.0) - 6.0).abs() < 1e-6, "{:?}", kal(&p).effect);
        // Turn the wrist 40 degrees as well (counterclockwise in the scene, clockwise on the
        // canvas, whose y runs down): the step turns 10 degrees less.
        p.kaleido(0, at(ball, 40f32.to_radians()), true, 0.0, false, 0.01);
        assert!((kal(&p).num("angle", 0.0) - 20.0).abs() < 1e-4, "{:?}", kal(&p).effect);
        // Let go; the copies follow.
        p.kaleido(0, at(ball, 0.0), false, 0.0, false, 0.01);
        assert!(p.kaleido_hold.is_none());
        assert_eq!(p.painting.layers[0].copies, kal(&p).copies());
        // The pivot follows the hand (ten times finer with the other trigger).
        let pivot = p.kaleido_balls().unwrap().pivot;
        p.kaleido(0, at(pivot, 0.0), true, 0.0, true, 0.01);
        p.kaleido(0, at(pivot + Vec3::Y * 0.1, 0.0), true, 0.0, true, 0.01);
        assert!((kal(&p).num("cy", 0.0) - 39.0).abs() < 1e-6, "{:?}", kal(&p).effect);
        p.kaleido(0, at(pivot, 0.0), false, 0.0, false, 0.01);
        // A press away from the balls takes none, also when the hand then comes to one.
        p.kaleido(0, at(Vec3::splat(5.0), 0.0), true, 0.0, false, 0.01);
        let before = kal(&p).clone();
        p.kaleido(0, at(p.kaleido_balls().unwrap().pivot, 0.0), true, 0.0, false, 0.01);
        assert_eq!(kal(&p), &before);
        let _ = frame;
    }

    #[test]
    fn on_a_3d_layer_the_wrist_tilts_the_step() {
        let (mut p, _) = painter(true);
        let ball = p.kaleido_balls().unwrap().path[0];
        p.kaleido(0, Mat4::from_translation(ball), true, 0.0, false, 0.01);
        p.kaleido(0, Mat4::from_rotation_translation(Quat::from_rotation_x(0.8), ball), true, 0.0, false, 0.01);
        assert!(kal(&p).tilts(), "{:?}", kal(&p).effect);
        let mut lines = Vec::new();
        p.kaleido_lines(Some(ball), &mut lines);
        assert!(lines.len() > 100 && lines.len() <= vdraw_render::MAX_LINES);
    }
}
