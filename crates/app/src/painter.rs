//! What the hands do to the painting: strokes into the active layer (or its mask), the stroke
//! eraser's sweeps, layer edits, and undo and redo of all of them.

use crate::panel;
use crate::tools::{self, Tools};
use glam::Vec3;
use std::collections::HashMap;
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
    /// The stroke being drawn, as segments (made every frame).
    pub drawing: Vec<GpuSegment>,
    pub undo: Vec<Edit>,
    pub redo: Vec<Edit>,
    pub active: Option<(usize, Stroke)>,
    pub sweep: Option<Sweep>,
    pub tools: Tools,
    /// The layer strokes go to (by id), and whether to its mask (the 2D app's mask target).
    pub active_layer: u32,
    pub mask_target: bool,
    /// The last layer edit's key and when it was: edits of the same key within 2 s are one
    /// step of undo (an opacity drag), as in the 2D app.
    merge: Option<(&'static str, std::time::Instant)>,
    /// Colors used, newest first (sRGB), for the panel's swatches.
    pub recent: Vec<[u8; 3]>,
    /// The strokes changed since the last save.
    pub changed: bool,
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
            undo: Vec::new(),
            redo: Vec::new(),
            active: None,
            sweep: None,
            tools: Tools::default(),
            active_layer,
            mask_target: false,
            merge: None,
            recent: Vec::new(),
            changed: false,
        };
        p.rebuild();
        p
    }

    pub fn rebuild(&mut self) {
        self.built = self.painting.build(&mut self.done);
        self.version += 1;
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

    pub fn undo(&mut self) {
        self.end_sweep();
        if let Some(edit) = self.undo.pop() {
            let edit = self.apply(edit);
            self.redo.push(edit);
        }
    }

    pub fn redo(&mut self) {
        self.end_sweep();
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
        if record {
            self.undo.push(Edit::Layers { layout: before, kept: removed.layers, masks: removed.masks, active: was });
        } else if let Some(Edit::Layers { kept, masks, .. }) = self.undo.last_mut() {
            kept.extend(removed.layers);
            masks.extend(removed.masks);
        }
        self.redo.clear();
        self.rebuild();
        self.changed = true;
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
        let (layer, mask) = (self.active_layer, self.mask_target);
        let i = self.active_index();
        let ordered = self.painting.layers[i].ordered;
        let id = self.built.strokes.len() as u32;
        let index = self.list(layer, mask).map_or(0, |l| l.len());
        match self.built.runs.last_mut() {
            Some(run) if run.step == step => {
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
        match &mut self.active {
            Some((h, stroke)) if *h == hand => {
                if down {
                    stroke.push(Sample { up, ..Sample::new(tip, pull, t) });
                } else {
                    let (_, stroke) = self.active.take().unwrap();
                    self.finish(stroke);
                }
            }
            // The eyedropper picks where the pen points (the frame loop renders that).
            None if self.tools.tool == crate::tools::Tool::Eyedropper => {}
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
                    let mut stroke = Stroke::new(brush);
                    stroke.push(Sample { up, ..Sample::new(tip, pull, t) });
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
        let r = self.tools.sweep_size * 0.5;
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
        let edit = self.apply(Edit::Erase { at, strokes: Vec::new() });
        self.undo.push(edit);
        self.redo.clear();
    }

    /// The stroke eraser's overlay, its ball at `tip`: the center lines of the strokes it can
    /// take nearby, those under the ball in red (while it is not sweeping, as in the 2D app).
    pub fn eraser_lines(&self, tip: Vec3, out: &mut Vec<OverlayLine>) {
        let r = self.tools.sweep_size * 0.5;
        let only = self.sweep_step();
        let taken: &[u32] = self.sweep.as_ref().map_or(&[], |s| &s.taken);
        let hot = if self.sweep.is_some() { Vec::new() } else { tools::swept(&self.done, &self.built.runs, only, tip, tip, r, taken) };
        tools::overlay(&self.done, &self.built.runs, only, tip, (r * 4.0).max(0.05), &hot, taken, out);
    }

    /// The stroke being drawn, as segments, into `drawing`.
    pub fn update_drawing(&mut self) {
        self.drawing.clear();
        if let Some((_, s)) = &self.active {
            let ordered = self.painting.layers[self.active_index()].ordered;
            s.segments_in(self.painting.filter, self.built.strokes.len() as u32, ordered, &mut self.drawing);
        }
    }

    /// The steps as the renderer reads them.
    pub fn scene_steps(&self) -> Vec<SceneStep> {
        vdraw_render::scene_steps(&self.painting, &self.built.steps)
    }

    /// What the renderer draws this frame.
    pub fn scene<'a>(&'a self, steps: &'a [SceneStep]) -> Scene<'a> {
        Scene {
            segments: &self.done,
            runs: &self.built.runs,
            version: self.version,
            active: &self.drawing,
            active_step: self.target_step(),
            steps,
            pigment: self.painting.mix == Mix::Pigment,
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
    fn no_strokes_on_hidden_layers() {
        let mut p = painter();
        p.painting.layers[0].visible = false;
        p.rebuild();
        draw(&mut p, Vec3::Y, Vec3::Y + Vec3::X * 0.05);
        assert_eq!(p.painting.layers[0].strokes.len(), 3);
    }
}
