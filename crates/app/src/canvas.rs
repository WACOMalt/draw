//! A shared canvas in VR: the 2D app's document (kept live by `vdraw_net::session`), shown as
//! a painting in its own space (the scene), which sits in the room where the canvas view puts
//! it. Its strokes are flat on the paper, the plane z = 0 of the scene; the view moves, turns
//! and scales the canvas as a whole, as the 2D app pans and zooms, so moving it makes nothing
//! again.
//!
//! The scene's units are canvas units times `frame.k` (meters when the view's scale is 1). When
//! the view's scale drifts far from 1 (zoomed far in or out), the frame is anchored again where
//! the viewer is, so the scene keeps meter-like units near them (the renderer's depth and
//! precision are meant for that).

use crate::painter::Painter;
use glam::{Mat4, Quat, Vec3};
use std::collections::HashMap;
use std::time::Instant;
use vdraw_core::doc::{self, Doc, DocBrush, DocLayer, DocStroke, Frame};
use vdraw_core::{Blend, Stroke};
use vdraw_net::session::{Session, State};
use vdraw_render::OverlayLine;

/// How a drawing is placed when the canvas opens: its longer side this long (meters), its
/// middle this far in front of the head.
const FIT_SIZE: f64 = 1.1;
const FIT_DISTANCE: f32 = 1.3;
/// The frame is anchored again when the view's scale leaves this range.
const SCALE_RANGE: (f32, f32) = (0.25, 4.0);
/// Changes to strokes beyond this many make the painting again at once.
const MAX_INCREMENTAL: usize = 400;

/// A stroke as shown, by its document id: enough of it to see that it changed (moved by a
/// layer transform, ...).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Print {
    id: String,
    n: usize,
    ends: [u64; 4],
    size: u64,
}

fn print(s: &DocStroke) -> Print {
    let p = &s.pts;
    let at = |i: usize| p.get(i).copied().unwrap_or(0.0).to_bits();
    let last = p.len().saturating_sub(3);
    Print { id: s.id.clone(), n: p.len(), ends: [at(0), at(1), at(last), at(last + 1)], size: s.brush.size.to_bits() }
}

/// A painting layer's document layer, and its strokes and its mask's as shown, in order.
#[derive(Clone, Debug, Default)]
struct Shown {
    id: String,
    mask_id: Option<String>,
    strokes: Vec<Print>,
    mask: Vec<Print>,
}

/// What of the layers needs the painting made again when it changes (their tree and kinds).
#[derive(Clone, Debug, PartialEq)]
struct Form {
    id: String,
    group: bool,
    parent: Option<String>,
    clip: bool,
    mask: Option<String>,
}

fn form(l: &DocLayer) -> Form {
    Form { id: l.id.clone(), group: l.is_group(), parent: l.parent.clone(), clip: l.clip.unwrap_or(false), mask: l.mask.as_ref().map(|m| m.id.clone()) }
}

/// Another user's stroke being drawn, as last converted (made again when points come).
struct Live {
    points: usize,
    layer: usize,
    mask: bool,
    stroke: Stroke,
}

pub struct Canvas {
    pub session: Session,
    pub frame: Frame,
    /// The scene in the room (world from scene): a move, a turn and one scale.
    pub view: Mat4,
    /// Placed in front of the viewer yet (when the document first comes).
    pub placed: bool,
    shown: Vec<Shown>,
    forms: Vec<Form>,
    lives: HashMap<(String, String), Live>,
    /// The paper (sRGB, alpha).
    pub paper: [f32; 4],
    /// The hands holding the canvas (world poses when they took hold, or last frame).
    held: [Option<Mat4>; 2],
    /// When the canvas last moved (a see-through paper's grid shows a while after).
    pub moved_at: Option<Instant>,
    /// Where this user points on the paper, as last sent (canvas units), and when.
    cursor: (Option<(f64, f64)>, Instant),
}

impl Canvas {
    pub fn new(session: Session) -> Self {
        Self {
            session,
            frame: Frame { anchor: [0.0, 0.0], k: 0.001, offset: Vec3::ZERO },
            view: Mat4::IDENTITY,
            placed: false,
            shown: Vec::new(),
            forms: Vec::new(),
            lives: HashMap::new(),
            paper: [1.0, 1.0, 1.0, 1.0],
            held: [None; 2],
            moved_at: None,
            cursor: (None, Instant::now()),
        }
    }

    /// The view's scale: meters per scene unit.
    pub fn scale(&self) -> f32 {
        self.view.x_axis.truncate().length()
    }

    /// The document layer of a painting layer (by place); None for the empty canvas's stand-in.
    pub fn doc_layer(&self, place: usize) -> Option<&str> {
        self.shown.get(place).map(|s| s.id.as_str()).filter(|id| !id.is_empty())
    }

    /// Takes in what came from the server, and brings the painter's painting up to date.
    /// `head`: the head's pose (world), to place the canvas in front of it when it first
    /// comes. Returns whether the document changed.
    pub fn update(&mut self, painter: &mut Painter, head: Mat4) -> bool {
        let changes = self.session.poll();
        for (_, why) in &changes.rejected {
            log::warn!("the server refused an edit: {why}");
        }
        if !changes.doc {
            return false;
        }
        if !self.placed {
            self.place(head);
        }
        self.sync(painter);
        true
    }

    /// Fits the drawing in front of the head: the frame anchored at its middle, a scale that
    /// makes its longer side `FIT_SIZE`, upright, facing the head.
    fn place(&mut self, head: Mat4) {
        let doc = self.session.view();
        let b = doc.bounds().unwrap_or([0.0, 0.0, 1000.0, 1000.0]);
        let side = ((b[2] - b[0]).max(b[3] - b[1]) * 1.08).max(1e-30);
        self.frame = Frame { anchor: [(b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5], k: FIT_SIZE / side, offset: Vec3::ZERO };
        let eye = head.w_axis.truncate();
        let forward = (-head.z_axis.truncate()).with_y(0.0).try_normalize().unwrap_or(Vec3::NEG_Z);
        let center = eye + forward * FIT_DISTANCE;
        // The paper's normal (+z of the scene) faces the head.
        let yaw = (-forward.x).atan2(-forward.z);
        self.view = Mat4::from_rotation_translation(Quat::from_rotation_y(yaw), center);
        self.placed = true;
        self.shown.clear();
        self.forms.clear();
    }

    /// The painting made again from the document, the active layer kept (by its document id).
    fn rebuild_all(&mut self, painter: &mut Painter, doc: &Doc) {
        let active = painter.painting.index_of(painter.active_layer).and_then(|i| self.shown.get(i)).map(|s| s.id.clone());
        let converted = doc.painting(&self.frame);
        let place = active.and_then(|a| converted.layer_ids.iter().position(|id| *id == a));
        let active_id = place.or_else(|| converted.painting.layers.iter().rposition(|l| !l.group)).map_or(0, |i| converted.painting.layers[i].id);
        let layers = doc.painted_layers();
        self.forms = layers.iter().map(|l| form(l)).collect();
        self.shown = converted
            .layer_ids
            .iter()
            .map(|id| match doc.layers.get(id) {
                Some(l) => Shown {
                    id: id.clone(),
                    mask_id: l.mask.as_ref().map(|m| m.id.clone()),
                    strokes: doc.strokes_of(id, None).into_iter().map(print).collect(),
                    mask: l.mask.as_ref().map(|m| doc.strokes_of(id, Some(&m.id)).into_iter().map(print).collect()).unwrap_or_default(),
                },
                None => Shown::default(),
            })
            .collect();
        painter.replace_painting(converted.painting, active_id);
        self.lives.clear();
    }

    /// Brings the painting up to date with the document: made again when the layers' tree
    /// changed; else their settings set in place, and the strokes that came or went put in or
    /// taken out one by one.
    fn sync(&mut self, painter: &mut Painter) {
        let doc = self.session.view().clone();
        let layers = doc.painted_layers();
        let forms: Vec<Form> = layers.iter().map(|l| form(l)).collect();
        if forms != self.forms || self.shown.len() != painter.painting.layers.len() || layers.is_empty() {
            self.rebuild_all(painter, &doc);
            self.paper = paper_of(&doc);
            return;
        }
        self.paper = paper_of(&doc);
        painter.painting.mix = if doc.mix == "pigment" { vdraw_core::Mix::Pigment } else { vdraw_core::Mix::Normal };
        // The layers' settings, in place. Showing or hiding one (or its mask) changes the
        // steps: then the strokes go in by hand, and the painting builds again.
        let mut steps_changed = false;
        for (i, l) in layers.iter().enumerate() {
            let p = &mut painter.painting.layers[i];
            p.name.clone_from(&l.name);
            p.blend = Blend::from_name(&l.blend);
            p.opacity = l.opacity as f32;
            if p.visible != l.visible {
                p.visible = l.visible;
                steps_changed = true;
            }
            if let (Some(m), Some(dm)) = (p.mask.as_mut(), l.mask.as_ref()) {
                if m.enabled != dm.enabled {
                    m.enabled = dm.enabled;
                    steps_changed = true;
                }
            }
        }
        // The strokes: those gone or changed out, then those new in, by place.
        let mut edits = 0;
        let mut plans = Vec::new();
        for (i, l) in layers.iter().enumerate() {
            for mask in [false, true] {
                let want: Vec<&DocStroke> = match (mask, &self.shown[i].mask_id) {
                    (false, _) => doc.strokes_of(&l.id, None),
                    (true, Some(m)) => doc.strokes_of(&l.id, Some(m)),
                    (true, None) => continue,
                };
                let have = if mask { &self.shown[i].mask } else { &self.shown[i].strokes };
                if have.len() == want.len() && have.iter().zip(&want).all(|(h, w)| *h == print(w)) {
                    continue;
                }
                let prints: Vec<Print> = want.iter().map(|s| print(s)).collect();
                let keep: std::collections::HashSet<&Print> = prints.iter().collect();
                let out: Vec<usize> = (0..have.len()).filter(|&k| !keep.contains(&have[k])).collect();
                let left: Vec<&Print> = have.iter().filter(|h| keep.contains(h)).collect();
                // What is left must come in the order wanted, or it all builds again.
                let mut k = 0;
                let mut ins = Vec::new();
                for (j, p) in prints.iter().enumerate() {
                    if k < left.len() && *left[k] == *p {
                        k += 1;
                    } else {
                        ins.push(j);
                    }
                }
                if k != left.len() {
                    edits = usize::MAX;
                    break;
                }
                edits += out.len() + ins.len();
                plans.push((i, mask, out, ins, want.iter().map(|s| (*s).clone()).collect::<Vec<_>>(), prints));
            }
        }
        if edits > MAX_INCREMENTAL {
            self.rebuild_all(painter, &doc);
            return;
        }
        for (i, mask, out, ins, want, prints) in plans {
            let ordered_in = |painter: &mut Painter, j: usize, s: &DocStroke, frame: &Frame| {
                let stroke = doc::stroke(&s.id, &s.brush, &s.pts, frame);
                if steps_changed {
                    let p = &mut painter.painting.layers[i];
                    let list = if mask { &mut p.mask.as_mut().unwrap().strokes } else { &mut p.strokes };
                    list.insert(j.min(list.len()), stroke);
                } else {
                    painter.insert_stroke(i, mask, j, stroke);
                }
            };
            for &k in out.iter().rev() {
                if steps_changed {
                    let p = &mut painter.painting.layers[i];
                    let list = if mask { &mut p.mask.as_mut().unwrap().strokes } else { &mut p.strokes };
                    list.remove(k);
                } else {
                    painter.remove_stroke(i, mask, k);
                }
            }
            for &j in &ins {
                ordered_in(painter, j, &want[j], &self.frame);
            }
            if mask {
                self.shown[i].mask = prints;
            } else {
                self.shown[i].strokes = prints;
            }
        }
        if steps_changed {
            painter.rebuild();
        }
    }

    /// Others' strokes being drawn, into the painter's strokes being drawn (call after
    /// `Painter::update_drawing`).
    pub fn draw_live(&mut self, painter: &mut Painter) {
        let lives = &self.session.lives;
        self.lives.retain(|k, _| lives.contains_key(k));
        let mut keys: Vec<&(String, String)> = lives.keys().collect();
        keys.sort();
        for (n, key) in keys.into_iter().enumerate() {
            let l = &lives[key];
            let fresh = self.lives.get(key).is_none_or(|c| c.points != l.pts.len());
            if fresh {
                let Some(layer) = self.shown.iter().position(|s| s.id == l.layer_id) else { continue };
                let mask = l.mask.is_some();
                if mask && l.mask != self.shown[layer].mask_id {
                    continue;
                }
                let Ok(brush) = serde_json::from_value::<DocBrush>(l.brush.clone()) else { continue };
                let stroke = doc::stroke(&l.id, &brush, &l.pts, &self.frame);
                self.lives.insert(key.clone(), Live { points: l.pts.len(), layer, mask, stroke });
            }
            if let Some(c) = self.lives.get(key) {
                if !c.stroke.samples.is_empty() {
                    painter.add_drawing(c.layer, c.mask, &c.stroke, n as u32);
                }
            }
        }
    }

    /// Others' pointers on the paper: a ring each, in their color (lines, in the scene).
    pub fn cursor_lines(&self, out: &mut Vec<OverlayLine>) {
        let r = 0.012 / self.scale();
        for p in self.session.peers.values() {
            let Some((x, y)) = p.cursor else { continue };
            let c = crate::panel::to_linear(doc::hex_rgb(&p.color));
            let center = self.frame.point(x, y, 0.0);
            const N: usize = 16;
            for k in 0..N {
                let a = |k: usize| {
                    let t = k as f32 / N as f32 * std::f32::consts::TAU;
                    center + Vec3::new(t.cos(), t.sin(), 0.0) * r
                };
                let (p0, p1) = (a(k), a(k + 1));
                out.push(OverlayLine { a: [p0.x, p0.y, p0.z, 3.0], b: [p1.x, p1.y, p1.z, 6.0], color: [c[0], c[1], c[2], 1.0], halo: [0.0, 0.0, 0.0, 0.6] });
            }
        }
    }

    /// Where a ray (world) meets the paper, in canvas units (None: it does not, in front).
    pub fn paper_point(&self, from: Vec3, dir: Vec3) -> Option<(f64, f64)> {
        let inv = self.view.inverse();
        let (o, d) = (inv.transform_point3(from), inv.transform_vector3(dir));
        if d.z.abs() < 1e-9 {
            return None;
        }
        let t = -o.z / d.z;
        (t > 0.0).then(|| {
            let c = self.frame.canvas(o + d * t);
            (c[0], c[1])
        })
    }

    /// Tells the others where this user points on the paper (at most 25 times a second, and
    /// when it changed).
    pub fn send_cursor(&mut self, at: Option<(f64, f64)>, layer: Option<&str>) {
        if at == self.cursor.0 || self.cursor.1.elapsed().as_secs_f32() < 0.04 || self.session.state != State::Open {
            return;
        }
        self.session.send_cursor(at, layer);
        self.cursor = (at, Instant::now());
    }

    /// The hands' grips, each frame: one hand holding drags the canvas; two hands move, turn
    /// and scale it (the two points under the hands stay under them). `poses`: the hands
    /// (world); `held`: their grips. Returns whether it is held.
    pub fn navigate(&mut self, painter: &mut Painter, poses: [Option<Mat4>; 2], held: [bool; 2]) -> bool {
        let now: [Option<Mat4>; 2] = [0, 1].map(|h| poses[h].filter(|_| held[h]));
        let was = self.held;
        let delta = match (was, now) {
            ([Some(a0), Some(b0)], [Some(a1), Some(b1)]) => {
                let (a0, b0, a1, b1) = (a0.w_axis.truncate(), b0.w_axis.truncate(), a1.w_axis.truncate(), b1.w_axis.truncate());
                let (v0, v1) = (b0 - a0, b1 - a1);
                let s = (v1.length() / v0.length().max(1e-4)).clamp(0.5, 2.0);
                let turn = Quat::from_rotation_arc(v0.normalize_or(Vec3::X), v1.normalize_or(Vec3::X));
                let (m0, m1) = ((a0 + b0) * 0.5, (a1 + b1) * 0.5);
                Some(Mat4::from_translation(m1) * Mat4::from_quat(turn) * Mat4::from_scale(Vec3::splat(s)) * Mat4::from_translation(-m0))
            }
            ([Some(a0), _], [Some(a1), None]) | ([_, Some(a0)], [None, Some(a1)]) if was.iter().flatten().count() == 1 || now.iter().flatten().count() == 1 => {
                Some(Mat4::from_translation(a1.w_axis.truncate() - a0.w_axis.truncate()))
            }
            _ => None,
        };
        if let Some(d) = delta {
            self.view = d * self.view;
            self.moved_at = Some(Instant::now());
        }
        self.held = now;
        let holding = now.iter().any(Option::is_some);
        // Let go far from a scale of 1: anchored again near the viewer.
        if !holding && was.iter().any(Option::is_some) && painter.active.is_none() {
            let s = self.scale();
            if s < SCALE_RANGE.0 || s > SCALE_RANGE.1 {
                self.anchor_again(painter, poses.iter().flatten().next().map(|p| p.w_axis.truncate()));
            }
        }
        holding
    }

    /// Anchors the frame again: at the paper point nearest `near` (world; or the scene's
    /// origin), with the view's scale taken into the frame (the view's scale is 1 after).
    fn anchor_again(&mut self, painter: &mut Painter, near: Option<Vec3>) {
        let s = self.scale() as f64;
        let inv = self.view.inverse();
        let p = near.map_or(Vec3::ZERO, |n| inv.transform_point3(n)).with_z(0.0);
        let c = self.frame.canvas(p);
        let new = Frame { anchor: [c[0], c[1]], k: self.frame.k * s, offset: Vec3::ZERO };
        // Old scene from new: p_old = p_new / s + (the new anchor in the old scene).
        let at_old = self.frame.point(c[0], c[1], 0.0);
        self.view = self.view * Mat4::from_translation(at_old) * Mat4::from_scale(Vec3::splat((1.0 / s) as f32));
        self.frame = new;
        let doc = self.session.view().clone();
        self.rebuild_all(painter, &doc);
        log::info!("canvas anchored again at ({:.3}, {:.3}), {:.3e} m per canvas unit", c[0], c[1], self.frame.k);
    }

    /// How much a see-through paper's grid shows: while the canvas is held, and fading after.
    pub fn grid(&self) -> f32 {
        if self.held.iter().any(Option::is_some) {
            return 1.0;
        }
        self.moved_at.map_or(0.0, |t| (1.0 - t.elapsed().as_secs_f32() / 0.8).max(0.0))
    }
}

/// The document's paper as sRGB and alpha.
fn paper_of(doc: &Doc) -> [f32; 4] {
    let c = doc::hex_rgb(&doc.paper.color);
    [c[0], c[1], c[2], doc.paper.alpha.clamp(0.0, 1.0) as f32]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    /// The painting as built from scratch: its segments' bytes and the stroke places.
    fn fresh(p: &Painter) -> (Vec<u8>, Vec<vdraw_core::StrokeRef>) {
        let mut segs = Vec::new();
        let built = p.painting.build(&mut segs);
        (bytemuck::cast_slice(&segs).to_vec(), built.strokes)
    }

    fn current(p: &Painter) -> (Vec<u8>, Vec<vdraw_core::StrokeRef>) {
        (bytemuck::cast_slice(&p.done).to_vec(), p.built.strokes.clone())
    }

    /// A canvas kept live while another client edits it, on a test server ($VDRAW_TEST_SERVER,
    /// as in vdraw-net's tests; skipped without one): strokes added and removed go in and out
    /// one by one, and the painting is always as a fresh build of the document would be.
    #[test]
    fn a_live_canvas_follows_the_edits_of_others() {
        let Ok(base) = std::env::var("VDRAW_TEST_SERVER") else { return };
        let server = vdraw_net::Server::new(&base, None);
        let anon = vdraw_net::identity::base64url(&[9u8; 32]);
        let key = server.create(&anon, None, None).unwrap();
        let mut c = Canvas::new(Session::open(&server, &key, "VR", "#ff6b6b", &anon, None));
        let mut other = Session::open(&server, &key, "2D", "#4dabf7", &anon, None);
        let mut painter = Painter::new(vdraw_core::Painting::default());
        let head = Mat4::from_translation(Vec3::new(0.0, 1.6, 0.0));
        let until = |c: &mut Canvas, painter: &mut Painter, other: &mut Session, what: &str, done: &dyn Fn(&Canvas, &Painter) -> bool| {
            let t = Instant::now();
            loop {
                other.poll();
                c.update(painter, head);
                if done(c, painter) {
                    break;
                }
                assert!(t.elapsed() < Duration::from_secs(5), "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        until(&mut c, &mut painter, &mut other, "the document", &|c, _| c.placed && c.session.state == State::Open);
        until(&mut c, &mut painter, &mut other, "the other's welcome", &|_, _| true);
        while other.state != State::Open {
            other.poll();
            std::thread::sleep(Duration::from_millis(10));
        }
        let layer = other.doc.paint_order()[0].id.clone();
        // A second layer, above: the painting is made again (the layers changed).
        other.send_op(json!({"type": "layer.add", "layer": {"id": "L2bbbbbbbbbb", "name": "Top", "order": 9.0, "blend": "normal", "opacity": 1.0, "visible": true}}));
        until(&mut c, &mut painter, &mut other, "the new layer", &|_, p| p.painting.layers.len() == 2);
        let brush = json!({"tool": "paint", "color": "#aa3311", "size": 12.0, "opacity": 1.0, "flow": 1.0, "hardness": 0.8, "spacing": 0.1, "pressureSize": true, "pressureFlow": false, "buildup": false});
        let mut ids = Vec::new();
        for k in 0..6 {
            let id = format!("S{k}cccccccccc");
            let on = if k % 2 == 0 { &layer } else { "L2bbbbbbbbbb" };
            other.send_op(json!({"type": "stroke.add", "stroke": {"id": id, "layerId": on, "brush": brush, "pts": [k as f64 * 20.0, 0.0, 0.5, k as f64 * 20.0 + 15.0, 30.0, 0.7]}}));
            ids.push(id);
        }
        until(&mut c, &mut painter, &mut other, "six strokes", &|_, p| p.built.strokes.len() == 6);
        // In one by one (the layers did not change): as a fresh build.
        assert_eq!(current(&painter), fresh(&painter));
        let version = painter.version;
        other.send_op(json!({"type": "stroke.remove", "id": ids[2]}));
        other.send_op(json!({"type": "stroke.remove", "id": ids[3]}));
        until(&mut c, &mut painter, &mut other, "two strokes gone", &|_, p| p.built.strokes.len() == 4);
        assert_eq!(current(&painter), fresh(&painter));
        assert!(painter.version > version);
        // Hiding a layer, and its settings.
        other.send_op(json!({"type": "layer.update", "id": "L2bbbbbbbbbb", "props": {"visible": false, "opacity": 0.5}}));
        until(&mut c, &mut painter, &mut other, "the layer hidden", &|_, p| !p.painting.layers[1].visible);
        assert_eq!(painter.painting.layers[1].opacity, 0.5);
        assert_eq!(current(&painter), fresh(&painter));
        assert_eq!(painter.built.strokes.len(), 2);
        // Another's stroke being drawn shows over the layer's strokes.
        other.send_live("Slivecccccccc", &layer, None, &brush, &[0.0, 50.0, 0.5, 30.0, 60.0, 0.5], true);
        until(&mut c, &mut painter, &mut other, "the live stroke", &|c, _| !c.session.lives.is_empty());
        painter.update_drawing();
        c.draw_live(&mut painter);
        assert_eq!(painter.drawing_runs.len(), 1);
        assert!(!painter.drawing.is_empty());
        c.session.close();
        other.close();
    }
}
