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

use crate::painter::{Outgoing, Painter};
use serde_json::{Value, json};
use glam::{Mat4, Quat, Vec3};
use std::collections::HashMap;
use std::time::Instant;
use vdraw_core::doc::{self, Doc, DocBrush, DocLayer, DocStroke, Frame, StrokeVr};
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
    /// The depth at the ends (a VR layer's stroke moved toward or away from the paper).
    depth: [u64; 2],
    size: u64,
}

fn print(s: &DocStroke) -> Print {
    let p = &s.pts;
    let at = |i: usize| p.get(i).copied().unwrap_or(0.0).to_bits();
    let last = p.len().saturating_sub(3);
    let z = |i: usize| s.vr.as_ref().and_then(|v| v.z.get(i)).copied().unwrap_or(0.0).to_bits();
    Print { id: s.id.clone(), n: p.len(), ends: [at(0), at(1), at(last), at(last + 1)], depth: [z(0), z((p.len() / 3).saturating_sub(1))], size: s.brush.size.to_bits() }
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
    vr: bool,
}

fn form(l: &DocLayer) -> Form {
    Form { id: l.id.clone(), group: l.is_group(), parent: l.parent.clone(), clip: l.clip.unwrap_or(false), mask: l.mask.as_ref().map(|m| m.id.clone()), vr: l.vr }
}

/// A layer as the panel edits it (no strokes): what a layer edit changed is sent as ops.
#[derive(Clone, Debug, PartialEq)]
struct Meta {
    id: u32,
    name: String,
    blend: Blend,
    opacity: f32,
    visible: bool,
    group: bool,
    parent: Option<u32>,
    clip: bool,
    mask: Option<bool>,
    /// A VR layer (its strokes in 3D).
    vr: bool,
}

fn metas(p: &vdraw_core::Painting) -> Vec<Meta> {
    p.layers
        .iter()
        .map(|l| Meta { id: l.id, name: l.name.clone(), blend: l.blend, opacity: l.opacity, visible: l.visible, group: l.group, parent: l.parent, clip: l.clip, mask: l.mask.as_ref().map(|m| m.enabled), vr: !l.ordered && !l.group })
        .collect()
}

/// A blend mode's name in the document ("normal", "color-burn", "pass", ...).
fn blend_name(b: Blend) -> Value {
    serde_json::to_value(b).unwrap_or_else(|_| "normal".into())
}

/// A brush setting as the document has it: four decimals.
fn r4(x: f32) -> f64 {
    (x as f64 * 1e4).round() / 1e4
}

/// The opposite of an affine ([a, b, c, d, e, f], as the 2D app's).
fn invert_affine(m: &[f64; 6]) -> Option<[f64; 6]> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-300 {
        return None;
    }
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    Some([a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])])
}

/// One step of undo: the ops that take an action back, and those that do it again (the 2D
/// app's undo entries).
#[derive(Default)]
struct UndoStep {
    undo: Vec<Value>,
    redo: Vec<Value>,
}

/// The longest run of increasing values, as places (for orders kept when layers move).
fn increasing(v: &[f64]) -> Vec<usize> {
    let n = v.len();
    let mut len = vec![1usize; n];
    let mut prev = vec![usize::MAX; n];
    for i in 0..n {
        for j in 0..i {
            if v[j] < v[i] && len[j] + 1 > len[i] {
                len[i] = len[j] + 1;
                prev[i] = j;
            }
        }
    }
    let Some(mut at) = (0..n).max_by_key(|&i| len[i]) else { return Vec::new() };
    let mut out = vec![at];
    while prev[at] != usize::MAX {
        at = prev[at];
        out.push(at);
    }
    out.reverse();
    out
}

/// A painting made again from the document on a thread of its own (a big canvas takes a
/// tenth of a second): the frame it is made in, and the old scene from the new one (when the
/// frame is anchored again).
struct Rebuild {
    rx: std::sync::mpsc::Receiver<Remade>,
    frame: Frame,
    old_from_new: Mat4,
}

/// What a rebuild made: the painting, its segments, and the document as shown in it.
struct Remade {
    converted: doc::Converted,
    done: Vec<vdraw_core::GpuSegment>,
    built: vdraw_core::Built,
    forms: Vec<Form>,
    shown: Vec<Shown>,
}

impl Remade {
    fn make(doc: &Doc, frame: &Frame) -> Self {
        let converted = doc.painting(frame);
        let mut done = Vec::new();
        let built = converted.painting.build(&mut done);
        let forms = doc.painted_layers().iter().map(|l| form(l)).collect();
        let shown = converted
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
        Self { converted, done, built, forms, shown }
    }
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
    /// The painting's layer ids by document layer id, kept from one making to the next (so
    /// the panel's ids stay), and the next free one.
    ids: HashMap<String, u32>,
    next_id: u32,
    /// The layers as last made from the document: the panel's edits are what differs.
    synced: Vec<Meta>,
    /// Undo and redo, as the 2D app's: steps of ops.
    undo: Vec<UndoStep>,
    redo: Vec<UndoStep>,
    /// The stroke being drawn as the others see it: its id, the points sent, if it started,
    /// and when they were sent.
    live: (String, usize, bool, Instant),
    /// The layer (by document id) to make active once the document has it.
    want_active: Option<String>,
    rebuild: Option<Rebuild>,
    /// A painting of the document is in (what this user does can be sent).
    ready: bool,
    /// When the paper was last sent.
    paper_sent: Instant,
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
            ids: HashMap::new(),
            next_id: 1,
            synced: Vec::new(),
            undo: Vec::new(),
            redo: Vec::new(),
            live: (String::new(), 0, false, Instant::now()),
            want_active: None,
            rebuild: None,
            ready: false,
            paper_sent: Instant::now(),
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
        let remade = self.rebuild.as_ref().and_then(|r| r.rx.try_recv().ok());
        if let Some(r) = remade {
            self.apply(painter, r);
        } else if !changes.doc {
            return false;
        }
        if !self.placed {
            self.place(head);
        }
        self.sync(painter);
        true
    }

    /// A painting being made again (until it is, the last one shows, and changes wait).
    pub fn rebuilding(&self) -> bool {
        self.rebuild.is_some()
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

    /// The painting made again from the document, on a thread: in the frame it is going to
    /// (`frame` when it is anchored again, with the old scene from the new one).
    fn rebuild_all(&mut self, doc: &Doc) {
        let (frame, old_from_new) = self.rebuild.as_ref().map_or((self.frame, Mat4::IDENTITY), |r| (r.frame, r.old_from_new));
        self.start_rebuild(doc, frame, old_from_new);
    }

    fn start_rebuild(&mut self, doc: &Doc, frame: Frame, old_from_new: Mat4) {
        let (tx, rx) = std::sync::mpsc::channel();
        let doc = doc.clone();
        std::thread::spawn(move || {
            let t = Instant::now();
            let remade = Remade::make(&doc, &frame);
            log::debug!("canvas made again: {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
            let _ = tx.send(remade);
        });
        // A rebuild under way is dropped: this one is of a newer document.
        self.rebuild = Some(Rebuild { rx, frame, old_from_new });
    }

    /// A rebuild made: the painting in place of the last one, its layers keeping their ids, the
    /// active layer kept (by its document id).
    fn apply(&mut self, painter: &mut Painter, r: Remade) {
        let job = self.rebuild.take().expect("a rebuild under way");
        let active = painter.painting.index_of(painter.active_layer).and_then(|i| self.shown.get(i)).map(|s| s.id.clone());
        let mut converted = r.converted;
        // The layers keep the ids they had (a new one gets the next free id).
        let mut numbers: Vec<u32> = converted.layer_ids.iter().map(|id| self.number(id)).collect();
        // (Two layers with one number: the later gets a new one.)
        for k in 0..numbers.len() {
            if numbers[..k].contains(&numbers[k]) {
                numbers[k] = self.next_id;
                self.next_id += 1;
                self.ids.insert(converted.layer_ids[k].clone(), numbers[k]);
            }
        }
        let old: Vec<u32> = converted.painting.layers.iter().map(|l| l.id).collect();
        for l in &mut converted.painting.layers {
            l.id = numbers[old.iter().position(|&o| o == l.id).unwrap()];
            l.parent = l.parent.and_then(|p| old.iter().position(|&o| o == p)).map(|k| numbers[k]);
        }
        let active = self.want_active.take().or(active);
        let place = active.and_then(|a| converted.layer_ids.iter().position(|id| *id == a));
        let active_id = place.or_else(|| converted.painting.layers.iter().rposition(|l| !l.group)).map_or(0, |i| converted.painting.layers[i].id);
        // Anchored again: the view and the stroke being drawn follow into the new scene.
        if job.old_from_new != Mat4::IDENTITY {
            self.view *= job.old_from_new;
            painter.move_drawing(job.old_from_new.inverse());
        }
        self.frame = job.frame;
        self.forms = r.forms;
        self.shown = r.shown;
        painter.replace_built(converted.painting, r.done, r.built, active_id);
        painter.shared = true;
        self.synced = metas(&painter.painting);
        self.lives.clear();
        self.ready = true;
    }

    /// The painting's layer id of a document layer.
    fn number(&mut self, doc_id: &str) -> u32 {
        if let Some(&n) = self.ids.get(doc_id) {
            return n;
        }
        let n = self.next_id;
        self.next_id += 1;
        self.ids.insert(doc_id.to_string(), n);
        n
    }

    /// The document layer of a painting layer id.
    fn doc_id(&self, id: u32) -> Option<String> {
        self.ids.iter().find(|(_, n)| **n == id).map(|(d, _)| d.clone()).filter(|d| !d.is_empty())
    }

    /// Brings the painting up to date with the document: made again when the layers' tree
    /// changed; else their settings set in place, and the strokes that came or went put in or
    /// taken out one by one.
    fn sync(&mut self, painter: &mut Painter) {
        if self.rebuilding() {
            // It catches up when the rebuild is in.
            return;
        }
        let doc = self.session.view().clone();
        let layers = doc.painted_layers();
        let forms: Vec<Form> = layers.iter().map(|l| form(l)).collect();
        if forms != self.forms || self.shown.len() != painter.painting.layers.len() || layers.is_empty() {
            self.rebuild_all(&doc);
            self.take_paper(painter, &doc);
            return;
        }
        self.take_paper(painter, &doc);
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
            self.rebuild_all(&doc);
            return;
        }
        for (i, mask, out, ins, want, prints) in plans {
            // (A flat layer's strokes lie on the paper.)
            let depth = layers[i].vr;
            let ordered_in = |painter: &mut Painter, j: usize, s: &DocStroke, frame: &Frame| {
                let stroke = doc::stroke(&s.id, &s.brush, &s.pts, s.vr.as_ref().filter(|_| depth), frame);
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
        if let Some(a) = self.want_active.take() {
            match self.ids.get(&a) {
                Some(&n) => painter.active_layer = n,
                None => self.want_active = Some(a),
            }
        }
        self.synced = metas(&painter.painting);
    }

    /// The document's paper, when it changed: the panel's too.
    fn take_paper(&mut self, painter: &mut Painter, doc: &Doc) {
        let paper = paper_of(doc);
        if paper != self.paper {
            self.paper = paper;
            painter.paper = paper;
        }
    }

    // ---- What this user does, as ops (as the 2D app sends them). ----

    /// A finished stroke as the document has it: its points on the paper (canvas units,
    /// rounded to a tenth of what a pixel shows at this zoom, as the 2D app does), and its
    /// brush as the 2D app's.
    fn doc_stroke(&self, painter: &Painter, id: &str, layer: &str, mask: Option<&str>, stroke: &Stroke, depth: bool) -> Value {
        let brush = self.doc_brush(painter, &stroke.brush);
        let (pts, vr) = self.doc_points(&stroke.samples[..stroke.samples.len().min(20_000)], depth);
        let mut s = json!({ "id": id, "layerId": layer, "brush": brush, "pts": pts });
        if let Some(m) = mask {
            s["mask"] = m.into();
        }
        if let Some(v) = vr {
            s["vr"] = serde_json::to_value(v).unwrap_or(Value::Null);
        }
        s
    }

    /// Points as the document has them (x, y, pressure), and with `depth` (a VR layer's
    /// stroke) their depth and the pen's up sides.
    fn doc_points(&self, samples: &[vdraw_core::Sample], depth: bool) -> (Vec<f64>, Option<StrokeVr>) {
        // A pixel at arm's length is about half a millimeter.
        let device_scale = self.frame.k * self.scale() as f64 / 0.0005;
        let d = doc::point_decimals(device_scale);
        let mut out = Vec::with_capacity(samples.len() * 3);
        let mut z = Vec::new();
        let mut up = Vec::new();
        let r3 = |v: f32| (v.clamp(-1.0, 1.0) as f64 * 1000.0).round() / 1000.0;
        for s in samples {
            let c = self.frame.canvas(s.pos);
            out.extend([doc::round_to(c[0], d), doc::round_to(c[1], d), (s.pressure.clamp(0.0, 1.0) as f64 * 1000.0).round() / 1000.0]);
            if depth {
                z.push(doc::round_to(c[2], d));
                // Canvas axes: y runs down.
                up.extend([r3(s.up.x), r3(-s.up.y), r3(s.up.z)]);
            }
        }
        (out, depth.then_some(StrokeVr { z, up: Some(up) }))
    }

    /// A scene matrix held to the paper's plane as the 2D app's affine on canvas units
    /// ([a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f).
    fn affine(&self, m: Mat4) -> [f64; 6] {
        // Canvas to scene (2D): s = P c, with P = [k, 0, -ax k; 0, -k, ay k].
        let (k, ax, ay) = (self.frame.k, self.frame.anchor[0], self.frame.anchor[1]);
        let p = glam::DMat3::from_cols(glam::DVec3::new(k, 0.0, 0.0), glam::DVec3::new(0.0, -k, 0.0), glam::DVec3::new(-ax * k, ay * k, 1.0));
        let g = glam::DMat3::from_cols(
            glam::DVec3::new(m.x_axis.x as f64, m.x_axis.y as f64, 0.0),
            glam::DVec3::new(m.y_axis.x as f64, m.y_axis.y as f64, 0.0),
            glam::DVec3::new(m.w_axis.x as f64, m.w_axis.y as f64, 1.0),
        );
        let c = p.inverse() * g * p;
        [c.x_axis.x, c.x_axis.y, c.y_axis.x, c.y_axis.y, c.z_axis.x, c.z_axis.y]
    }

    /// A scene matrix (a similarity) as the 2D app's 3D affine on canvas units, column-major
    /// 3x4 (x' = m[0] x + m[3] y + m[6] z + m[9], ...), and its opposite.
    fn affine_3d(&self, m: Mat4) -> ([f64; 12], [f64; 12]) {
        // Canvas to scene: s = offset + diag(k, -k, k) (c - (ax, ay, 0)).
        let (k, ax, ay, o) = (self.frame.k, self.frame.anchor[0], self.frame.anchor[1], self.frame.offset.as_dvec3());
        let p = glam::DMat4::from_translation(o + glam::DVec3::new(-ax * k, ay * k, 0.0)) * glam::DMat4::from_scale(glam::DVec3::new(k, -k, k));
        // In f64, its turn made exactly a turn and its scale one scale (the server checks them
        // to a millionth; an f32 matrix may be off by more).
        let g = m.as_dmat4();
        let lin = glam::DMat3::from_mat4(g);
        let scale = lin.determinant().abs().cbrt();
        let turn = glam::DQuat::from_mat3(&(lin * (1.0 / scale.max(1e-300)))).normalize();
        let g = glam::DMat4::from_scale_rotation_translation(glam::DVec3::splat(scale), turn, g.w_axis.truncate());
        let c = p.inverse() * g * p;
        let cols = |c: glam::DMat4| {
            let mut out = [0.0; 12];
            for (j, col) in [c.x_axis, c.y_axis, c.z_axis, c.w_axis].iter().enumerate() {
                out[3 * j..3 * j + 3].copy_from_slice(&[col.x, col.y, col.z]);
            }
            out
        };
        (cols(c), cols(c.inverse()))
    }

    /// Whether strokes on a painting layer (by id) are 3D (a VR layer).
    fn is_vr_layer(painter: &Painter, layer: u32) -> bool {
        painter.painting.index_of(layer).is_some_and(|i| !painter.painting.layers[i].ordered && !painter.painting.layers[i].group)
    }

    fn doc_brush(&self, painter: &Painter, b: &vdraw_core::Brush) -> Value {
        let c = crate::panel::to_srgb(b.color);
        let hex = crate::palettes::to_hex(c);
        // In the ranges the server takes (validate.ts).
        let angle = painter.tools.angle[if b.erase { 1 } else { 0 }].rem_euclid(360.0);
        let size = (2.0 * b.radius as f64 / self.frame.k).clamp(doc::BRUSH_WORLD.0, doc::BRUSH_WORLD.1);
        let mut v = json!({
            "tool": if b.erase { "erase" } else { "paint" },
            "color": hex,
            "size": size,
            // In f64 (0.01 as an f32 is just under 0.01) and rounded.
            "opacity": r4(b.opacity).clamp(0.0, 1.0),
            "flow": r4(b.flow).clamp(0.001, 1.0),
            "hardness": r4(b.hardness).clamp(0.0, 1.0),
            "spacing": r4(b.spacing).clamp(0.01, 2.0),
            "pressureSize": b.pressure_size,
            "pressureFlow": b.pressure_flow,
            "buildup": b.buildup,
        });
        let mut extra = |k: &str, x: f64, none: f64| {
            if x != none {
                v[k] = x.into();
            }
        };
        extra("roundness", r4(b.roundness).clamp(0.05, 1.0), 1.0);
        extra("angle", r4(angle).clamp(0.0, 360.0), 0.0);
        extra("sizeJitter", r4(b.size_jitter).clamp(0.0, 1.0), 0.0);
        extra("angleJitter", r4(b.angle_jitter).clamp(0.0, 1.0), 0.0);
        extra("scatter", r4(b.scatter).clamp(0.0, 4.0), 0.0);
        extra("opacityJitter", r4(b.flow_jitter).clamp(0.0, 1.0), 0.0);
        v
    }

    /// The stroke being drawn, for the others to see (every 40 ms, as the 2D app sends it).
    pub fn send_live(&mut self, painter: &Painter) {
        let Some((_, stroke)) = &painter.active else { return };
        if !painter.shared || painter.stroke_id.is_empty() || self.session.state != State::Open {
            return;
        }
        if self.live.0 != painter.stroke_id {
            self.live = (painter.stroke_id.clone(), 0, false, Instant::now());
        }
        let n = stroke.samples.len();
        if n <= self.live.1 || self.live.3.elapsed().as_millis() < 40 {
            return;
        }
        let Some(layer) = painter.painting.index_of(painter.active_layer).and_then(|i| self.doc_layer(i)).map(str::to_string) else { return };
        let mask = if painter.mask_target { painter.painting.index_of(painter.active_layer).and_then(|i| self.shown[i].mask_id.clone()) } else { None };
        let (pts, vr) = self.doc_points(&stroke.samples[self.live.1..n], Self::is_vr_layer(painter, painter.active_layer) && !painter.mask_target);
        let brush = self.doc_brush(painter, &stroke.brush);
        self.session.send_live(&self.live.0, &layer, mask.as_deref(), &brush, &pts, vr.as_ref(), !self.live.2);
        self.live = (self.live.0.clone(), n, true, Instant::now());
    }

    /// Sends what this user did since the last frame (strokes, sweeps, layer edits, undo and
    /// redo) as ops, and shows the document with them.
    pub fn commit(&mut self, painter: &mut Painter) {
        // Until a painting of the document is in (and while one is made again), what was done
        // waits: it is told against the painting as the document has it.
        if !self.ready || self.rebuilding() {
            return;
        }
        let outbox = std::mem::take(&mut painter.outbox);
        let asked = std::mem::take(&mut painter.asked);
        let edited = metas(&painter.painting) != self.synced;
        // The canvas's settings: its paint mixing, and its paper (sent at most every 150 ms
        // while a slider drags it).
        let doc_mix = if self.session.view().mix == "pigment" { vdraw_core::Mix::Pigment } else { vdraw_core::Mix::Normal };
        let mix = (painter.painting.mix != doc_mix).then_some((painter.painting.mix, doc_mix));
        let paper = (painter.paper != self.paper && self.paper_sent.elapsed().as_millis() >= 150).then_some((painter.paper, self.paper));
        if outbox.is_empty() && asked.is_empty() && !edited && mix.is_none() && paper.is_none() {
            return;
        }
        if !self.session.can_edit() {
            // A viewer (or not connected): what was done locally goes back.
            if edited {
                let doc = self.session.view().clone();
                self.rebuild_all(&doc);
            }
            return;
        }
        let mut step = UndoStep::default();
        let mut ops = Vec::new();
        let mix_name = |m: vdraw_core::Mix| if m == vdraw_core::Mix::Pigment { "pigment" } else { "normal" };
        if let Some((new, old)) = mix {
            ops.push(json!({ "type": "mix.set", "mix": mix_name(new) }));
            step.undo.push(json!({ "type": "mix.set", "mix": mix_name(old) }));
            step.redo.push(json!({ "type": "mix.set", "mix": mix_name(new) }));
        }
        if let Some((new, old)) = paper {
            let p = |c: [f32; 4]| json!({ "type": "paper.set", "paper": { "color": crate::palettes::to_hex([c[0], c[1], c[2]]), "alpha": r4(c[3]).clamp(0.0, 1.0) } });
            ops.push(p(new));
            // One drag of the slider is one step of undo.
            let merge = self.paper_sent.elapsed().as_secs_f32() < 2.0 && self.undo.last().is_some_and(|s| s.redo.len() == 1 && s.redo[0]["type"] == "paper.set");
            if merge {
                self.undo.last_mut().unwrap().redo = vec![p(new)];
            } else {
                step.undo.push(p(old));
                step.redo.push(p(new));
            }
            self.paper_sent = Instant::now();
        }
        for out in outbox {
            match out {
                Outgoing::Add { layer, mask, id, stroke } => {
                    let Some(place) = painter.painting.index_of(layer) else { continue };
                    let Some(doc_layer) = self.doc_layer(place).map(str::to_string) else { continue };
                    let mask_id = if mask { self.shown[place].mask_id.clone() } else { None };
                    if mask && mask_id.is_none() {
                        continue;
                    }
                    if stroke.samples.is_empty() {
                        continue;
                    }
                    // The last points the others have not seen, then the stroke itself.
                    let depth = Self::is_vr_layer(painter, layer) && !mask;
                    if self.live.0 == id && self.live.1 < stroke.samples.len() && self.live.2 {
                        let (pts, vr) = self.doc_points(&stroke.samples[self.live.1..], depth);
                        self.session.send_live(&id, &doc_layer, mask_id.as_deref(), &self.doc_brush(painter, &stroke.brush), &pts, vr.as_ref(), false);
                    }
                    let s = self.doc_stroke(painter, &id, &doc_layer, mask_id.as_deref(), &stroke, depth);
                    ops.push(json!({ "type": "stroke.add", "stroke": s }));
                    step.undo.push(json!({ "type": "stroke.remove", "id": id }));
                    step.redo.push(json!({ "type": "stroke.restore", "id": id }));
                    if !mask && !stroke.brush.erase {
                        painter.add_recent(crate::panel::to_srgb(stroke.brush.color));
                    }
                }
                // A VR layer moves freely (m3); a flat one, or a group, in the paper's plane (m).
                Outgoing::Transform { layer, matrix } if Self::is_vr_layer(painter, layer) => {
                    let Some(id) = self.doc_id(layer) else { continue };
                    let (m3, inv) = self.affine_3d(matrix);
                    ops.push(json!({ "type": "layer.transform", "id": id, "m3": m3 }));
                    step.undo.push(json!({ "type": "layer.transform", "id": id, "m3": inv }));
                    step.redo.push(json!({ "type": "layer.transform", "id": id, "m3": m3 }));
                }
                Outgoing::Transform { layer, matrix } => {
                    let Some(id) = self.doc_id(layer) else { continue };
                    let m = self.affine(matrix);
                    let Some(inv) = invert_affine(&m) else { continue };
                    ops.push(json!({ "type": "layer.transform", "id": id, "m": m }));
                    step.undo.push(json!({ "type": "layer.transform", "id": id, "m": inv }));
                    step.redo.push(json!({ "type": "layer.transform", "id": id, "m": m }));
                }
                Outgoing::Remove(at) => {
                    for a in at {
                        let Some(place) = painter.painting.index_of(a.layer) else { continue };
                        let list = if a.mask { &self.shown[place].mask } else { &self.shown[place].strokes };
                        let Some(p) = list.get(a.index) else { continue };
                        ops.push(json!({ "type": "stroke.remove", "id": p.id }));
                        step.undo.push(json!({ "type": "stroke.restore", "id": p.id }));
                        step.redo.push(json!({ "type": "stroke.remove", "id": p.id }));
                    }
                }
            }
        }
        if edited {
            self.layer_ops(painter, &mut ops, &mut step);
        }
        for op in ops {
            self.session.send_op(op);
        }
        // Sent: not to be sent again (the document brings the painting up to date).
        self.synced = metas(&painter.painting);
        if !step.undo.is_empty() {
            step.undo.reverse();
            self.undo.push(step);
            if self.undo.len() > 300 {
                self.undo.remove(0);
            }
            self.redo.clear();
        }
        for undo in asked {
            let (from, to) = if undo { (&mut self.undo, &mut self.redo) } else { (&mut self.redo, &mut self.undo) };
            if let Some(s) = from.pop() {
                for op in if undo { &s.undo } else { &s.redo } {
                    self.session.send_op(op.clone());
                }
                to.push(s);
            }
        }
        painter.history = (!self.undo.is_empty(), !self.redo.is_empty());
        self.sync(painter);
    }

    /// The panel's layer edits (the painting's layers against those last made from the
    /// document), as ops: layers added (or duplicated), changed, moved, and removed.
    fn layer_ops(&mut self, painter: &Painter, ops: &mut Vec<Value>, step: &mut UndoStep) {
        let doc = self.session.view().clone();
        let p = &painter.painting;
        let before: HashMap<u32, &Meta> = self.synced.iter().map(|m| (m.id, m)).collect();
        let after = metas(p);
        let now: HashMap<u32, &Meta> = after.iter().map(|m| (m.id, m)).collect();
        // New layers get document ids. One whose name is another's with " copy" (and that holds
        // what that one holds) is its duplicate; the rest are added.
        let mut new_ids: HashMap<u32, String> = HashMap::new();
        for m in &after {
            if !before.contains_key(&m.id) {
                new_ids.insert(m.id, doc::new_id());
            }
        }
        let doc_of = |id: u32, new_ids: &HashMap<u32, String>| new_ids.get(&id).cloned().or_else(|| self.doc_id(id));
        // Orders: in each group, the layers that kept their order keep it; the others go
        // between their neighbors.
        let mut orders: HashMap<u32, f64> = HashMap::new();
        let mut parents: Vec<Option<u32>> = vec![None];
        parents.extend(after.iter().filter(|m| m.group).map(|m| Some(m.id)));
        for parent in parents {
            let kids: Vec<u32> = p.children(parent).into_iter().map(|i| p.layers[i].id).collect();
            let old: Vec<Option<f64>> = kids
                .iter()
                .map(|&k| {
                    let same_parent = before.get(&k).is_some_and(|b| b.parent == parent);
                    self.doc_id(k).filter(|_| same_parent).and_then(|d| doc.layers.get(&d)).map(|l| l.order)
                })
                .collect();
            let known: Vec<usize> = (0..kids.len()).filter(|&i| old[i].is_some()).collect();
            let keep: Vec<usize> = increasing(&known.iter().map(|&i| old[i].unwrap()).collect::<Vec<_>>()).into_iter().map(|k| known[k]).collect();
            let mut prev: Option<f64> = None;
            for i in 0..kids.len() {
                if keep.contains(&i) {
                    prev = old[i];
                    continue;
                }
                let next = keep.iter().find(|&&k| k > i).and_then(|&k| old[k]);
                // How many in a row go before `next`, to spread them evenly.
                let run = (i..kids.len()).take_while(|j| !keep.contains(j)).count() as f64;
                let o = match (prev, next) {
                    (Some(a), Some(b)) => a + (b - a) / (run + 1.0),
                    (Some(a), None) => a + 1.0,
                    (None, Some(b)) => b - run,
                    (None, None) => 1.0,
                };
                orders.insert(kids[i], o);
                prev = Some(o);
            }
        }
        // Added first (groups before what goes in them), then changes, then removals.
        let mut adds = Vec::new();
        let mut added: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for m in after.iter().filter(|m| m.group).chain(after.iter().filter(|m| !m.group)) {
            let Some(nid) = new_ids.get(&m.id) else { continue };
            if m.parent.is_some_and(|par| added.contains(&par) && !before.contains_key(&par) && self.is_copy(p, par, &before)) {
                // In a duplicated group: the duplicate brings it.
                added.insert(m.id);
                continue;
            }
            added.insert(m.id);
            let parent = m.parent.and_then(|par| doc_of(par, &new_ids));
            let order = orders.get(&m.id).copied().unwrap_or(1.0);
            if let Some(src) = self.copy_source(p, m.id, &before) {
                let mut op = json!({ "type": "layer.duplicate", "id": src, "newId": nid, "name": m.name, "order": order });
                if let Some(par) = &parent {
                    op["parent"] = par.as_str().into();
                }
                adds.push(op);
            } else {
                let mut layer = json!({ "id": nid, "name": m.name, "order": order, "blend": blend_name(m.blend), "opacity": m.opacity, "visible": m.visible });
                if m.group {
                    layer["kind"] = "group".into();
                }
                if let Some(par) = &parent {
                    layer["parent"] = par.as_str().into();
                }
                if m.clip {
                    layer["clip"] = true.into();
                }
                if m.vr {
                    layer["vr"] = true.into();
                }
                adds.push(json!({ "type": "layer.add", "layer": layer }));
            }
            step.undo.push(json!({ "type": "layer.remove", "id": nid }));
            step.redo.push(json!({ "type": "layer.restore", "id": nid }));
        }
        let mut updates = Vec::new();
        for m in &after {
            let (Some(b), Some(id)) = (before.get(&m.id), self.doc_id(m.id)) else { continue };
            let Some(dl) = doc.layers.get(&id) else { continue };
            let mut props = serde_json::Map::new();
            let mut old = serde_json::Map::new();
            let mut set = |k: &str, new: Value, was: Value| {
                props.insert(k.into(), new);
                old.insert(k.into(), was);
            };
            if m.name != b.name {
                set("name", m.name.clone().into(), dl.name.clone().into());
            }
            if m.blend != b.blend {
                set("blend", blend_name(m.blend), dl.blend.clone().into());
            }
            if m.opacity != b.opacity {
                set("opacity", m.opacity.into(), dl.opacity.into());
            }
            if m.visible != b.visible {
                set("visible", m.visible.into(), dl.visible.into());
            }
            if m.clip != b.clip {
                set("clip", m.clip.into(), dl.clip.unwrap_or(false).into());
            }
            if m.vr != b.vr && !m.group {
                set("vr", m.vr.into(), dl.vr.into());
            }
            if m.parent != b.parent {
                let par = m.parent.and_then(|x| doc_of(x, &new_ids)).map_or(Value::Null, Value::from);
                set("parent", par, dl.parent.clone().map_or(Value::Null, Value::from));
            }
            if let Some(&o) = orders.get(&m.id) {
                set("order", o.into(), dl.order.into());
            }
            if m.mask != b.mask {
                let was = dl.mask.as_ref().map_or(Value::Null, |mk| json!({ "id": mk.id, "enabled": mk.enabled }));
                let new = match (m.mask, &dl.mask) {
                    (None, _) => Value::Null,
                    (Some(on), Some(mk)) => json!({ "id": mk.id, "enabled": on }),
                    (Some(on), None) => json!({ "id": doc::new_id(), "enabled": on }),
                };
                set("mask", new, was);
            }
            if !props.is_empty() {
                updates.push(json!({ "type": "layer.update", "id": id, "props": props }));
                step.undo.push(json!({ "type": "layer.update", "id": id, "props": old }));
                step.redo.push(json!({ "type": "layer.update", "id": id, "props": props }));
            }
        }
        let mut removes = Vec::new();
        for b in &self.synced {
            if now.contains_key(&b.id) || b.parent.is_some_and(|par| !now.contains_key(&par)) {
                continue;
            }
            let Some(id) = self.doc_id(b.id) else { continue };
            removes.push(json!({ "type": "layer.remove", "id": id }));
            step.undo.push(json!({ "type": "layer.restore", "id": id }));
            step.redo.push(json!({ "type": "layer.remove", "id": id }));
        }
        // The new layers keep their ids when the document has them; the new active one stays
        // active.
        for (&n, nid) in &new_ids {
            self.ids.retain(|_, v| *v != n);
            self.ids.insert(nid.clone(), n);
        }
        self.next_id = self.next_id.max(new_ids.keys().max().map_or(0, |m| m + 1));
        if let Some(nid) = new_ids.get(&painter.active_layer) {
            self.want_active = Some(nid.clone());
        }
        ops.extend(adds);
        ops.extend(updates);
        ops.extend(removes);
    }

    /// Whether a new layer is a duplicate (see `copy_source`).
    fn is_copy(&self, p: &vdraw_core::Painting, id: u32, before: &HashMap<u32, &Meta>) -> bool {
        self.copy_source(p, id, before).is_some()
    }

    /// The document layer a new layer duplicates: one that was there, named as it without
    /// " copy", of its kind, with as many strokes.
    fn copy_source(&self, p: &vdraw_core::Painting, id: u32, before: &HashMap<u32, &Meta>) -> Option<String> {
        let l = &p.layers[p.index_of(id)?];
        let name = l.name.strip_suffix(" copy")?;
        let src = p.layers.iter().find(|o| before.contains_key(&o.id) && o.name == name && o.group == l.group && o.strokes.len() == l.strokes.len())?;
        self.doc_id(src.id)
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
                let depth = !painter.painting.layers[layer].ordered;
                let stroke = doc::stroke(&l.id, &brush, &l.pts, l.vr.as_ref().filter(|_| depth), &self.frame);
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

    /// The hands' grips, each frame: one hand holding carries the canvas (it moves and turns
    /// with the hand); two hands move, turn and scale it: the two points under the hands stay
    /// under them, it scales as they part, and it rolls about the line between them by the
    /// wrists' turns, averaged. `poses`: the hands (world); `held`: their grips. Returns
    /// whether it is held.
    pub fn navigate(&mut self, painter: &mut Painter, poses: [Option<Mat4>; 2], held: [bool; 2]) -> bool {
        let now: [Option<Mat4>; 2] = [0, 1].map(|h| poses[h].filter(|_| held[h]));
        let was = self.held;
        let rot = |m: Mat4| Quat::from_mat4(&m).normalize();
        let delta = match (was, now) {
            ([Some(a0), Some(b0)], [Some(a1), Some(b1)]) => {
                let (pa0, pb0, pa1, pb1) = (a0.w_axis.truncate(), b0.w_axis.truncate(), a1.w_axis.truncate(), b1.w_axis.truncate());
                let (v0, v1) = (pb0 - pa0, pb1 - pa1);
                let s = (v1.length() / v0.length().max(1e-4)).clamp(0.5, 2.0);
                let axis = v1.normalize_or(Vec3::X);
                let swing = Quat::from_rotation_arc(v0.normalize_or(Vec3::X), axis);
                // The wrists' turns, averaged; of that, the part about the hands' line (the
                // rest is the line's own turn, above).
                let wrists = (rot(a1) * rot(a0).inverse()).slerp(rot(b1) * rot(b0).inverse(), 0.5);
                let along = Vec3::new(wrists.x, wrists.y, wrists.z).dot(axis) * axis;
                let twist = Quat::from_xyzw(along.x, along.y, along.z, wrists.w);
                let twist = if twist.length_squared() > 1e-12 { twist.normalize() } else { Quat::IDENTITY };
                let (m0, m1) = ((pa0 + pb0) * 0.5, (pa1 + pb1) * 0.5);
                Some(Mat4::from_translation(m1) * Mat4::from_quat(twist * swing) * Mat4::from_scale(Vec3::splat(s)) * Mat4::from_translation(-m0))
            }
            // One hand (also the one left holding when the other lets go): the canvas goes
            // with it, as if held.
            ([Some(p0), _], [Some(p1), None]) | ([_, Some(p0)], [None, Some(p1)]) => {
                let (q0, q1) = (rot(p0), rot(p1));
                let (t0, t1) = (p0.w_axis.truncate(), p1.w_axis.truncate());
                Some(Mat4::from_translation(t1) * Mat4::from_quat(q1 * q0.inverse()) * Mat4::from_translation(-t0))
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
                self.anchor_again(poses.iter().flatten().next().map(|p| p.w_axis.truncate()));
            }
        }
        holding
    }

    /// Anchors the frame again: at the paper point nearest `near` (world; or the scene's
    /// origin), with the view's scale taken into the frame (the view's scale is 1 after).
    fn anchor_again(&mut self, near: Option<Vec3>) {
        if self.rebuilding() {
            return;
        }
        let s = self.scale() as f64;
        let inv = self.view.inverse();
        let p = near.map_or(Vec3::ZERO, |n| inv.transform_point3(n)).with_z(0.0);
        let c = self.frame.canvas(p);
        let new = Frame { anchor: [c[0], c[1]], k: self.frame.k * s, offset: Vec3::ZERO };
        // Old scene from new: p_old = p_new / s + (the new anchor in the old scene). The view
        // takes it when the painting in the new frame is in.
        let at_old = self.frame.point(c[0], c[1], 0.0);
        let old_from_new = Mat4::from_translation(at_old) * Mat4::from_scale(Vec3::splat((1.0 / s) as f32));
        let doc = self.session.view().clone();
        self.start_rebuild(&doc, new, old_from_new);
        log::info!("canvas anchored again at ({:.3}, {:.3}), {:.3e} m per canvas unit", c[0], c[1], new.k);
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
        other.send_live("Slivecccccccc", &layer, None, &brush, &[0.0, 50.0, 0.5, 30.0, 60.0, 0.5], None, true);
        until(&mut c, &mut painter, &mut other, "the live stroke", &|c, _| !c.session.lives.is_empty());
        painter.update_drawing();
        c.draw_live(&mut painter);
        assert_eq!(painter.drawing_runs.len(), 1);
        assert!(!painter.drawing.is_empty());
        c.session.close();
        other.close();
    }

    /// This user's edits go out as the 2D app's ops: a stroke painted on the paper, one swept
    /// away, layer edits from the panel; undo and redo send their opposites. Another client
    /// sees each. (A test server, as above.)
    #[test]
    fn edits_in_vr_reach_the_others() {
        let Ok(base) = std::env::var("VDRAW_TEST_SERVER") else { return };
        let server = vdraw_net::Server::new(&base, None);
        let anon = vdraw_net::identity::base64url(&[11u8; 32]);
        let key = server.create(&anon, None, None).unwrap();
        let mut c = Canvas::new(Session::open(&server, &key, "VR", "#ff6b6b", &anon, None));
        let mut other = Session::open(&server, &key, "2D", "#4dabf7", &anon, None);
        let mut painter = Painter::new(vdraw_core::Painting::default());
        let head = Mat4::from_translation(Vec3::new(0.0, 1.6, 0.0));
        let wait = |c: &mut Canvas, painter: &mut Painter, other: &mut Session, what: &str, done: &dyn Fn(&Session) -> bool| {
            let t = Instant::now();
            loop {
                other.poll();
                c.update(painter, head);
                c.commit(painter);
                if done(other) {
                    break;
                }
                assert!(t.elapsed() < Duration::from_secs(5), "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        wait(&mut c, &mut painter, &mut other, "both open", &|o| o.state == State::Open);
        while c.session.state != State::Open || !c.placed || c.rebuilding() {
            c.update(&mut painter, head);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(painter.shared);
        let live = |o: &Session| o.doc.strokes.values().filter(|s| !s.deleted).count();
        // A stroke on the paper (z = 0 of the scene), 10 cm long, the brush 1 cm across.
        painter.tools.brush.radius = 0.005;
        for (k, x) in [0.0f32, 0.05, 0.1].iter().enumerate() {
            painter.hand(1, k as f64 * 0.02, Vec3::new(*x, 0.0, 0.0), Vec3::NEG_Y, 0.8);
        }
        painter.hand(1, 0.1, Vec3::new(0.1, 0.0, 0.0), Vec3::NEG_Y, 0.0);
        wait(&mut c, &mut painter, &mut other, "the stroke", &|o| live(o) == 1);
        let s = other.doc.strokes.values().next().unwrap().clone();
        // Its size in canvas units is 1 cm at the canvas's scale; its points lie along x.
        assert!((s.brush.size * c.frame.k - 0.01).abs() < 1e-4, "{} {}", s.brush.size, c.frame.k);
        assert_eq!(s.pts.len(), 12, "{:?}", s.pts);
        assert!((s.pts[9] - s.pts[0] - 0.1 / c.frame.k).abs() < 1e-2 / c.frame.k, "it ends where the pen did");
        assert_eq!(painter.built.strokes.len(), 1, "shown once, from the document");
        // Undo takes it away for the others too; redo brings it back.
        painter.undo();
        wait(&mut c, &mut painter, &mut other, "undo", &|o| live(o) == 0);
        assert_eq!(painter.built.strokes.len(), 0);
        painter.redo();
        wait(&mut c, &mut painter, &mut other, "redo", &|o| live(o) == 1);
        // The Move layer tool: the layer moved 10 cm along the paper, then back by undo.
        let x0 = |o: &Session| o.doc.strokes.values().find(|s| !s.deleted).map(|s| s.pts[0]).unwrap();
        let before = x0(&other);
        painter.tools.tool = crate::tools::Tool::Transform;
        let at = Mat4::from_translation(Vec3::new(0.0, 0.0, 0.3));
        painter.grab(1, at, true, 0.0, 0.01);
        painter.grab(1, Mat4::from_translation(Vec3::new(0.1, 0.0, 0.3)), true, 0.0, 0.01);
        painter.grab(1, Mat4::from_translation(Vec3::new(0.1, 0.0, 0.3)), false, 0.0, 0.01);
        let k = c.frame.k;
        wait(&mut c, &mut painter, &mut other, "the move", &|o| (x0(o) - before - 0.1 / k).abs() < 1e-3 / k);
        painter.undo();
        wait(&mut c, &mut painter, &mut other, "the move undone", &|o| (x0(o) - before).abs() < 1e-3 / k);
        // The stroke eraser, across it.
        painter.tools.tool = crate::tools::Tool::StrokeEraser;
        painter.tools.sweep_size = 0.02;
        painter.hand(1, 1.0, Vec3::new(0.05, 0.05, 0.0), Vec3::NEG_Y, 1.0);
        painter.hand(1, 1.1, Vec3::new(0.05, -0.05, 0.0), Vec3::NEG_Y, 1.0);
        painter.hand(1, 1.2, Vec3::new(0.05, -0.05, 0.0), Vec3::NEG_Y, 0.0);
        wait(&mut c, &mut painter, &mut other, "the sweep", &|o| live(o) == 0);
        // Layer edits from the panel: a new layer above, renamed, at half opacity.
        let at = painter.active_index();
        painter.edit_layers(|p| (Some(p.add_layer(Some(at))), crate::painter::Removed::default()));
        let i = painter.active_index();
        painter.edit_layers(|p| {
            p.layers[i].name = "From VR".into();
            p.layers[i].opacity = 0.5;
            (None, crate::painter::Removed::default())
        });
        wait(&mut c, &mut painter, &mut other, "the new layer", &|o| o.doc.layers.values().any(|l| l.name == "From VR" && l.opacity == 0.5 && !l.deleted));
        let order = |o: &Session| o.doc.paint_order().iter().map(|l| l.name.clone()).collect::<Vec<_>>();
        assert_eq!(order(&other).last().map(String::as_str), Some("From VR"), "{:?}", order(&other));
        assert_eq!(painter.painting.layers[painter.active_index()].name, "From VR", "the new layer stays active");
        // Moved below the first, then undone.
        let i = painter.active_index();
        painter.edit_layers(|p| (Some(p.move_layer(i, false)), crate::painter::Removed::default()));
        wait(&mut c, &mut painter, &mut other, "the move", &|o| o.doc.paint_order().first().is_some_and(|l| l.name == "From VR"));
        painter.undo();
        wait(&mut c, &mut painter, &mut other, "the move undone", &|o| o.doc.paint_order().last().is_some_and(|l| l.name == "From VR"));
        // Deleted, then undone.
        let i = painter.active_index();
        painter.edit_layers(|p| {
            let (a, layers) = p.delete(i).unwrap();
            (Some(a), crate::painter::Removed { layers, masks: Vec::new() })
        });
        wait(&mut c, &mut painter, &mut other, "the delete", &|o| o.doc.paint_order().len() == 1);
        painter.undo();
        wait(&mut c, &mut painter, &mut other, "the delete undone", &|o| o.doc.paint_order().len() == 2);
        assert_eq!(painter.painting.layers.len(), 2);
        // The paper, see-through and red; the paint mixing; undo takes the paper back.
        painter.paper = [1.0, 0.0, 0.0, 0.5];
        wait(&mut c, &mut painter, &mut other, "the paper", &|o| o.doc.paper.color == "#ff0000" && o.doc.paper.alpha == 0.5);
        painter.set_mix(vdraw_core::Mix::Pigment);
        wait(&mut c, &mut painter, &mut other, "the mixing", &|o| o.doc.mix == "pigment");
        painter.undo();
        painter.undo();
        wait(&mut c, &mut painter, &mut other, "the paper undone", &|o| o.doc.paper.color == "#ffffff" && o.doc.paper.alpha == 1.0 && o.doc.mix == "normal");
        assert_eq!(painter.paper, [1.0; 4]);
        c.session.close();
        other.close();
    }

    /// A layer made in VR is a VR layer; strokes painted on it with the pen keep their depth
    /// and the pen's up side, for the others too (also while they are drawn), and come back
    /// in 3D. (A test server with the VR fields, as above.)
    #[test]
    fn strokes_on_vr_layers_keep_their_depth() {
        let Ok(base) = std::env::var("VDRAW_TEST_SERVER") else { return };
        let server = vdraw_net::Server::new(&base, None);
        let anon = vdraw_net::identity::base64url(&[13u8; 32]);
        let key = server.create(&anon, None, None).unwrap();
        let mut c = Canvas::new(Session::open(&server, &key, "VR", "#ff6b6b", &anon, None));
        let mut other = Session::open(&server, &key, "2D", "#4dabf7", &anon, None);
        let mut painter = Painter::new(vdraw_core::Painting::default());
        painter.shared = true;
        let head = Mat4::from_translation(Vec3::new(0.0, 1.6, 0.0));
        let wait = |c: &mut Canvas, painter: &mut Painter, other: &mut Session, what: &str, done: &dyn Fn(&Session) -> bool| {
            let t = Instant::now();
            loop {
                other.poll();
                c.update(painter, head);
                c.commit(painter);
                c.send_live(painter);
                if done(other) {
                    break;
                }
                assert!(t.elapsed() < Duration::from_secs(5), "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        wait(&mut c, &mut painter, &mut other, "both open", &|o| o.state == State::Open);
        while c.session.state != State::Open || !c.placed || c.rebuilding() {
            c.update(&mut painter, head);
            std::thread::sleep(Duration::from_millis(10));
        }
        let at = painter.active_index();
        painter.edit_layers(|p| (Some(p.add_layer(Some(at))), crate::painter::Removed::default()));
        wait(&mut c, &mut painter, &mut other, "the VR layer", &|o| o.doc.layers.values().any(|l| l.vr));
        // Sent once, also while the painting is made again (a while of frames).
        for _ in 0..30 {
            other.poll();
            c.update(&mut painter, head);
            c.commit(&mut painter);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(other.doc.layers.values().filter(|l| !l.deleted).count(), 2, "one layer more");
        while c.rebuilding() || !painter.painting.layers.iter().any(|l| !l.ordered) {
            c.update(&mut painter, head);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!painter.painting.layers[painter.active_index()].ordered, "the new layer is active");
        // A stroke 10 cm in front of the paper, the pen's up side straight up (its dabs as close
        // as they go: 0.01 as an f32 must not come out under the server's 0.01).
        painter.tools.smoothing = 0.0;
        painter.tools.brush.spacing = 0.01;
        for (k, x) in [0.0f32, 0.05, 0.1].iter().enumerate() {
            painter.hand(1, k as f64 * 0.05, Vec3::new(*x, 0.0, 0.1), Vec3::Y, 0.8);
        }
        std::thread::sleep(Duration::from_millis(50));
        c.send_live(&painter);
        let k = c.frame.k;
        wait(&mut c, &mut painter, &mut other, "the live stroke's depth", &|o| o.lives.values().any(|l| l.vr.as_ref().is_some_and(|v| v.z.iter().all(|z| (z - 0.1 / k).abs() < 1e-3 / k))));
        painter.hand(1, 0.2, Vec3::new(0.1, 0.0, 0.1), Vec3::Y, 0.0);
        wait(&mut c, &mut painter, &mut other, "the stroke", &|o| o.doc.strokes.values().any(|s| s.vr.is_some()));
        let s = other.doc.strokes.values().find(|s| s.vr.is_some()).unwrap().clone();
        let vr = s.vr.unwrap();
        assert_eq!(vr.z.len(), s.pts.len() / 3);
        assert!(vr.z.iter().all(|z| (z - 0.1 / k).abs() < 1e-3 / k), "{:?}", vr.z);
        // Up is +y in the scene: -y in canvas axes (y runs down).
        assert_eq!(&vr.up.unwrap()[..3], &[0.0, -1.0, 0.0]);
        // Back from the document: in 3D, 10 cm in front of the paper.
        let shown = painter.painting.layers.iter().find(|l| !l.ordered && !l.group).unwrap();
        assert_eq!(shown.strokes.len(), 1);
        assert!((shown.strokes[0].samples[0].pos.z - 0.1).abs() < 1e-3);
        // The Move layer tool turns the VR layer a quarter turn about the vertical: the stroke
        // along x at 10 cm in front of the paper ends up across it (depth 0 down to -10 cm).
        painter.tools.tool = crate::tools::Tool::Transform;
        painter.grab(1, Mat4::IDENTITY, true, 0.0, 0.01);
        painter.grab(1, Mat4::from_rotation_y(std::f32::consts::FRAC_PI_2), true, 0.0, 0.01);
        painter.grab(1, Mat4::from_rotation_y(std::f32::consts::FRAC_PI_2), false, 0.0, 0.01);
        let ends = |o: &Session| o.doc.strokes.values().find_map(|s| s.vr.as_ref().filter(|_| !s.deleted).map(|v| (v.z[0], *v.z.last().unwrap())));
        wait(&mut c, &mut painter, &mut other, "the turn", &|o| ends(o).is_some_and(|(a, b)| a.abs() < 1e-3 / k && (b + 0.1 / k).abs() < 1e-3 / k));
        painter.undo();
        wait(&mut c, &mut painter, &mut other, "the turn undone", &|o| ends(o).is_some_and(|(a, b)| (a - 0.1 / k).abs() < 1e-3 / k && (b - 0.1 / k).abs() < 1e-3 / k));
        // The flat layer made a VR layer, and back by undo.
        let flat = painter.painting.layers.iter().position(|l| l.ordered).unwrap();
        painter.edit_layers(|p| {
            p.layers[flat].ordered = false;
            (Some(flat), crate::painter::Removed::default())
        });
        wait(&mut c, &mut painter, &mut other, "a VR layer more", &|o| o.doc.layers.values().filter(|l| l.vr && !l.deleted).count() == 2);
        painter.undo();
        wait(&mut c, &mut painter, &mut other, "flat again", &|o| o.doc.layers.values().filter(|l| l.vr && !l.deleted).count() == 1);
        c.session.close();
        other.close();
    }

    /// The grips: a point of the canvas under a hand stays under it, with one hand (moving and
    /// turning) and with two (parting, rolling about the line between them).
    #[test]
    fn the_canvas_stays_in_the_hands() {
        let server = vdraw_net::Server::new("http://127.0.0.1:9", None);
        let mut c = Canvas::new(Session::open(&server, "none", "VR", "#ff6b6b", "x", None));
        let mut painter = Painter::new(vdraw_core::Painting::default());
        let world = |c: &Canvas, scene: Vec3| c.view.transform_point3(scene);
        let pose = |q: Quat, t: Vec3| Mat4::from_rotation_translation(q, t);
        // One hand at (0, 1, -0.5): a point 10 cm in front of it, in the scene.
        let a0 = pose(Quat::IDENTITY, Vec3::new(0.0, 1.0, -0.5));
        let local = Vec3::new(0.0, 0.0, -0.1);
        let p = c.view.inverse().transform_point3(a0.transform_point3(local));
        c.navigate(&mut painter, [Some(a0), None], [true, false]);
        let a1 = pose(Quat::from_rotation_y(1.0) * Quat::from_rotation_x(0.3), Vec3::new(0.2, 1.1, -0.4));
        c.navigate(&mut painter, [Some(a1), None], [true, false]);
        assert!(world(&c, p).abs_diff_eq(a1.transform_point3(local), 1e-5), "one hand carries it, turning");
        c.navigate(&mut painter, [Some(a1), None], [false, false]);
        // Two hands 40 cm apart; they part to 80 cm and both wrists roll 30 degrees about the
        // line between them: the points under them stay, and so does one beside the line.
        let (l0, r0) = (pose(Quat::IDENTITY, Vec3::new(-0.2, 1.0, -0.5)), pose(Quat::IDENTITY, Vec3::new(0.2, 1.0, -0.5)));
        let under = [l0.w_axis.truncate(), r0.w_axis.truncate()].map(|w| c.view.inverse().transform_point3(w));
        let beside = c.view.inverse().transform_point3(Vec3::new(0.0, 1.1, -0.5));
        c.navigate(&mut painter, [Some(l0), Some(r0)], [true, true]);
        let roll = Quat::from_rotation_x(0.5);
        let (l1, r1) = (pose(roll, Vec3::new(-0.4, 1.0, -0.5)), pose(roll, Vec3::new(0.4, 1.0, -0.5)));
        c.navigate(&mut painter, [Some(l1), Some(r1)], [true, true]);
        assert!(world(&c, under[0]).abs_diff_eq(l1.w_axis.truncate(), 1e-5));
        assert!(world(&c, under[1]).abs_diff_eq(r1.w_axis.truncate(), 1e-5));
        assert!((c.scale() - 2.0).abs() < 1e-5);
        let want = Vec3::new(0.0, 1.0, -0.5) + roll * Vec3::new(0.0, 0.2, 0.0);
        assert!(world(&c, beside).abs_diff_eq(want, 1e-4), "{} {want}", world(&c, beside));
    }
}
