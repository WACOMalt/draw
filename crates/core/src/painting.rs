//! A painting: layers of strokes, as in the 2D app: each with a blend mode and an opacity;
//! groups (passing their layers through to what is below, or isolated: blended as one picture);
//! layers clipped to the layer below; layer masks. And the segments the renderer draws, with
//! the steps it composites them in.

use crate::filter::OneEuro3;
use crate::segments::GpuSegment;
use crate::stroke::Stroke;
use glam::Vec3;
use serde::{Deserialize, Serialize};
use std::ops::Range;

/// The 2D app's blend modes, in its order (the shader's mode numbers), and pass through
/// (groups only: their layers blend onto what is below them, each by its own mode).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Blend {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
    Add,
    Pass,
}

impl Blend {
    /// The modes a layer takes, in the 2D app's order.
    pub const LAYER: [Blend; 17] = [
        Blend::Normal,
        Blend::Multiply,
        Blend::Screen,
        Blend::Overlay,
        Blend::Darken,
        Blend::Lighten,
        Blend::ColorDodge,
        Blend::ColorBurn,
        Blend::HardLight,
        Blend::SoftLight,
        Blend::Difference,
        Blend::Exclusion,
        Blend::Hue,
        Blend::Saturation,
        Blend::Color,
        Blend::Luminosity,
        Blend::Add,
    ];

    /// From the 2D app's name ("color-burn", "pass"); unknown names are normal.
    pub fn from_name(name: &str) -> Self {
        serde_json::from_value(serde_json::Value::String(name.to_string())).unwrap_or_default()
    }

    /// The 2D app's label (LayersPanel).
    pub fn label(self) -> &'static str {
        match self {
            Blend::Normal => "Normal",
            Blend::Multiply => "Multiply",
            Blend::Screen => "Screen",
            Blend::Overlay => "Overlay",
            Blend::Darken => "Darken",
            Blend::Lighten => "Lighten",
            Blend::ColorDodge => "Color Dodge",
            Blend::ColorBurn => "Color Burn",
            Blend::HardLight => "Hard Light",
            Blend::SoftLight => "Soft Light",
            Blend::Difference => "Difference",
            Blend::Exclusion => "Exclusion",
            Blend::Hue => "Hue",
            Blend::Saturation => "Saturation",
            Blend::Color => "Color",
            Blend::Luminosity => "Luminosity",
            Blend::Add => "Add (Linear Dodge)",
            Blend::Pass => "Pass Through",
        }
    }
}

/// A layer mask: grey paint (strokes) that hides the layer where it is dark, as the 2D app's:
/// the layer shows by the mask's luminance where it is painted, fully where it is not.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Mask {
    pub enabled: bool,
    pub strokes: Vec<Stroke>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Layer {
    /// Unique in the painting (files from before groups have none: they get one on load).
    pub id: u32,
    pub name: String,
    pub blend: Blend,
    pub opacity: f32,
    pub visible: bool,
    /// The strokes cover each other in their order, as in the 2D app (each over the ones
    /// before, an eraser taking from those before it), not by depth. For strokes brought in from
    /// the 2D app, which lie in one plane. (Files from before 3D strokes called these layers
    /// `flat`.)
    #[serde(alias = "flat")]
    pub ordered: bool,
    /// A group: it holds the layers whose `parent` it is, and no strokes. Its blend `Pass`: its
    /// layers blend onto what is below; any other: they make one picture first, which blends.
    pub group: bool,
    /// The group it is in (None: the top level).
    pub parent: Option<u32>,
    /// Clipped to the layer below it in its group (the base): it shows only where the base has
    /// paint, and the two blend onto what is below as one, by the base's mode and opacity.
    pub clip: bool,
    pub mask: Option<Mask>,
    pub strokes: Vec<Stroke>,
    /// A shared canvas's VR layer: its strokes have depth (they still cover each other in
    /// order, as the 2D app draws them).
    #[serde(default)]
    pub vr: bool,
}

impl Default for Layer {
    fn default() -> Self {
        Self { id: 0, name: "Layer".into(), blend: Blend::Normal, opacity: 1.0, visible: true, ordered: false, group: false, parent: None, clip: false, mask: None, strokes: Vec::new(), vr: false }
    }
}

impl Layer {
    /// A layer of strokes in 3D: a VR layer, or one whose strokes are drawn by depth (a new
    /// layer made in VR).
    pub fn is_vr(&self) -> bool {
        !self.group && (self.vr || !self.ordered)
    }
}

/// How paint mixes with the paint under it in a layer, as the 2D app's canvas setting.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mix {
    /// Over, as light: blue over yellow is grey.
    #[default]
    Normal,
    /// As paint (Kubelka-Munk, shaders/pigment.slang): blue and yellow make green.
    Pigment,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Painting {
    /// In paint order, bottom first; a group right after its layers (see `normalize`).
    pub layers: Vec<Layer>,
    pub mix: Mix,
    /// The filter for every VR stroke's path.
    #[serde(skip)]
    pub filter: OneEuro3,
}

impl Default for Painting {
    fn default() -> Self {
        Self { layers: vec![Layer { id: 1, name: "Layer 1".into(), ..Default::default() }], mix: Mix::Normal, filter: OneEuro3::default() }
    }
}

/// A step of compositing, in order: what the renderer does for each pixel (see `steps`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// A group starts (by its place in `layers`): isolated, a picture of its own begins; pass
    /// through, its layers go on below (clipping starts over inside it).
    Open(usize),
    /// The group ends: an isolated group's picture blends onto what is below.
    Close(usize),
    /// A layer's mask (it comes right before its layer).
    Mask(usize),
    Layer(usize),
}

/// A run of segments of one step (a layer's or a mask's strokes), as `Painting::build` lays
/// them out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerRun {
    /// The step's place in `Built::steps`.
    pub step: usize,
    pub first: usize,
    pub count: usize,
}

/// Where a stroke number points: a layer (by its place), its strokes or its mask's, and the
/// stroke's place there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StrokeRef {
    pub layer: usize,
    pub mask: bool,
    pub index: usize,
}

/// What `Painting::build` makes: the compositing steps, the runs of segments, and where each
/// stroke number points.
#[derive(Clone, Debug, Default)]
pub struct Built {
    pub steps: Vec<Step>,
    pub runs: Vec<LayerRun>,
    pub strokes: Vec<StrokeRef>,
}

impl Built {
    /// The step that draws a layer (its strokes, or its mask's).
    pub fn step_of(&self, layer: usize, mask: bool) -> Option<usize> {
        self.steps.iter().position(|&s| s == if mask { Step::Mask(layer) } else { Step::Layer(layer) })
    }
}

/// Where a moved layer goes, beside a target layer (as the 2D app's drag and drop).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    Above,
    Below,
    /// At the top of the target group.
    Into,
}

impl Painting {
    /// A painting of one volume layer with these strokes.
    pub fn with_strokes(strokes: Vec<Stroke>) -> Self {
        let mut p = Self::default();
        p.layers[0].strokes = strokes;
        p
    }

    /// The strokes of the top paint layer (made when there is none).
    pub fn active(&mut self) -> &mut Vec<Stroke> {
        let i = match self.layers.iter().rposition(|l| !l.group) {
            Some(i) => i,
            None => {
                let id = self.new_id();
                self.layers.push(Layer { id, name: "VR".into(), ..Default::default() });
                self.layers.len() - 1
            }
        };
        &mut self.layers[i].strokes
    }

    /// An id no layer has.
    pub fn new_id(&self) -> u32 {
        self.layers.iter().map(|l| l.id).max().unwrap_or(0) + 1
    }

    pub fn index_of(&self, id: u32) -> Option<usize> {
        self.layers.iter().position(|l| l.id == id)
    }

    /// Whether layer `i` is in group `group` (by id), at any depth.
    pub fn is_in(&self, i: usize, group: u32) -> bool {
        let mut at = self.layers[i].parent;
        let mut guard = 0;
        while let Some(p) = at {
            if p == group {
                return true;
            }
            at = self.index_of(p).and_then(|j| self.layers[j].parent);
            guard += 1;
            if guard > 64 {
                break;
            }
        }
        false
    }

    /// How deep a layer is: 0 at the top level.
    pub fn depth(&self, i: usize) -> usize {
        let mut d = 0;
        let mut at = self.layers[i].parent;
        while let Some(p) = at {
            d += 1;
            at = self.index_of(p).and_then(|j| self.layers[j].parent);
            if d > 64 {
                break;
            }
        }
        d
    }

    /// A layer and everything in it (a group's layers come right before it): its places.
    pub fn block(&self, i: usize) -> Range<usize> {
        let mut start = i;
        if self.layers[i].group {
            let id = self.layers[i].id;
            while start > 0 && self.is_in(start - 1, id) {
                start -= 1;
            }
        }
        start..i + 1
    }

    /// The layers in a group (or at the top level: None), bottom first, by place.
    pub fn children(&self, parent: Option<u32>) -> Vec<usize> {
        (0..self.layers.len()).filter(|&i| self.layers[i].parent == parent).collect()
    }

    /// Shown: it and every group it is in are visible.
    pub fn shown(&self, i: usize) -> bool {
        let mut at = Some(i);
        let mut guard = 0;
        while let Some(j) = at {
            if !self.layers[j].visible {
                return false;
            }
            at = self.layers[j].parent.and_then(|p| self.index_of(p));
            guard += 1;
            if guard > 64 {
                break;
            }
        }
        true
    }

    /// Makes the layers consistent: ids unique and set, parents that are groups (else the top
    /// level), groups without strokes, and the paint order: each group right after its layers,
    /// siblings in the order they were. Files from before groups load as they were.
    pub fn normalize(&mut self) {
        let mut seen = std::collections::HashSet::new();
        let mut next = self.new_id();
        for l in &mut self.layers {
            if l.id == 0 || !seen.insert(l.id) {
                l.id = next;
                seen.insert(next);
                next += 1;
            }
        }
        let groups: std::collections::HashSet<u32> = self.layers.iter().filter(|l| l.group).map(|l| l.id).collect();
        for l in &mut self.layers {
            if l.parent.is_some_and(|p| !groups.contains(&p) || p == l.id) {
                l.parent = None;
            }
            if l.group {
                l.strokes.clear();
                l.mask = None;
                l.ordered = false;
            } else if l.blend == Blend::Pass {
                l.blend = Blend::Normal;
            }
        }
        // A parent loop (a group in itself, through others) goes to the top level.
        for i in 0..self.layers.len() {
            if self.is_in(i, self.layers[i].id) {
                self.layers[i].parent = None;
            }
        }
        // The paint order, from the tree.
        let mut order = Vec::with_capacity(self.layers.len());
        fn walk(p: &Painting, parent: Option<u32>, order: &mut Vec<usize>) {
            for i in p.children(parent) {
                if p.layers[i].group {
                    walk(p, Some(p.layers[i].id), order);
                }
                order.push(i);
            }
        }
        walk(self, None, &mut order);
        let mut old: Vec<Option<Layer>> = std::mem::take(&mut self.layers).into_iter().map(Some).collect();
        self.layers = order.into_iter().filter_map(|i| old[i].take()).collect();
        if !self.layers.iter().any(|l| !l.group) {
            let id = self.new_id();
            self.layers.push(Layer { id, name: "Layer 1".into(), ..Default::default() });
        }
    }

    /// The compositing steps of the shown layers, bottom first: a group opens, its layers, it
    /// closes; a layer's mask (when enabled) right before the layer.
    pub fn steps(&self) -> Vec<Step> {
        let mut out = Vec::new();
        fn walk(p: &Painting, parent: Option<u32>, out: &mut Vec<Step>) {
            for i in p.children(parent) {
                let l = &p.layers[i];
                if !l.visible {
                    continue;
                }
                if l.group {
                    out.push(Step::Open(i));
                    walk(p, Some(l.id), out);
                    out.push(Step::Close(i));
                } else {
                    if l.mask.as_ref().is_some_and(|m| m.enabled) {
                        out.push(Step::Mask(i));
                    }
                    out.push(Step::Layer(i));
                }
            }
        }
        walk(self, None, &mut out);
        out
    }

    /// The shown layers' finished strokes (and their masks') as segments, in step order, each
    /// layer's strokes in order; the steps; and where each stroke number points. Stroke numbers
    /// count on through the steps; the next one (for a stroke being drawn) is
    /// `built.strokes.len()`.
    pub fn build(&self, out: &mut Vec<GpuSegment>) -> Built {
        out.clear();
        let steps = self.steps();
        let mut runs = Vec::new();
        let mut strokes = Vec::new();
        for (step, s) in steps.iter().enumerate() {
            let (layer, mask) = match *s {
                Step::Layer(l) => (l, false),
                Step::Mask(l) => (l, true),
                _ => continue,
            };
            let l = &self.layers[layer];
            let list = if mask { l.mask.as_ref().map_or(&[][..], |m| &m.strokes[..]) } else { &l.strokes[..] };
            let first = out.len();
            for (index, s) in list.iter().enumerate() {
                s.segments_in(self.filter, strokes.len() as u32, l.ordered, out);
                strokes.push(StrokeRef { layer, mask, index });
            }
            runs.push(LayerRun { step, first, count: out.len() - first });
        }
        Built { steps, runs, strokes }
    }

    /// The first stroke number of a layer's run (its strokes, or its mask's), from `built`.
    fn first_number(built: &Built, step: usize) -> u32 {
        // Stroke numbers count on through the runs, in step order.
        let mut n = 0;
        for r in &built.runs {
            if r.step == step {
                break;
            }
            let (layer, mask) = match built.steps[r.step] {
                Step::Layer(l) => (l, false),
                Step::Mask(l) => (l, true),
                _ => continue,
            };
            n += built.strokes.iter().filter(|s| s.layer == layer && s.mask == mask).count() as u32;
        }
        n
    }

    /// Puts a stroke into layer `layer` (by place), its strokes or its mask's, at `index`, and
    /// keeps `built` and `out` as `build` would make them, without making them all again: its
    /// segments go in among the others, and the stroke numbers after it count on by one.
    pub fn insert_stroke(&mut self, built: &mut Built, out: &mut Vec<GpuSegment>, layer: usize, mask: bool, index: usize, stroke: Stroke) {
        let l = &mut self.layers[layer];
        let ordered = l.ordered;
        let list = if mask { &mut l.mask.as_mut().expect("the layer has a mask").strokes } else { &mut l.strokes };
        let index = index.min(list.len());
        let Some(step) = built.step_of(layer, mask) else {
            list.insert(index, stroke);
            return;
        };
        let id = Self::first_number(built, step) + index as u32;
        let mut segs = Vec::new();
        stroke.segments_in(self.filter, id, ordered, &mut segs);
        list.insert(index, stroke);
        let run = built.runs.iter().position(|r| r.step == step).expect("a run per drawing step");
        let r = built.runs[run];
        let at = r.first + out[r.first..r.first + r.count].partition_point(|g| (g.style[1] as u32) < id);
        for g in &mut out[at..] {
            g.style[1] += 1.0;
        }
        let n = segs.len();
        out.splice(at..at, segs);
        built.runs[run].count += n;
        for r in &mut built.runs[run + 1..] {
            r.first += n;
        }
        for s in built.strokes.iter_mut().filter(|s| s.layer == layer && s.mask == mask && s.index >= index) {
            s.index += 1;
        }
        built.strokes.insert(id as usize, StrokeRef { layer, mask, index });
    }

    /// Takes out the stroke at `index` of layer `layer` (by place), its strokes or its mask's,
    /// keeping `built` and `out` as `build` would make them (see `insert_stroke`).
    pub fn remove_stroke(&mut self, built: &mut Built, out: &mut Vec<GpuSegment>, layer: usize, mask: bool, index: usize) -> Stroke {
        let l = &mut self.layers[layer];
        let list = if mask { &mut l.mask.as_mut().expect("the layer has a mask").strokes } else { &mut l.strokes };
        let stroke = list.remove(index);
        let Some(step) = built.step_of(layer, mask) else { return stroke };
        let id = Self::first_number(built, step) + index as u32;
        let run = built.runs.iter().position(|r| r.step == step).expect("a run per drawing step");
        let r = built.runs[run];
        let range = &out[r.first..r.first + r.count];
        let (from, to) = (r.first + range.partition_point(|g| (g.style[1] as u32) < id), r.first + range.partition_point(|g| (g.style[1] as u32) <= id));
        let n = to - from;
        out.drain(from..to);
        for g in &mut out[from..] {
            g.style[1] -= 1.0;
        }
        built.runs[run].count -= n;
        for r in &mut built.runs[run + 1..] {
            r.first -= n;
        }
        built.strokes.remove(id as usize);
        for s in built.strokes.iter_mut().filter(|s| s.layer == layer && s.mask == mask && s.index > index) {
            s.index -= 1;
        }
        stroke
    }

    /// The box around every sample (None when there are none).
    pub fn bounds(&self) -> Option<(Vec3, Vec3)> {
        let mut points = self.layers.iter().flat_map(|l| &l.strokes).flat_map(|s| &s.samples).map(|s| s.pos);
        let first = points.next()?;
        Some(points.fold((first, first), |(lo, hi), p| (lo.min(p), hi.max(p))))
    }

    // ---- Layer edits, as the 2D app's (engine.ts). Each returns the layer to make active. ----

    /// Where a new layer goes: right above `active` in its group; into a group, at its top.
    fn new_place(&self, active: Option<usize>) -> (usize, Option<u32>) {
        match active {
            Some(a) if self.layers[a].group => (a, Some(self.layers[a].id)),
            Some(a) => (a + 1, self.layers[a].parent),
            None => (self.layers.len(), None),
        }
    }

    /// The next free "Layer N" (or "Group N").
    fn next_name(&self, base: &str) -> String {
        let n = self.layers.iter().filter_map(|l| l.name.strip_prefix(base)?.trim().parse::<u32>().ok()).max().unwrap_or(0);
        format!("{base} {}", n + 1)
    }

    /// A new paint layer above the active one.
    pub fn add_layer(&mut self, active: Option<usize>) -> usize {
        let (at, parent) = self.new_place(active);
        let layer = Layer { id: self.new_id(), name: self.next_name("Layer"), parent, ..Default::default() };
        self.layers.insert(at, layer);
        at
    }

    /// A new empty group above the active layer.
    pub fn add_group(&mut self, active: Option<usize>) -> usize {
        let (at, parent) = self.new_place(active);
        let group = Layer { id: self.new_id(), name: self.next_name("Group"), parent, group: true, blend: Blend::Pass, ..Default::default() };
        self.layers.insert(at, group);
        at
    }

    /// Puts a layer (with what is in it) into a new group in its place.
    pub fn group_layer(&mut self, i: usize) -> usize {
        let block = self.block(i);
        let id = self.new_id();
        let group = Layer { id, name: self.next_name("Group"), parent: self.layers[i].parent, group: true, blend: Blend::Pass, ..Default::default() };
        self.layers[i].parent = Some(id);
        self.layers.insert(block.end, group);
        block.end
    }

    /// Takes a group's layers out (into its place) and removes the group. Returns the topmost
    /// of them (or what is below, for an empty group), and the group taken out.
    pub fn ungroup(&mut self, g: usize) -> (Option<usize>, Option<Layer>) {
        if !self.layers[g].group {
            return (Some(g), None);
        }
        let (id, parent) = (self.layers[g].id, self.layers[g].parent);
        let kids = self.children(Some(id));
        for &k in &kids {
            self.layers[k].parent = parent;
        }
        let group = self.layers.remove(g);
        (kids.last().copied().or(g.checked_sub(1)), Some(group))
    }

    /// Moves a layer (with what is in it) one place up or down among its siblings.
    pub fn move_layer(&mut self, i: usize, up: bool) -> usize {
        let parent = self.layers[i].parent;
        let sibs = self.children(parent);
        let k = sibs.iter().position(|&s| s == i).unwrap();
        let target = if up { sibs.get(k + 1) } else { k.checked_sub(1).map(|k| &sibs[k]) };
        match target {
            Some(&t) => self.move_to(i, t, if up { Place::Above } else { Place::Below }),
            None => i,
        }
    }

    /// Moves a layer (with what is in it) beside or into `target`. Not into itself. Returns
    /// where it went.
    pub fn move_to(&mut self, i: usize, target: usize, place: Place) -> usize {
        let block = self.block(i);
        if block.contains(&target) || (place == Place::Into && !self.layers[target].group) {
            return i;
        }
        let parent = if place == Place::Into { Some(self.layers[target].id) } else { self.layers[target].parent };
        let target_id = self.layers[target].id;
        let moved: Vec<Layer> = self.layers.drain(block.clone()).collect();
        let t = self.index_of(target_id).unwrap();
        let at = match place {
            Place::Above => t + 1,
            Place::Below => self.block(t).start,
            Place::Into => t,
        };
        let n = moved.len();
        for (k, mut l) in moved.into_iter().enumerate() {
            if k == n - 1 {
                l.parent = parent;
            }
            self.layers.insert(at + k, l);
        }
        at + n - 1
    }

    /// Copies a layer (with what is in it) above itself: "<name> copy".
    pub fn duplicate(&mut self, i: usize) -> usize {
        let block = self.block(i);
        let mut copies: Vec<Layer> = self.layers[block.clone()].to_vec();
        let mut next = self.new_id();
        let mut ids = std::collections::HashMap::new();
        for l in &mut copies {
            ids.insert(l.id, next);
            l.id = next;
            next += 1;
        }
        for l in &mut copies {
            l.parent = l.parent.map(|p| *ids.get(&p).unwrap_or(&p));
        }
        let top = copies.last_mut().unwrap();
        top.name = format!("{} copy", top.name);
        let n = copies.len();
        for (k, l) in copies.into_iter().enumerate() {
            self.layers.insert(block.end + k, l);
        }
        block.end + n - 1
    }

    /// Removes a layer (with what is in it), unless no paint layer would be left. Returns the
    /// layer to make active (the next paint layer below, else the first), and those taken out.
    pub fn delete(&mut self, i: usize) -> Option<(usize, Vec<Layer>)> {
        let block = self.block(i);
        if !self.layers.iter().enumerate().any(|(k, l)| !l.group && !block.contains(&k)) {
            return None;
        }
        let gone: Vec<Layer> = self.layers.drain(block.clone()).collect();
        let below = (0..block.start).rev().find(|&k| !self.layers[k].group);
        Some((below.or_else(|| self.layers.iter().position(|l| !l.group)).unwrap_or(0), gone))
    }

    /// Whether a layer can be clipped: there is a layer below it in its group.
    pub fn can_clip(&self, i: usize) -> bool {
        let sibs = self.children(self.layers[i].parent);
        sibs.first().is_some_and(|&f| f != i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stroke::{Brush, Sample};

    #[test]
    fn blend_names_are_the_2d_apps() {
        assert_eq!(Blend::from_name("color-burn"), Blend::ColorBurn);
        assert_eq!(Blend::from_name("add") as u32, 16);
        assert_eq!(Blend::from_name("pass"), Blend::Pass);
        assert_eq!(Blend::from_name("nonsense"), Blend::Normal);
    }

    fn stroke(x: f32) -> Stroke {
        let mut s = Stroke::new(Brush::default());
        s.push(Sample::new(Vec3::new(x, 1.0, 0.0), 1.0, 0.0));
        s.push(Sample::new(Vec3::new(x + 0.1, 1.0, 0.0), 1.0, 0.1));
        s
    }

    /// Names, bottom first.
    fn names(p: &Painting) -> Vec<&str> {
        p.layers.iter().map(|l| l.name.as_str()).collect()
    }

    #[test]
    fn strokes_go_in_and_out_as_a_build_would_make_them() {
        let mut p = Painting::default();
        p.layers[0].strokes = vec![stroke(0.0), stroke(1.0)];
        let top = p.add_layer(Some(0));
        p.layers[top].strokes = vec![stroke(2.0)];
        p.layers[top].mask = Some(Mask { enabled: true, strokes: vec![stroke(3.0)] });
        let mut out = Vec::new();
        let mut built = p.build(&mut out);
        let check = |p: &Painting, built: &Built, out: &Vec<GpuSegment>| {
            let mut want = Vec::new();
            let b = p.build(&mut want);
            assert_eq!((built.steps.clone(), built.runs.clone(), built.strokes.clone()), (b.steps, b.runs, b.strokes));
            assert_eq!(bytemuck::cast_slice::<_, u8>(out), bytemuck::cast_slice::<_, u8>(&want));
        };
        p.insert_stroke(&mut built, &mut out, 0, false, 1, stroke(4.0));
        check(&p, &built, &out);
        p.insert_stroke(&mut built, &mut out, top, true, 0, stroke(5.0));
        check(&p, &built, &out);
        p.insert_stroke(&mut built, &mut out, top, false, 1, stroke(6.0));
        check(&p, &built, &out);
        let gone = p.remove_stroke(&mut built, &mut out, 0, false, 0);
        assert_eq!(gone.samples[0].pos.x, 0.0);
        check(&p, &built, &out);
        p.remove_stroke(&mut built, &mut out, top, true, 1);
        check(&p, &built, &out);
    }

    #[test]
    fn steps_follow_the_tree() {
        let mut p = Painting::default();
        p.layers[0].strokes = vec![stroke(0.0), stroke(1.0)];
        let g = p.add_group(Some(0));
        let inner = p.add_layer(Some(g));
        p.layers[inner].strokes = vec![stroke(2.0)];
        p.layers[inner].mask = Some(Mask { enabled: true, strokes: vec![stroke(2.0)] });
        let g = p.layers.iter().position(|l| l.group).unwrap();
        let hidden = p.add_layer(Some(g));
        p.layers[hidden].visible = false;
        p.layers[hidden].strokes = vec![stroke(3.0)];
        assert_eq!(names(&p), vec!["Layer 1", "Layer 2", "Layer 3", "Group 1"]);
        let mut out = Vec::new();
        let built = p.build(&mut out);
        assert_eq!(built.steps, vec![Step::Layer(0), Step::Open(3), Step::Mask(1), Step::Layer(1), Step::Close(3)]);
        // Runs per drawing step, and stroke numbers through them (the hidden layer's left out).
        assert_eq!(built.runs.iter().map(|r| r.step).collect::<Vec<_>>(), vec![0, 2, 3]);
        assert_eq!(built.strokes.len(), 4);
        assert_eq!(built.strokes[2], StrokeRef { layer: 1, mask: true, index: 0 });
        assert!(out[built.runs[2].first].a[0] >= 2.0);
    }

    #[test]
    fn layer_edits_keep_the_tree_whole() {
        let mut p = Painting::default();
        let b = p.add_layer(Some(0)); // Layer 2 above Layer 1
        let g = p.group_layer(b); // Group 1 holding Layer 2
        assert_eq!(names(&p), vec!["Layer 1", "Layer 2", "Group 1"]);
        let gid = p.layers[g].id;
        assert!(p.is_in(1, gid));
        // A new layer with the group active goes to the group's top.
        let c = p.add_layer(Some(g));
        assert_eq!((names(&p)[c], p.layers[c].parent), ("Layer 3", Some(gid)));
        // Moving the bottom layer into the group.
        let g = p.index_of(gid).unwrap();
        let moved = p.move_to(0, g, Place::Into);
        assert_eq!(names(&p), vec!["Layer 2", "Layer 3", "Layer 1", "Group 1"]);
        assert_eq!(p.layers[moved].parent, Some(gid));
        // Not into itself.
        let g = p.index_of(gid).unwrap();
        assert_eq!(p.move_to(g, 0, Place::Above), g);
        // Duplicate the group: a copy above, with copies of its layers (new ids).
        let copy = p.duplicate(g);
        assert_eq!(names(&p)[copy], "Group 1 copy");
        assert_eq!(p.block(copy).len(), 4);
        let ids: std::collections::HashSet<u32> = p.layers.iter().map(|l| l.id).collect();
        assert_eq!(ids.len(), p.layers.len());
        // Ungroup the copy: its layers go to the top level; delete the group with its layers.
        p.ungroup(copy);
        assert_eq!(p.layers.iter().filter(|l| l.group).count(), 1);
        let g = p.index_of(gid).unwrap();
        p.delete(g).unwrap();
        assert_eq!(names(&p), vec!["Layer 2", "Layer 3", "Layer 1"]);
        // The last paint layer stays.
        let mut one = Painting::default();
        assert!(one.delete(0).is_none());
        // Up and down among siblings.
        let at = p.move_layer(0, true);
        assert_eq!((at, names(&p)), (1, vec!["Layer 3", "Layer 2", "Layer 1"]));
    }

    #[test]
    fn normalize_mends_a_file() {
        let mut p = Painting::default();
        p.layers = vec![
            Layer { name: "a".into(), parent: Some(9), ..Default::default() },
            Layer { id: 5, name: "g".into(), group: true, blend: Blend::Pass, ..Default::default() },
            Layer { id: 5, name: "b".into(), parent: Some(5), ..Default::default() },
        ];
        p.normalize();
        // Unique ids; a parent that is no group goes to the top level; b moves before its group.
        assert_eq!(names(&p), vec!["a", "b", "g"]);
        assert_eq!(p.layers[0].parent, None);
        let ids: std::collections::HashSet<u32> = p.layers.iter().map(|l| l.id).collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn a_painting_saves_and_loads() {
        let mut p = Painting::with_strokes(vec![Stroke::new(Brush::default())]);
        p.active()[0].push(Sample::new(Vec3::ONE, 0.5, 1.0));
        p.layers[0].blend = Blend::Multiply;
        let g = p.group_layer(0);
        p.layers[g].blend = Blend::Screen;
        let path = std::env::temp_dir().join(format!("vdraw-test-{}.vdraw", std::process::id()));
        crate::file::save(&path, &p).unwrap();
        let back = crate::file::load(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(back.layers[0].blend, Blend::Multiply);
        assert_eq!(back.layers[0].strokes[0].samples[0].pos, Vec3::ONE);
        assert_eq!((back.layers[1].group, back.layers[1].blend), (true, Blend::Screen));
        assert_eq!(back.layers[0].parent, Some(back.layers[1].id));
    }
}
