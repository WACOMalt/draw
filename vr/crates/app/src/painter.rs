//! What the hands do to the painting: strokes into the active layer (or its mask), the stroke
//! eraser's sweeps, layer edits, and undo and redo of all of them.

use crate::panel;
use crate::tools::{self, Tools};
use glam::Vec3;
use std::collections::{HashMap, HashSet};
use vdraw_core::{Built, GpuSegment, Layer, Mask, Mix, Painting, Sample, Stroke};
use vdraw_render::{OverlayLine, Scene, SceneStep};

/// Trigger pull below this is not painting (a resting finger).
pub const TRIGGER_DEAD: f32 = 0.05;

/// A stroke's place: its layer (by id), its strokes or its mask's, and its place there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct At {
    pub layer: u32,
    pub mask: bool,
    pub index: usize,
}

/// A change to the painting, as undo and redo keep it. Applying one gives its opposite.
pub enum Edit {
    /// A stroke put at the end of a layer's strokes, or its mask's (`stroke`: kept while it is
    /// undone).
    Add { layer: u32, mask: bool, stroke: Option<Stroke> },
    /// Strokes taken out by the stroke eraser, by place, in order (`strokes`: kept while they
    /// are out).
    Erase { at: Vec<At>, strokes: Vec<Stroke> },
    /// The paint mixing set (it holds the other one).
    Mix(Mix),
    /// A layer edit, undone by going back to how the layers were: `layout`, the layers without
    /// their strokes; `kept`, the layers the edit took out (with their strokes); `masks`, the
    /// masks it took off (by layer id).
    Layers { layout: Vec<Layer>, kept: Vec<Layer>, masks: Vec<(u32, Mask)>, active: u32 },
    /// Layers (by id) moved, turned and scaled (uniformly) by a matrix.
    Transform { layers: Vec<u32>, matrix: glam::Mat4 },
}

/// What the hands did to a shared canvas, for it to send as ops (on a shared canvas the
/// painter does not change the strokes itself: the document does, when they come back).
pub enum Outgoing {
    /// A stroke finished, for layer `layer` (by id) or its mask, with the id it goes by.
    Add { layer: u32, mask: bool, id: String, stroke: Stroke },
    /// Strokes the stroke eraser took, by place.
    Remove(Vec<At>),
    /// The layer (by id; a group: with what is in it) the Move layer tool moved, turned and
    /// scaled, by a matrix (the scene's): in the paper's plane, or freely (a 3D layer).
    Transform { layer: u32, matrix: glam::Mat4 },
}

/// A matrix with a uniform scale held to the paper's plane (z = 0): its turn about z, its
/// scale, its move along x and y (the 2D app's layer transforms are 2D).
pub fn planar(m: glam::Mat4) -> glam::Mat4 {
    let s = scale_of(m);
    let x = m.x_axis.truncate() / s.max(1e-12);
    let turn = x.y.atan2(x.x);
    glam::Mat4::from_translation(Vec3::new(m.w_axis.x, m.w_axis.y, 0.0)) * glam::Mat4::from_rotation_z(turn) * glam::Mat4::from_scale(Vec3::splat(s))
}

/// The Move layer tool's grab: the hand, its pose when it took hold (world), the scale the
/// stick has set, the layers held (by id), and their segments as they were (the ranges of
/// `done`, and a copy), moved each frame until it lets go.
pub struct Grab {
    pub hand: usize,
    start: glam::Mat4,
    scale: f32,
    layers: Vec<u32>,
    ranges: Vec<std::ops::Range<usize>>,
    base: Vec<GpuSegment>,
    matrix: glam::Mat4,
}

/// A matrix's uniform scale.
fn scale_of(m: glam::Mat4) -> f32 {
    m.x_axis.truncate().length()
}

/// A segment moved by a matrix (with a uniform scale): its ends, its radii and its flat axis.
fn move_segment(g: &mut GpuSegment, m: glam::Mat4) {
    let s = scale_of(m);
    let (a, b) = (m.transform_point3(g.a()), m.transform_point3(g.b()));
    g.a = [a.x, a.y, a.z, g.a[3] * s];
    g.b = [b.x, b.y, b.z, g.b[3] * s];
    let up = m.transform_vector3(g.up()).normalize_or(Vec3::Y);
    g.shape[..3].copy_from_slice(&up.to_array());
}

/// The layers as they are, without their strokes (a layer edit's undo).
fn layout(p: &Painting) -> Vec<Layer> {
    p.layers
        .iter()
        .map(|l| Layer { strokes: Vec::new(), mask: l.mask.as_ref().map(|m| Mask { enabled: m.enabled, strokes: Vec::new() }), ..l.clone() })
        .collect()
}

/// What a layer edit took out: layers (with their strokes), and masks (by layer id).
#[derive(Default)]
pub struct Removed {
    pub layers: Vec<Layer>,
    pub masks: Vec<(u32, Mask)>,
}

/// The stroke eraser's drag: the strokes it took so far (by number, sorted; hidden from the
/// renderer until the drag ends and they are taken out, as one edit), and where the ball was.
pub struct Sweep {
    pub hand: usize,
    pub taken: Vec<u32>,
    pub last: Vec3,
}

pub struct Painter {
    pub painting: Painting,
    /// Segments of the finished strokes, in step order (made again only when the strokes
    /// change), what they are of, and their version (counts up at each change).
    pub done: Vec<GpuSegment>,
    pub built: Built,
    pub version: u64,
    /// The strokes being drawn, as segments (made every frame): yours, and others' on a shared
    /// canvas (see `add_drawing`), and their runs by step.
    pub drawing: Vec<GpuSegment>,
    pub drawing_runs: Vec<vdraw_core::LayerRun>,
    pub undo: Vec<Edit>,
    pub redo: Vec<Edit>,
    pub active: Option<(usize, Stroke)>,
    pub sweep: Option<Sweep>,
    pub grab: Option<Grab>,
    pub tools: Tools,
    /// The layer strokes go to (by id), and whether to its mask (the 2D app's mask target).
    pub active_layer: u32,
    pub mask_target: bool,
    /// The last layer edit's key and when it was: edits of the same key within 2 s are one
    /// step of undo (an opacity drag), as in the 2D app.
    merge: Option<(&'static str, std::time::Instant)>,
    /// The stroke being drawn: its smoothed tip (the 2D app's smoothing follows the pen), and
    /// when a point was last added (airbrush: one every 30 ms while the pen holds still).
    smoothed: Vec3,
    last_point: f64,
    /// Where the pen really was last, its up side and its pull (a smoothed stroke ends
    /// there), and when.
    raw: (Vec3, Vec3, f32, f64),
    /// Colors used, newest first (sRGB), for the panel's swatches.
    pub recent: Vec<[u8; 3]>,
    /// The strokes changed since the last save.
    pub changed: bool,
    /// Scene units per meter (1 in the room; a shared canvas's zoom): brush sizes are meters
    /// as they look, at any zoom.
    pub scale: f32,
    /// On a shared canvas: strokes and sweeps go out (`outbox`), undo and redo are asked for
    /// (`asked`: true for undo), and whether there is any (`history`) is the canvas's.
    pub shared: bool,
    pub outbox: Vec<Outgoing>,
    pub asked: Vec<bool>,
    pub history: (bool, bool),
    /// The stroke being drawn's id (a shared canvas's: it goes by it while it is drawn).
    pub stroke_id: String,
    /// Strokes in 3D lit by the scene's light (VR only: the 2D app has none). Off on a shared
    /// canvas to begin with, so they look as the 2D app shows them.
    pub lit: bool,
    /// A shared canvas's paper as the panel sets it (sRGB, alpha; alpha 0: none).
    pub paper: [f32; 4],
    /// 3D layers (by id) painted with the laser on the paper, as a flat layer is (a flat
    /// layer made a 3D layer, to begin with); the others are painted in the air.
    pub on_paper: HashSet<u32>,
    /// Other VR users shown (their heads, hands and names).
    pub show_people: bool,
}

impl Painter {
    pub fn new(painting: Painting) -> Self {
        // The top paint layer is active to begin with.
        let active_layer = painting.layers.iter().rev().find(|l| !l.group).map_or(0, |l| l.id);
        let mut p = Self {
            painting,
            done: Vec::new(),
            built: Built::default(),
            version: 0,
            drawing: Vec::new(),
            drawing_runs: Vec::new(),
            undo: Vec::new(),
            redo: Vec::new(),
            active: None,
            sweep: None,
            grab: None,
            tools: Tools::default(),
            active_layer,
            mask_target: false,
            merge: None,
            smoothed: Vec3::ZERO,
            last_point: 0.0,
            raw: (Vec3::ZERO, Vec3::Y, 0.0, 0.0),
            recent: Vec::new(),
            changed: false,
            scale: 1.0,
            shared: false,
            outbox: Vec::new(),
            asked: Vec::new(),
            history: (false, false),
            stroke_id: String::new(),
            lit: true,
            paper: [1.0; 4],
            on_paper: HashSet::new(),
            show_people: true,
        };
        p.rebuild();
        p
    }

    /// Another painting opened: all as new but the tools and the recent colors.
    pub fn reopen(&mut self, painting: Painting) {
        let (tools, recent) = (self.tools.clone(), std::mem::take(&mut self.recent));
        *self = Self { tools, recent, ..Self::new(painting) };
    }

    pub fn rebuild(&mut self) {
        self.built = self.painting.build(&mut self.done);
        self.version += 1;
    }

    /// A painting in place of this one with its segments made already (a shared canvas's, made again): `active` the active layer (by id). What was being done to the last one (undo, a sweep, a grab) goes.
    pub fn replace_built(&mut self, painting: Painting, done: Vec<GpuSegment>, built: Built, active: u32) {
        self.painting = painting;
        self.done = done;
        self.built = built;
        self.version += 1;
        self.active_layer = active;
        self.mask_target = self.mask_target && self.painting.index_of(active).is_some_and(|i| self.painting.layers[i].mask.is_some());
        self.sweep = None;
        self.grab = None;
        self.undo.clear();
        self.redo.clear();
    }

    /// The stroke being drawn moved by a matrix with a uniform scale (the scene anchored
    /// again under it).
    pub fn move_drawing(&mut self, m: glam::Mat4) {
        let s = scale_of(m);
        if let Some((_, stroke)) = &mut self.active {
            stroke.brush.radius *= s;
            for p in &mut stroke.samples {
                p.pos = m.transform_point3(p.pos);
                p.up = m.transform_vector3(p.up).normalize_or(Vec3::Y);
            }
        }
        self.smoothed = m.transform_point3(self.smoothed);
        self.raw.0 = m.transform_point3(self.raw.0);
    }

    /// A stroke put into layer number `layer` (by place) at `index`, without building all again.
    pub fn insert_stroke(&mut self, layer: usize, mask: bool, index: usize, stroke: Stroke) {
        self.painting.insert_stroke(&mut self.built, &mut self.done, layer, mask, index, stroke);
        self.version += 1;
    }

    /// A stroke taken out of layer number `layer` (by place), without building all again.
    pub fn remove_stroke(&mut self, layer: usize, mask: bool, index: usize) -> Stroke {
        let s = self.painting.remove_stroke(&mut self.built, &mut self.done, layer, mask, index);
        self.version += 1;
        s
    }

    /// The active layer's place (the top paint layer when the active one is gone).
    pub fn active_index(&self) -> usize {
        self.painting.index_of(self.active_layer).or_else(|| self.painting.layers.iter().rposition(|l| !l.group)).unwrap_or(0)
    }

    /// The step strokes go to now: the active layer's (or its mask's), if it is shown and
    /// takes strokes.
    pub fn target_step(&self) -> Option<usize> {
        let i = self.active_index();
        let l = &self.painting.layers[i];
        if l.group || !self.painting.shown(i) || (self.mask_target && l.mask.is_none()) {
            return None;
        }
        self.built.step_of(i, self.mask_target)
    }

    /// Where stroke number `id` is.
    pub fn place(&self, id: u32) -> Option<At> {
        let r = self.built.strokes.get(id as usize)?;
        Some(At { layer: self.painting.layers[r.layer].id, mask: r.mask, index: r.index })
    }

    fn list(&mut self, layer: u32, mask: bool) -> Option<&mut Vec<Stroke>> {
        let l = self.painting.layers.iter_mut().find(|l| l.id == layer)?;
        if mask { l.mask.as_mut().map(|m| &mut m.strokes) } else { Some(&mut l.strokes) }
    }

    /// A grab let go of without keeping it: the layers back where they were.
    fn drop_grab(&mut self) {
        if self.grab.take().is_some() {
            self.rebuild();
        }
    }

    /// Whether there is anything to undo and redo.
    pub fn can_undo(&self) -> bool {
        if self.shared { self.history.0 } else { !self.undo.is_empty() }
    }

    pub fn can_redo(&self) -> bool {
        if self.shared { self.history.1 } else { !self.redo.is_empty() }
    }

    pub fn undo(&mut self) {
        if self.shared {
            self.asked.push(true);
            return;
        }
        self.end_sweep();
        self.drop_grab();
        if let Some(edit) = self.undo.pop() {
            let edit = self.apply(edit);
            self.redo.push(edit);
        }
    }

    pub fn redo(&mut self) {
        if self.shared {
            self.asked.push(false);
            return;
        }
        self.end_sweep();
        self.drop_grab();
        if let Some(edit) = self.redo.pop() {
            let edit = self.apply(edit);
            self.undo.push(edit);
        }
    }

    /// Undoes or redoes an edit (each is the other's opposite), and returns its opposite.
    fn apply(&mut self, edit: Edit) -> Edit {
        let edit = match edit {
            Edit::Add { layer, mask, stroke: None } => Edit::Add { layer, mask, stroke: self.list(layer, mask).and_then(|l| l.pop()) },
            Edit::Add { layer, mask, stroke: Some(s) } => {
                if let Some(list) = self.list(layer, mask) {
                    list.push(s);
                }
                Edit::Add { layer, mask, stroke: None }
            }
            Edit::Erase { at, strokes } if strokes.is_empty() => {
                // Take them out, last first, so the places before stay right.
                let mut strokes = Vec::new();
                for a in at.iter().rev() {
                    if let Some(list) = self.list(a.layer, a.mask) {
                        if a.index < list.len() {
                            strokes.push(list.remove(a.index));
                        }
                    }
                }
                strokes.reverse();
                Edit::Erase { at, strokes }
            }
            Edit::Erase { at, strokes } => {
                for (a, s) in at.iter().zip(strokes) {
                    if let Some(list) = self.list(a.layer, a.mask) {
                        list.insert(a.index.min(list.len()), s);
                    }
                }
                Edit::Erase { at, strokes: Vec::new() }
            }
            Edit::Mix(mix) => {
                self.changed = true;
                return Edit::Mix(std::mem::replace(&mut self.painting.mix, mix));
            }
            Edit::Layers { layout: to, kept, masks, active } => self.restore(to, kept, masks, active),
            Edit::Transform { layers, matrix } => {
                self.transform_layers(&layers, matrix);
                Edit::Transform { layers, matrix: matrix.inverse() }
            }
        };
        self.rebuild();
        self.changed = true;
        edit
    }

    /// The layers back as `to` lays them out: their strokes from the layers now and `kept`, their
    /// masks' from now and `masks`. Returns the opposite edit.
    fn restore(&mut self, to: Vec<Layer>, kept: Vec<Layer>, mut masks: Vec<(u32, Mask)>, active: u32) -> Edit {
        let before = layout(&self.painting);
        let mut have: HashMap<u32, Layer> = std::mem::take(&mut self.painting.layers).into_iter().chain(kept).map(|l| (l.id, l)).collect();
        let mut out_masks = Vec::new();
        for meta in to {
            let Some(mut l) = have.remove(&meta.id) else { continue };
            let mask = match (meta.mask, l.mask.take()) {
                (Some(m), Some(had)) => Some(Mask { enabled: m.enabled, strokes: had.strokes }),
                (Some(m), None) => {
                    let strokes = masks.iter().position(|(id, _)| *id == meta.id).map(|k| masks.swap_remove(k).1.strokes).unwrap_or_default();
                    Some(Mask { enabled: m.enabled, strokes })
                }
                (None, Some(had)) => {
                    out_masks.push((meta.id, had));
                    None
                }
                (None, None) => None,
            };
            let strokes = std::mem::take(&mut l.strokes);
            self.painting.layers.push(Layer { strokes, mask, ..meta });
        }
        let was = std::mem::replace(&mut self.active_layer, active);
        // What the edit had made, gone again: kept for its redo.
        let kept: Vec<Layer> = have.into_values().collect();
        Edit::Layers { layout: before, kept, masks: out_masks, active: was }
    }

    /// A layer edit: `f` changes the layers and returns what it took out and the layer to make
    /// active. One step of undo.
    pub fn edit_layers(&mut self, f: impl FnOnce(&mut Painting) -> (Option<usize>, Removed)) {
        self.merge = None;
        self.edit_layers_inner(f, true);
    }

    /// A layer edit that joins the last one of the same `key` within 2 s (one step of undo).
    pub fn edit_layers_merged(&mut self, key: &'static str, f: impl FnOnce(&mut Painting) -> (Option<usize>, Removed)) {
        let now = std::time::Instant::now();
        let join = self.merge.is_some_and(|(k, t)| k == key && now - t < std::time::Duration::from_secs(2)) && matches!(self.undo.last(), Some(Edit::Layers { .. }));
        self.merge = Some((key, now));
        self.edit_layers_inner(f, !join);
    }

    fn edit_layers_inner(&mut self, f: impl FnOnce(&mut Painting) -> (Option<usize>, Removed), record: bool) {
        self.end_sweep();
        let before = layout(&self.painting);
        let was = self.active_layer;
        let (active, removed) = f(&mut self.painting);
        if let Some(a) = active.and_then(|a| self.painting.layers.get(a)) {
            self.active_layer = a.id;
        }
        if self.painting.index_of(self.active_layer).is_none() || self.painting.layers[self.active_index()].mask.is_none() {
            self.mask_target = false;
        }
        if self.shared {
            // The canvas sends what changed; its undo takes it back.
        } else if record {
            self.undo.push(Edit::Layers { layout: before, kept: removed.layers, masks: removed.masks, active: was });
        } else if let Some(Edit::Layers { kept, masks, .. }) = self.undo.last_mut() {
            kept.extend(removed.layers);
            masks.extend(removed.masks);
        }
        self.redo.clear();
        self.rebuild();
        self.changed = true;
    }

    /// Moves the strokes of layers (by id; their masks' too) by a matrix with a uniform scale.
    fn transform_layers(&mut self, ids: &[u32], m: glam::Mat4) {
        let s = scale_of(m);
        for l in self.painting.layers.iter_mut().filter(|l| ids.contains(&l.id)) {
            let masks = l.mask.as_mut().map(|m| &mut m.strokes);
            for stroke in l.strokes.iter_mut().chain(masks.into_iter().flatten()) {
                stroke.brush.radius *= s;
                for p in &mut stroke.samples {
                    p.pos = m.transform_point3(p.pos);
                    p.up = m.transform_vector3(p.up).normalize_or(Vec3::Y);
                }
            }
        }
    }

    /// The Move layer tool, each frame: the hand's pose (world), its trigger, its stick (up
    /// scales), and the frame's time. Pressed: takes hold of the active layer (a group: all its
    /// layers); held: they follow the hand; let go: they stay there, one step of undo.
    pub fn grab(&mut self, hand: usize, pose: glam::Mat4, down: bool, stick: f32, dt: f32) {
        match (&mut self.grab, down) {
            (None, true) => {
                let i = self.active_index();
                let block = self.painting.block(i);
                let layers: Vec<u32> = self.painting.layers[block.clone()].iter().map(|l| l.id).collect();
                let steps: Vec<usize> = (0..self.built.steps.len())
                    .filter(|&s| matches!(self.built.steps[s], vdraw_core::Step::Layer(l) | vdraw_core::Step::Mask(l) if block.contains(&l)))
                    .collect();
                let ranges: Vec<_> = self.built.runs.iter().filter(|r| steps.contains(&r.step)).map(|r| r.first..r.first + r.count).collect();
                let base = ranges.iter().flat_map(|r| self.done[r.clone()].iter().copied()).collect();
                self.grab = Some(Grab { hand, start: pose, scale: 1.0, layers, ranges, base, matrix: glam::Mat4::IDENTITY });
            }
            (Some(g), true) if g.hand == hand => {
                // The stick scales about the hand, faster the further it is pushed.
                if stick.abs() > 0.15 {
                    g.scale = (g.scale * (stick * dt * 1.2).exp()).clamp(0.01, 100.0);
                }
                g.matrix = pose * glam::Mat4::from_scale(Vec3::splat(g.scale)) * g.start.inverse();
                // A shared canvas's flat layers (and groups) move in the paper's plane; its VR
                // layers move freely.
                let free = self.painting.index_of(self.active_layer).is_some_and(|i| self.painting.layers[i].is_3d());
                if self.shared && !free {
                    g.matrix = planar(g.matrix);
                }
                let mut k = 0;
                for r in g.ranges.clone() {
                    for d in &mut self.done[r] {
                        let mut s = g.base[k];
                        move_segment(&mut s, g.matrix);
                        *d = s;
                        k += 1;
                    }
                }
                self.version += 1;
            }
            (Some(g), false) if g.hand == hand => {
                let g = self.grab.take().unwrap();
                if self.shared {
                    // The canvas sends it; the document moves the strokes.
                    self.outbox.push(Outgoing::Transform { layer: self.active_layer, matrix: g.matrix });
                    return;
                }
                self.transform_layers(&g.layers, g.matrix);
                self.undo.push(Edit::Transform { layers: g.layers, matrix: g.matrix.inverse() });
                self.redo.clear();
                self.rebuild();
                self.changed = true;
            }
            _ => {}
        }
    }

    /// Puts a color (sRGB) first among the recent ones (the 2D app keeps 18).
    pub fn add_recent(&mut self, srgb: [f32; 3]) {
        let c = srgb.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8);
        self.recent.retain(|&r| r != c);
        self.recent.insert(0, c);
        self.recent.truncate(panel::RECENT);
    }

    /// Sets the paint mixing, as an edit.
    pub fn set_mix(&mut self, mix: Mix) {
        if mix != self.painting.mix {
            self.end_sweep();
            let edit = self.apply(Edit::Mix(mix));
            self.undo.push(edit);
            self.redo.clear();
        }
    }

    /// Puts a finished stroke into the active layer (or its mask). When its step's run is the
    /// last one (the usual case: VR strokes on the top layer), its segments are appended; else
    /// all are made again.
    fn finish(&mut self, stroke: Stroke) {
        let Some(step) = self.target_step() else { return };
        if self.shared {
            self.outbox.push(Outgoing::Add { layer: self.active_layer, mask: self.mask_target, id: std::mem::take(&mut self.stroke_id), stroke });
            return;
        }
        let (layer, mask) = (self.active_layer, self.mask_target);
        let i = self.active_index();
        let ordered = self.painting.layers[i].ordered;
        let id = self.built.strokes.len() as u32;
        let index = self.list(layer, mask).map_or(0, |l| l.len());
        match self.built.runs.last_mut() {
            Some(run) if run.step == step && !self.built.copied => {
                stroke.segments_in(self.painting.filter, id, ordered, &mut self.done);
                run.count = self.done.len() - run.first;
                self.built.strokes.push(vdraw_core::StrokeRef { layer: i, mask, index });
                self.list(layer, mask).unwrap().push(stroke);
                self.version += 1;
            }
            _ => {
                self.list(layer, mask).unwrap().push(stroke);
                self.rebuild();
            }
        }
        self.changed = true;
        self.undo.push(Edit::Add { layer, mask, stroke: None });
        self.redo.clear();
    }

    /// One hand's trigger at time `t` (seconds), the tip at `tip`, the pen's up side facing
    /// `up`: the brush and the eraser paint (into the active layer, or its mask), the stroke
    /// eraser sweeps.
    pub fn hand(&mut self, hand: usize, t: f64, tip: Vec3, up: Vec3, pull: f32) {
        let down = pull > TRIGGER_DEAD;
        if self.sweep.as_ref().is_some_and(|s| s.hand == hand) {
            if down {
                self.sweep_to(tip);
            } else {
                self.end_sweep();
            }
            return;
        }
        // The 2D app's smoothing: the point follows the pen by a part of the way.
        let follow = 1.0 - self.tools.smoothing.min(0.95) * 0.9;
        match &mut self.active {
            Some((h, stroke)) if *h == hand => {
                if down {
                    self.raw = (tip, up, pull, t);
                    let last = stroke.samples.last().map(|s| s.pos).unwrap_or(tip);
                    self.smoothed += (tip - self.smoothed) * follow;
                    if (self.smoothed - last).length() > 5e-4 * self.scale {
                        stroke.push(Sample { up, ..Sample::new(self.smoothed, pull, t) });
                        self.last_point = t;
                    } else if stroke.brush.buildup && t - self.last_point >= 0.03 {
                        // Held still: the same point again, a dab more (airbrush).
                        stroke.push(Sample { up, ..Sample::new(last, pull, t) });
                        self.last_point = t;
                    }
                } else {
                    let (_, mut stroke) = self.active.take().unwrap();
                    // Smoothing trails the pen: the stroke ends where the pen did (as the 2D
                    // app's).
                    let (tip, up, pull, _) = self.raw;
                    if let Some(last) = stroke.samples.last().filter(|s| (s.pos - tip).length() > 1e-6 * self.scale) {
                        let t = t.max(last.time + 1e-6);
                        stroke.push(Sample { up, ..Sample::new(tip, pull, t) });
                    }
                    self.finish(stroke);
                }
            }
            // The eyedropper picks where the pen points (the frame loop renders that).
            // The eyedropper picks where the pen points (the frame loop renders that); the
            // Move layer tool takes hold with `grab`.
            None if matches!(self.tools.tool, crate::tools::Tool::Eyedropper | crate::tools::Tool::Transform) => {}
            None if down && self.sweep.is_none() => match self.tools.paint() {
                Some(mut brush) => {
                    // Not on a hidden layer, a group, or a mask that is not there.
                    if self.target_step().is_none() {
                        return;
                    }
                    if self.mask_target {
                        // Mask paint is grey: the luminance of the color.
                        let c = panel::to_srgb(brush.color);
                        let grey = panel::to_linear([0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; 3]);
                        brush.color = grey;
                    } else if !brush.erase {
                        self.add_recent(panel::to_srgb(brush.color));
                    }
                    brush.radius *= self.scale;
                    if self.shared {
                        // As the 2D app paints it: its dabs, its pressure, and the random
                        // numbers of the id the stroke goes by.
                        self.stroke_id = vdraw_core::doc::new_id();
                        brush.dabs = Some(vdraw_core::stroke::Dabs { flow: brush.flow, spacing: brush.spacing, pressure_flow: brush.pressure_flow });
                        brush.min_ratio = 0.02;
                        brush.seed = vdraw_core::stroke::stroke_seed(&self.stroke_id);
                    } else {
                        // The dynamics' random numbers: a seed of the stroke's own.
                        brush.seed = (t * 1e6) as u64 as u32 ^ (tip.x.to_bits().rotate_left(13) ^ tip.z.to_bits());
                    }
                    let mut stroke = Stroke::new(brush);
                    stroke.push(Sample { up, ..Sample::new(tip, pull, t) });
                    self.raw = (tip, up, pull, t);
                    self.smoothed = tip;
                    self.last_point = t;
                    self.active = Some((hand, stroke));
                }
                None => {
                    self.sweep = Some(Sweep { hand, taken: Vec::new(), last: tip });
                    self.sweep_to(tip);
                }
            },
            _ => {}
        }
    }

    /// The stroke eraser's eligible steps: every layer's (all layers), or the active one's.
    fn sweep_step(&self) -> Option<usize> {
        if self.tools.sweep_all { None } else { Some(self.target_step().unwrap_or(usize::MAX)) }
    }

    /// The stroke eraser's ball moved to `tip` with the trigger down: the strokes its path
    /// touches go (hidden now, taken out when the drag ends).
    fn sweep_to(&mut self, tip: Vec3) {
        let Some(mut sweep) = self.sweep.take() else { return };
        let r = self.tools.sweep_size * 0.5 * self.scale;
        let hit = tools::swept(&self.done, &self.built.runs, self.sweep_step(), sweep.last, tip, r, &sweep.taken);
        for &id in &hit {
            // Hidden: the renderer sees a speck of nothing until the strokes are taken out.
            let from = self.done.partition_point(|g| (g.style[1] as u32) < id);
            for g in self.done[from..].iter_mut().take_while(|g| g.style[1] as u32 == id) {
                g.a[3] = 1e-9;
                g.b[3] = 1e-9;
                g.color[3] = 0.0;
                g.style[2] = 0.0;
                g.style[3] = 0.0;
            }
        }
        if !hit.is_empty() {
            sweep.taken.extend(hit);
            sweep.taken.sort_unstable();
            self.version += 1;
        }
        sweep.last = tip;
        self.sweep = Some(sweep);
    }

    /// The stroke eraser's drag ends: what it took goes, as one edit (undo brings it back).
    pub fn end_sweep(&mut self) {
        let Some(sweep) = self.sweep.take() else { return };
        let mut at: Vec<At> = sweep.taken.iter().filter_map(|&id| self.place(id)).collect();
        if at.is_empty() {
            return;
        }
        at.sort();
        log::info!("removed {} stroke{}", at.len(), if at.len() == 1 { "" } else { "s" });
        if self.shared {
            self.outbox.push(Outgoing::Remove(at));
            return;
        }
        let edit = self.apply(Edit::Erase { at, strokes: Vec::new() });
        self.undo.push(edit);
        self.redo.clear();
    }

    /// The stroke eraser's overlay, its ball at `tip`: the center lines of the strokes it can
    /// take nearby, those under the ball in red (while it is not sweeping, as in the 2D app).
    pub fn eraser_lines(&self, tip: Vec3, out: &mut Vec<OverlayLine>) {
        let r = self.tools.sweep_size * 0.5 * self.scale;
        let only = self.sweep_step();
        let taken: &[u32] = self.sweep.as_ref().map_or(&[], |s| &s.taken);
        let hot = if self.sweep.is_some() { Vec::new() } else { tools::swept(&self.done, &self.built.runs, only, tip, tip, r, taken) };
        tools::overlay(&self.done, &self.built.runs, only, tip, (r * 4.0).max(0.05 * self.scale), &hot, taken, out);
    }

    /// The stroke being drawn, as segments, into `drawing` (and nothing else there yet), and
    /// its copies where the layer has a kaleidoscope.
    pub fn update_drawing(&mut self) {
        self.drawing.clear();
        self.drawing_runs.clear();
        if let (Some((_, s)), Some(_)) = (&self.active, self.target_step()) {
            let (i, mask) = (self.active_index(), self.mask_target);
            Self::copies_in(&self.painting, &self.built, i, mask, s, self.built.strokes.len() as u32, &mut self.drawing, &mut self.drawing_runs);
        }
    }

    /// Another stroke being drawn (someone else's), into layer number `layer` (by place), or
    /// its mask: drawn over the finished strokes there. `n`: its place among them (it takes a
    /// stroke number of its own).
    pub fn add_drawing(&mut self, layer: usize, mask: bool, stroke: &Stroke, n: u32) {
        Self::copies_in(&self.painting, &self.built, layer, mask, stroke, self.built.strokes.len() as u32 + 1 + n, &mut self.drawing, &mut self.drawing_runs);
    }

    /// A stroke being drawn in a layer (or its mask), as segments: in each run that draws the
    /// layer, once for each of the run's transforms (a kaleidoscope's copies).
    #[allow(clippy::too_many_arguments)]
    fn copies_in(painting: &Painting, built: &Built, layer: usize, mask: bool, stroke: &Stroke, id: u32, out: &mut Vec<GpuSegment>, runs: &mut Vec<vdraw_core::LayerRun>) {
        let ordered = painting.layers[layer].ordered;
        for (step, copies) in built.runs_of(layer, mask) {
            let first = out.len();
            for m in copies {
                if *m == glam::Mat4::IDENTITY {
                    stroke.segments_in(painting.filter, id, ordered, out);
                } else if let Some(t) = stroke.transformed(m) {
                    t.segments_in(painting.filter, id, ordered, out);
                }
            }
            runs.push(vdraw_core::LayerRun { step, first, count: out.len() - first });
        }
    }

    /// The steps as the renderer reads them.
    pub fn scene_steps(&self) -> (Vec<SceneStep>, Vec<f32>) {
        vdraw_render::scene_steps(&self.painting, &self.built.steps)
    }

    /// What the renderer draws this frame.
    pub fn scene<'a>(&'a self, steps: &'a [SceneStep], adjust: &'a [f32]) -> Scene<'a> {
        Scene {
            segments: &self.done,
            runs: &self.built.runs,
            version: self.version,
            active: &self.drawing,
            active_runs: &self.drawing_runs,
            steps,
            adjust,
            pigment: self.painting.mix == Mix::Pigment,
            world_from_scene: glam::Mat4::IDENTITY,
            paper: [0.0; 4],
            paper_grid: 0.0,
            lit: self.lit,
            canvas: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::Tool;
    use vdraw_core::Brush;

    /// A painting of three straight strokes along x, at heights 0, 0.1 and 0.2 m.
    fn painter() -> Painter {
        let strokes = (0..3)
            .map(|k| {
                let mut s = Stroke::new(Brush::default());
                for i in 0..=10 {
                    s.push(Sample::new(Vec3::new(i as f32 * 0.01, k as f32 * 0.1, 0.0), 1.0, i as f64));
                }
                s
            })
            .collect();
        Painter::new(Painting::with_strokes(strokes))
    }

    fn heights(p: &Painter) -> Vec<f32> {
        p.painting.layers[0].strokes.iter().map(|s| s.samples[0].pos.y).collect()
    }

    fn draw(p: &mut Painter, from: Vec3, to: Vec3) {
        p.hand(1, 0.0, from, Vec3::Y, 1.0);
        p.hand(1, 0.1, to, Vec3::Y, 1.0);
        p.hand(1, 0.2, to, Vec3::Y, 0.0);
    }

    #[test]
    fn a_sweep_takes_strokes_as_one_edit() {
        let mut p = painter();
        p.tools.tool = Tool::StrokeEraser;
        p.tools.sweep_size = 0.02;
        // Down across the lower two strokes, the trigger held over three frames.
        p.hand(0, 0.0, Vec3::new(0.05, 0.15, 0.0), Vec3::Y, 1.0);
        p.hand(0, 0.1, Vec3::new(0.05, 0.05, 0.0), Vec3::Y, 1.0);
        p.hand(0, 0.2, Vec3::new(0.05, -0.05, 0.0), Vec3::Y, 1.0);
        // While the drag goes on, nothing is taken out yet: the strokes are only hidden.
        assert_eq!(heights(&p), vec![0.0, 0.1, 0.2]);
        assert_eq!(p.sweep.as_ref().unwrap().taken, vec![0, 1]);
        p.hand(0, 0.3, Vec3::new(0.05, -0.05, 0.0), Vec3::Y, 0.0);
        assert_eq!(heights(&p), vec![0.2]);
        // One undo brings both back, in their places; redo takes them again.
        p.undo();
        assert_eq!(heights(&p), vec![0.0, 0.1, 0.2]);
        p.redo();
        assert_eq!(heights(&p), vec![0.2]);
    }

    #[test]
    fn strokes_and_mixing_undo_in_turn() {
        let mut p = painter();
        draw(&mut p, Vec3::new(0.0, 0.5, 0.0), Vec3::new(0.05, 0.5, 0.0));
        p.set_mix(Mix::Pigment);
        assert_eq!((heights(&p).len(), p.painting.mix), (4, Mix::Pigment));
        p.undo();
        assert_eq!((heights(&p).len(), p.painting.mix), (4, Mix::Normal));
        p.undo();
        assert_eq!(heights(&p).len(), 3);
        p.redo();
        p.redo();
        assert_eq!((heights(&p).len(), p.painting.mix), (4, Mix::Pigment));
    }

    #[test]
    fn the_eraser_paints_eraser_strokes() {
        let mut p = painter();
        p.tools.tool = Tool::Eraser;
        draw(&mut p, Vec3::ZERO, Vec3::X * 0.05);
        let last = p.painting.layers[0].strokes.last().unwrap();
        assert!(last.brush.erase && last.brush.hardness == 0.6);
        // Erasing does not add a recent color.
        assert!(p.recent.is_empty());
    }

    #[test]
    fn strokes_go_to_the_active_layer_and_layer_edits_undo() {
        let mut p = painter();
        // A new layer above becomes active; a stroke goes there.
        p.edit_layers(|pt| (Some(pt.add_layer(Some(0))), Removed::default()));
        assert_eq!(p.painting.layers.len(), 2);
        draw(&mut p, Vec3::Y, Vec3::Y + Vec3::X * 0.05);
        assert_eq!((p.painting.layers[0].strokes.len(), p.painting.layers[1].strokes.len()), (3, 1));
        // Delete the new layer (with its stroke), then undo: it comes back with the stroke.
        let gone = p.active_index();
        p.edit_layers(|pt| {
            let (a, layers) = pt.delete(gone).unwrap();
            (Some(a), Removed { layers, masks: Vec::new() })
        });
        assert_eq!(p.painting.layers.len(), 1);
        p.undo();
        assert_eq!(p.painting.layers.len(), 2);
        assert_eq!(p.painting.layers[1].strokes.len(), 1);
        assert_eq!(p.active_index(), 1);
        p.redo();
        assert_eq!(p.painting.layers.len(), 1);
        // A mask: strokes to it while it is the target; taking it off and back keeps them.
        p.edit_layers(|pt| {
            pt.layers[0].mask = Some(Mask { enabled: true, strokes: Vec::new() });
            (Some(0), Removed::default())
        });
        p.mask_target = true;
        draw(&mut p, Vec3::Y, Vec3::Y + Vec3::X * 0.05);
        assert_eq!(p.painting.layers[0].mask.as_ref().unwrap().strokes.len(), 1);
        let s = &p.painting.layers[0].mask.as_ref().unwrap().strokes[0];
        assert!((s.brush.color[0] - s.brush.color[1]).abs() < 1e-6, "mask paint is grey");
        p.edit_layers(|pt| {
            let m = pt.layers[0].mask.take().unwrap();
            (Some(0), Removed { layers: Vec::new(), masks: vec![(pt.layers[0].id, m)] })
        });
        assert!(p.painting.layers[0].mask.is_none() && !p.mask_target);
        p.undo();
        assert_eq!(p.painting.layers[0].mask.as_ref().unwrap().strokes.len(), 1);
    }

    #[test]
    fn the_move_layer_tool_moves_and_scales_and_undoes() {
        let mut p = painter();
        p.tools.tool = Tool::Transform;
        let start = glam::Mat4::from_translation(Vec3::new(0.0, 1.0, 0.0));
        p.grab(1, start, true, 0.0, 0.01);
        // The hand moves 10 cm along x; the stick scales up for a while.
        let moved = glam::Mat4::from_translation(Vec3::new(0.1, 1.0, 0.0));
        for _ in 0..10 {
            p.grab(1, moved, true, 1.0, 0.05);
        }
        let s = p.grab.as_ref().unwrap().scale;
        assert!(s > 1.5, "{s}");
        // While held, the segments move (the strokes not yet).
        assert_eq!(p.painting.layers[0].strokes[0].samples[0].pos, Vec3::ZERO);
        p.grab(1, moved, false, 0.0, 0.01);
        // Let go: the strokes moved, scaled about the hand; their radius too.
        let first = p.painting.layers[0].strokes[0].samples[0].pos;
        let want = Vec3::new(0.1, 1.0, 0.0) + (Vec3::ZERO - Vec3::new(0.0, 1.0, 0.0)) * s;
        assert!(first.abs_diff_eq(want, 1e-4), "{first} {want}");
        assert!((p.painting.layers[0].strokes[0].brush.radius - 0.01 * s).abs() < 1e-6);
        p.undo();
        assert!(p.painting.layers[0].strokes[0].samples[0].pos.abs_diff_eq(Vec3::ZERO, 1e-5));
        assert!((p.painting.layers[0].strokes[0].brush.radius - 0.01).abs() < 1e-6);
        p.redo();
        assert!(p.painting.layers[0].strokes[0].samples[0].pos.abs_diff_eq(want, 1e-4));
    }

    #[test]
    fn no_strokes_on_hidden_layers() {
        let mut p = painter();
        p.painting.layers[0].visible = false;
        p.rebuild();
        draw(&mut p, Vec3::Y, Vec3::Y + Vec3::X * 0.05);
        assert_eq!(p.painting.layers[0].strokes.len(), 3);
    }
}
