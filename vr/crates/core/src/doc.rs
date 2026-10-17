//! The 2D app's canvas document (multiplayer-canvas src/shared/types.ts, docState.ts,
//! layers.ts, ids.ts), as it comes over the wire: its layers, strokes, shapes, paper and paint
//! mixing, and the ops that change it, applied by the same rules as the server's `DocState`.
//! A shared canvas is this document; vdraw draws it (see the app's canvas module).
//!
//! Fields this client does not use are kept as they came (`extra`), so what it sends back keeps
//! them. Shapes are kept as JSON. The ops that turn shapes into paint and back
//! (`shapes.toPaint`, `shapes.fromPaint`) are not applied here: they ask for the document again.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// The most layers, and how deep groups nest (LIMITS).
pub const MAX_LAYERS: usize = 100;
pub const MAX_GROUP_DEPTH: usize = 8;
/// Coordinates and brush sizes stay within these (LIMITS.maxCoord, min/maxBrushWorld).
pub const MAX_COORD: f64 = 1e15;
pub const BRUSH_WORLD: (f64, f64) = (1e-12, 1e15);

/// A 2D brush (types.ts Brush). The optional dynamics stay in `extra` under their own names.
/// What an older file leaves out takes the 2D app's defaults.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DocBrush {
    /// "paint" or "erase".
    pub tool: String,
    /// "#rrggbb".
    pub color: String,
    /// The diameter, world units.
    pub size: f64,
    pub opacity: f64,
    pub flow: f64,
    pub hardness: f64,
    pub spacing: f64,
    pub pressure_size: bool,
    pub pressure_flow: bool,
    pub buildup: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for DocBrush {
    fn default() -> Self {
        Self {
            tool: "paint".into(),
            color: "#000000".into(),
            size: 1.0,
            opacity: 1.0,
            flow: 1.0,
            hardness: 0.8,
            spacing: 0.1,
            pressure_size: true,
            pressure_flow: false,
            buildup: false,
            extra: Map::new(),
        }
    }
}

impl DocBrush {
    /// An optional number (angle, roundness, sizeJitter, ...).
    pub fn num(&self, key: &str) -> Option<f64> {
        self.extra.get(key).and_then(Value::as_f64)
    }

    pub fn flag(&self, key: &str) -> bool {
        self.extra.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn text(&self, key: &str) -> Option<&str> {
        self.extra.get(key).and_then(Value::as_str)
    }
}

/// A stroke (types.ts Stroke): `pts` is x, y, pressure, ... in world units (y down).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocStroke {
    pub id: String,
    pub layer_id: String,
    /// Its place in the paint order (the op's seq); absent before the server has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub brush: DocBrush,
    pub pts: Vec<f64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    /// The mask (its id) it paints, when it is a mask stroke.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
    /// A stroke painted in 3D (on a 3D layer): its points' depth, and the pen's up side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threed: Option<StrokeThreeD>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A 3D stroke's depth (types.ts Stroke.threed): `z`, one per point, in canvas units toward the
/// 2D viewer (out of the paper); `up`, three per point, the pen's up side in canvas axes (x
/// right, y down, z toward the viewer). The 2D app draws the stroke flat (x, y).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StrokeThreeD {
    pub z: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub up: Option<Vec<f64>>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LayerMask {
    pub id: String,
    pub enabled: bool,
}

/// A layer (types.ts Layer). `kind`: None (paint), "group", "adjust", "shape".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocLayer {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Sorts the layers of one parent, bottom to top.
    #[serde(default)]
    pub order: f64,
    /// A blend mode's name ("normal", "color-burn", ...; "pass" for a group).
    #[serde(default = "normal")]
    pub blend: String,
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<LayerMask>,
    /// A 3D layer (painted in 3D in vdraw): its strokes may have depth. Set when it is made.
    #[serde(default, skip_serializing_if = "is_false")]
    pub threed: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn normal() -> String {
    "normal".into()
}

fn one() -> f64 {
    1.0
}

fn yes() -> bool {
    true
}

impl DocLayer {
    pub fn is_group(&self) -> bool {
        self.kind.as_deref() == Some("group")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Paper {
    pub color: String,
    pub alpha: f64,
}

impl Default for Paper {
    fn default() -> Self {
        Self { color: "#ffffff".into(), alpha: 1.0 }
    }
}

/// An op (types.ts Op), as JSON: `type` and its fields. Kept as JSON so that what is not
/// handled here still goes through untouched.
pub type Op = Value;

/// Why an op cannot apply (the server's OpError), or that the document must be fetched again.
#[derive(Clone, Debug, PartialEq)]
pub enum OpError {
    Refused(String),
    /// The op is one this client does not apply (shapes to paint and back): load it again.
    Reload,
}

fn refused<T>(why: &str) -> Result<T, OpError> {
    Err(OpError::Refused(why.into()))
}

/// The canvas document.
#[derive(Clone, Debug, Default)]
pub struct Doc {
    pub layers: HashMap<String, DocLayer>,
    pub strokes: HashMap<String, DocStroke>,
    pub shapes: HashMap<String, Value>,
    pub paper: Paper,
    /// "normal" or "pigment".
    pub mix: String,
}

impl Doc {
    /// From a welcome's (or a .bdraw file's) arrays.
    pub fn from_parts(layers: Vec<DocLayer>, strokes: Vec<DocStroke>, shapes: Vec<Value>, paper: Option<Paper>, mix: Option<String>) -> Self {
        Self {
            layers: layers.into_iter().map(|l| (l.id.clone(), l)).collect(),
            strokes: strokes.into_iter().map(|s| (s.id.clone(), s)).collect(),
            shapes: shapes.into_iter().filter_map(|s| Some((s.get("id")?.as_str()?.to_string(), s))).collect(),
            paper: paper.unwrap_or_default(),
            mix: mix.unwrap_or_else(|| "normal".into()),
        }
    }

    /// Deleted itself, under a deleted group, or under a group that does not exist (layers.ts).
    pub fn effectively_deleted(&self, l: &DocLayer) -> bool {
        if l.deleted {
            return true;
        }
        let mut seen = HashSet::from([l.id.as_str()]);
        let mut cur = l;
        while let Some(p) = cur.parent.as_deref() {
            match self.layers.get(p) {
                Some(g) if !g.deleted && g.is_group() && seen.insert(g.id.as_str()) => cur = g,
                _ => return true,
            }
        }
        false
    }

    /// Visible itself and in every group above.
    pub fn effectively_visible(&self, l: &DocLayer) -> bool {
        let mut seen = HashSet::from([l.id.as_str()]);
        let mut cur = l;
        loop {
            if !cur.visible {
                return false;
            }
            match cur.parent.as_deref().and_then(|p| self.layers.get(p)) {
                Some(g) if seen.insert(g.id.as_str()) => cur = g,
                _ => return true,
            }
        }
    }

    /// The live layers of a parent (None: the top level), bottom to top (sortLayers: by order,
    /// then id).
    pub fn children(&self, parent: Option<&str>) -> Vec<&DocLayer> {
        let mut out: Vec<&DocLayer> = self.layers.values().filter(|l| !l.deleted && l.parent.as_deref() == parent).collect();
        out.sort_by(|a, b| a.order.total_cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// Live layers in paint order (bottom to top): a group's layers, then the group (paintOrder).
    pub fn paint_order(&self) -> Vec<&DocLayer> {
        let mut out = Vec::new();
        fn walk<'a>(doc: &'a Doc, parent: Option<&str>, depth: usize, out: &mut Vec<&'a DocLayer>) {
            for l in doc.children(parent) {
                if l.is_group() && depth < 64 {
                    walk(doc, Some(&l.id), depth + 1, out);
                }
                out.push(l);
            }
        }
        walk(self, None, 0, &mut out);
        out
    }

    /// A layer's strokes (not deleted), in paint order (by seq); its mask's when `mask` is set.
    pub fn strokes_of(&self, layer: &str, mask: Option<&str>) -> Vec<&DocStroke> {
        let mut out: Vec<&DocStroke> = self.strokes.values().filter(|s| !s.deleted && s.layer_id == layer && s.mask.as_deref() == mask).collect();
        out.sort_by_key(|s| s.seq.unwrap_or(u64::MAX));
        out
    }

    /// The ids of the group `id` and everything in it at any depth (deleted layers too).
    pub fn subtree_ids(&self, id: &str) -> HashSet<String> {
        let mut out = HashSet::new();
        let mut todo = vec![id.to_string()];
        while let Some(x) = todo.pop() {
            if out.insert(x.clone()) {
                todo.extend(self.layers.values().filter(|l| l.parent.as_deref() == Some(x.as_str())).map(|l| l.id.clone()));
            }
        }
        out
    }

    fn depth_of(&self, l: &DocLayer) -> usize {
        let mut d = 0;
        let mut seen = HashSet::from([l.id.as_str()]);
        let mut cur = l;
        while let Some(g) = cur.parent.as_deref().and_then(|p| self.layers.get(p)) {
            if !seen.insert(g.id.as_str()) {
                break;
            }
            d += 1;
            cur = g;
        }
        d
    }

    /// Levels a layer needs below its place: 0, or for a group 1 + the most its layers need.
    fn subtree_height(&self, id: &str, depth: usize) -> usize {
        match self.layers.get(id) {
            Some(l) if l.is_group() && depth <= 64 => {
                1 + self.layers.values().filter(|k| k.parent.as_deref() == Some(id) && !k.deleted).map(|k| self.subtree_height(&k.id, depth + 1)).max().unwrap_or(0)
            }
            _ => 0,
        }
    }

    fn check_parent(&self, parent: Option<&str>, height: usize) -> Result<(), OpError> {
        let Some(p) = parent else { return Ok(()) };
        match self.layers.get(p) {
            Some(g) if g.is_group() && !self.effectively_deleted(g) => {
                if self.depth_of(g) + 1 + height > MAX_GROUP_DEPTH {
                    refused("groups nested too deep")
                } else {
                    Ok(())
                }
            }
            _ => refused("no such group"),
        }
    }

    fn live_layers(&self) -> usize {
        self.layers.values().filter(|l| !self.effectively_deleted(l)).count()
    }

    /// Applies an op as the server did (`by`: its author, `seq`: its place). The broadcast of a
    /// restore carries the whole stroke or shape: it is taken from there when this client does
    /// not have it.
    pub fn apply(&mut self, op: &Op, by: &str, seq: u64) -> Result<(), OpError> {
        let field = |k: &str| op.get(k);
        let id = || field("id").and_then(Value::as_str).unwrap_or("").to_string();
        match op.get("type").and_then(Value::as_str).unwrap_or("") {
            "stroke.add" => {
                let mut stroke: DocStroke = serde_json::from_value(field("stroke").cloned().unwrap_or(Value::Null)).map_err(|e| OpError::Refused(e.to_string()))?;
                let Some(layer) = self.layers.get(&stroke.layer_id) else { return refused("no such layer") };
                if self.effectively_deleted(layer) {
                    return refused("no such layer");
                }
                match layer.kind.as_deref() {
                    Some("group") => return refused("groups hold no paint"),
                    Some("adjust") | Some("shape") if stroke.mask.is_none() => return refused("this layer holds no paint"),
                    _ => {}
                }
                if self.strokes.contains_key(&stroke.id) {
                    return refused("duplicate stroke");
                }
                stroke.seq = Some(seq);
                stroke.author = Some(by.to_string());
                stroke.deleted = false;
                self.strokes.insert(stroke.id.clone(), stroke);
            }
            "stroke.remove" => match self.strokes.get_mut(&id()) {
                Some(s) if !s.deleted => s.deleted = true,
                _ => return refused("no such stroke"),
            },
            "stroke.restore" => match self.strokes.get_mut(&id()) {
                Some(s) if s.deleted => s.deleted = false,
                Some(_) => return refused("stroke not deleted"),
                None => {
                    // A stroke this client never saw: the broadcast brings it whole.
                    let s: DocStroke = serde_json::from_value(field("stroke").cloned().unwrap_or(Value::Null)).map_err(|_| OpError::Refused("no such stroke".into()))?;
                    self.strokes.insert(s.id.clone(), DocStroke { deleted: false, ..s });
                }
            },
            "layer.add" => {
                let mut layer: DocLayer = serde_json::from_value(field("layer").cloned().unwrap_or(Value::Null)).map_err(|e| OpError::Refused(e.to_string()))?;
                if self.layers.contains_key(&layer.id) {
                    return refused("duplicate layer");
                }
                if self.live_layers() >= MAX_LAYERS {
                    return refused("too many layers");
                }
                self.check_parent(layer.parent.as_deref(), if layer.is_group() { 1 } else { 0 })?;
                if layer.extra.get("effects").and_then(Value::as_array).is_some_and(|e| e.is_empty()) {
                    layer.extra.remove("effects");
                }
                layer.deleted = false;
                self.layers.insert(layer.id.clone(), layer);
            }
            "layer.update" => {
                let id = id();
                let Some(l) = self.layers.get(&id) else { return refused("no such layer") };
                let mut props = field("props").and_then(Value::as_object).cloned().unwrap_or_default();
                // A layer's kind is set when it is made (whether it is a 3D layer can change).
                props.remove("kind");
                if props.get("blend").and_then(Value::as_str) == Some("pass") && !l.is_group() {
                    return refused("pass through is for groups");
                }
                if let Some(p) = props.get("parent") {
                    let p = p.as_str().map(str::to_string);
                    if p != l.parent {
                        if p.as_ref().is_some_and(|p| self.subtree_ids(&id).contains(p)) {
                            return refused("a group cannot go into itself");
                        }
                        self.check_parent(p.as_deref(), self.subtree_height(&id, 0))?;
                    }
                }
                // The props over the layer (a null removes: parent, mask, effects).
                let mut v = serde_json::to_value(&self.layers[&id]).unwrap_or(Value::Null);
                if let Some(obj) = v.as_object_mut() {
                    for (k, val) in props {
                        if val.is_null() {
                            obj.remove(&k);
                        } else {
                            obj.insert(k, val);
                        }
                    }
                    if obj.get("effects").and_then(Value::as_array).is_some_and(|e| e.is_empty()) {
                        obj.remove("effects");
                    }
                }
                let next: DocLayer = serde_json::from_value(v).map_err(|e| OpError::Refused(e.to_string()))?;
                self.layers.insert(id, next);
            }
            "layer.remove" => match self.layers.get_mut(&id()) {
                Some(l) if !l.deleted => l.deleted = true,
                _ => return refused("no such layer"),
            },
            "layer.restore" => match self.layers.get_mut(&id()) {
                Some(l) if l.deleted => l.deleted = false,
                _ => return refused("layer not deleted"),
            },
            "layer.transform" => {
                let id = id();
                let Some(l) = self.layers.get(&id) else { return refused("no such layer") };
                if self.effectively_deleted(l) {
                    return refused("no such layer");
                }
                // A 3D layer moved in 3D (m3), its strokes' depth with it.
                if let Some(m3) = field("m3") {
                    let m3: [f64; 12] = serde_json::from_value(m3.clone()).map_err(|_| OpError::Refused("bad transform".into()))?;
                    if !l.threed || l.is_group() {
                        return refused("3D transforms are for 3D layers");
                    }
                    let mut changes = Vec::new();
                    for s in self.strokes.values().filter(|s| s.layer_id == id) {
                        if s.extra.contains_key("vector") {
                            return refused("vector strokes do not move in 3D");
                        }
                        match transform_stroke_3d(s, &m3) {
                            Some(t) => changes.push((s.id.clone(), t)),
                            None => return refused("the transform goes out of range"),
                        }
                    }
                    for (sid, (pts, brush, vr)) in changes {
                        let s = self.strokes.get_mut(&sid).unwrap();
                        s.pts = pts;
                        s.brush = brush;
                        s.threed = vr;
                    }
                    return Ok(());
                }
                let m: [f64; 6] = serde_json::from_value(field("m").cloned().unwrap_or(Value::Null)).map_err(|_| OpError::Refused("bad transform".into()))?;
                let ids = self.subtree_ids(&id);
                let mut changes = Vec::new();
                for s in self.strokes.values() {
                    if ids.contains(&s.layer_id) {
                        // A vector stroke's shape matrix would have to follow: load it again.
                        if s.extra.contains_key("vector") {
                            return Err(OpError::Reload);
                        }
                        match transform_stroke(s, &m) {
                            Some(t) => changes.push((s.id.clone(), t)),
                            None => return refused("the transform goes out of range"),
                        }
                    }
                }
                if self.shapes.values().any(|sh| sh.get("layerId").and_then(Value::as_str).is_some_and(|l| ids.contains(l))) {
                    return Err(OpError::Reload);
                }
                for (sid, (pts, brush, vr)) in changes {
                    let s = self.strokes.get_mut(&sid).unwrap();
                    s.pts = pts;
                    s.brush = brush;
                    s.threed = vr;
                }
                // Effect lengths scale too (effects are not drawn here; a reload keeps them right).
                if ids.iter().any(|lid| self.layers.get(lid).is_some_and(|l| l.extra.contains_key("effects") || l.extra.contains_key("adjust"))) {
                    return Err(OpError::Reload);
                }
            }
            "layer.duplicate" => {
                let src_id = id();
                let Some(src) = self.layers.get(&src_id) else { return refused("no such layer") };
                if self.effectively_deleted(src) {
                    return refused("no such layer");
                }
                let new_id = field("newId").and_then(Value::as_str).unwrap_or("").to_string();
                if self.layers.contains_key(&new_id) {
                    return refused("duplicate layer");
                }
                let parent = field("parent").and_then(Value::as_str).map(str::to_string);
                self.check_parent(parent.as_deref(), self.subtree_height(&src_id, 0))?;
                let name = field("name").and_then(Value::as_str).unwrap_or("").to_string();
                let order = field("order").and_then(Value::as_f64).unwrap_or(0.0);
                let (layers, strokes, shapes) = self.duplicate_of(&src_id, &new_id, &name, order, parent);
                if self.live_layers() + layers.len() > MAX_LAYERS {
                    return refused("too many layers");
                }
                if layers.iter().any(|l| self.layers.contains_key(&l.id)) || strokes.iter().any(|s| self.strokes.contains_key(&s.id)) || shapes.iter().any(|(id, _)| self.shapes.contains_key(id)) {
                    return refused("duplicate ids");
                }
                for l in layers {
                    self.layers.insert(l.id.clone(), l);
                }
                for s in strokes {
                    self.strokes.insert(s.id.clone(), s);
                }
                for (id, sh) in shapes {
                    self.shapes.insert(id, sh);
                }
            }
            "shape.add" => {
                let mut shape = field("shape").cloned().unwrap_or(Value::Null);
                let sid = shape.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                if self.shapes.contains_key(&sid) {
                    return refused("duplicate shape");
                }
                if let Some(o) = shape.as_object_mut() {
                    o.insert("author".into(), by.into());
                    o.insert("seq".into(), seq.into());
                }
                self.shapes.insert(sid, shape);
            }
            "shape.update" => {
                let sid = id();
                let Some(shape) = self.shapes.get_mut(&sid) else { return refused("no such shape") };
                if let (Some(o), Some(props)) = (shape.as_object_mut(), field("props").and_then(Value::as_object)) {
                    for (k, v) in props {
                        o.insert(k.clone(), v.clone());
                    }
                }
            }
            "shape.remove" => match self.shapes.get_mut(&id()).and_then(Value::as_object_mut) {
                Some(o) => {
                    o.insert("deleted".into(), true.into());
                }
                None => return refused("no such shape"),
            },
            "shape.restore" => {
                let sid = id();
                match self.shapes.get_mut(&sid).and_then(Value::as_object_mut) {
                    Some(o) => {
                        o.remove("deleted");
                    }
                    None => {
                        if let Some(sh) = field("shape").cloned() {
                            self.shapes.insert(sid, sh);
                        }
                    }
                }
            }
            "mix.set" => self.mix = field("mix").and_then(Value::as_str).unwrap_or("normal").to_string(),
            "paper.set" => {
                if let Some(p) = field("paper").cloned().and_then(|p| serde_json::from_value(p).ok()) {
                    self.paper = p;
                }
            }
            _ => return Err(OpError::Reload),
        }
        Ok(())
    }

    /// The copies `layer.duplicate` makes (layers.ts duplicateOf): the layer or group with its
    /// live layers, strokes and shapes, the top one with the op's id, name, order and parent,
    /// the rest with ids derived from the copy's.
    fn duplicate_of(&self, src: &str, new_id: &str, name: &str, order: f64, parent: Option<String>) -> (Vec<DocLayer>, Vec<DocStroke>, Vec<(String, Value)>) {
        let mut map: HashMap<String, String> = HashMap::from([(src.to_string(), new_id.to_string())]);
        let mut out = Vec::new();
        fn walk(doc: &Doc, l: &DocLayer, top: bool, new_id: &str, name: &str, order: f64, parent: &Option<String>, map: &mut HashMap<String, String>, out: &mut Vec<DocLayer>) {
            let nid = if top { new_id.to_string() } else { derived_id(new_id, &l.id) };
            map.insert(l.id.clone(), nid.clone());
            let mut copy = DocLayer { id: nid, deleted: false, ..l.clone() };
            if top {
                copy.name = name.to_string();
                copy.order = order;
                copy.parent = parent.clone();
            } else {
                copy.parent = l.parent.as_ref().and_then(|p| map.get(p).cloned());
            }
            out.push(copy);
            if l.is_group() {
                for k in doc.children(Some(&l.id)) {
                    walk(doc, k, false, new_id, name, order, parent, map, out);
                }
            }
        }
        if let Some(l) = self.layers.get(src) {
            walk(self, l, true, new_id, name, order, &parent, &mut map, &mut out);
        }
        let strokes = self
            .strokes
            .values()
            .filter(|s| !s.deleted)
            .filter_map(|s| Some(DocStroke { id: derived_id(new_id, &s.id), layer_id: map.get(&s.layer_id)?.clone(), ..s.clone() }))
            .collect();
        let shapes = self
            .shapes
            .values()
            .filter(|s| s.get("deleted").and_then(Value::as_bool) != Some(true))
            .filter_map(|s| {
                let nl = map.get(s.get("layerId")?.as_str()?)?.clone();
                let nid = derived_id(new_id, s.get("id")?.as_str()?);
                let mut c = s.clone();
                c["id"] = nid.clone().into();
                c["layerId"] = nl.into();
                Some((nid, c))
            })
            .collect();
        (out, strokes, shapes)
    }
}

/// A stroke after an affine transform [a, b, c, d, e, f] (layers.ts transformStroke): points
/// mapped, the size scaled by the square root of |det|, a fixed tip angle turned with the
/// rotation. None: out of range.
pub fn transform_stroke(s: &DocStroke, m: &[f64; 6]) -> Option<(Vec<f64>, DocBrush, Option<StrokeThreeD>)> {
    let mut pts = s.pts.clone();
    for p in pts.chunks_exact_mut(3) {
        let (x, y) = (p[0], p[1]);
        let (nx, ny) = (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
        if !(nx.abs() <= MAX_COORD && ny.abs() <= MAX_COORD) {
            return None;
        }
        p[0] = nx;
        p[1] = ny;
    }
    let scale = (m[0] * m[3] - m[1] * m[2]).abs().sqrt();
    let size = s.brush.size * scale;
    if !(size >= BRUSH_WORLD.0 && size <= BRUSH_WORLD.1) {
        return None;
    }
    let mut brush = DocBrush { size, ..s.brush.clone() };
    let shaped = brush.extra.contains_key("angle") || brush.text("tip").is_some_and(|t| t != "round") || brush.num("roundness").unwrap_or(1.0) < 1.0;
    if shaped && !brush.flag("followDirection") {
        let deg = m[1].atan2(m[0]).to_degrees();
        let angle = ((brush.num("angle").unwrap_or(0.0) + deg) % 360.0 + 360.0) % 360.0;
        brush.extra.insert("angle".into(), angle.into());
    }
    // A 3D stroke's depth scales as the canvas does; the pen's up side turns with it.
    let vr = match &s.threed {
        Some(v) => {
            let z: Vec<f64> = v.z.iter().map(|z| z * scale).collect();
            if z.iter().any(|z| !(z.abs() <= MAX_COORD)) {
                return None;
            }
            let up = v.up.as_ref().map(|up| {
                let mut out = up.clone();
                for u in out.chunks_exact_mut(3) {
                    let t = [m[0] * u[0] + m[2] * u[1], m[1] * u[0] + m[3] * u[1], scale * u[2]];
                    let len = (t[0] * t[0] + t[1] * t[1] + t[2] * t[2]).sqrt();
                    if len > 1e-12 {
                        // Rounded as clients send them (validate.ts).
                        u.copy_from_slice(&t.map(|c| (c / len * 1000.0).round() / 1000.0));
                    }
                }
                out
            });
            Some(StrokeThreeD { z, up })
        }
        None => None,
    };
    Some((pts, brush, vr))
}

/// A stroke moved by a 3D similarity in canvas units (column-major 3x4: x' = m[0] x + m[3] y +
/// m[6] z + m[9], ...), as the 2D app's layer.transform with `m3`: its points and their depth
/// (a stroke without depth gets it), its up sides turned, its size scaled, its tip turned by
/// the turn in the paper's plane.
pub fn transform_stroke_3d(s: &DocStroke, m: &[f64; 12]) -> Option<(Vec<f64>, DocBrush, Option<StrokeThreeD>)> {
    let det = m[0] * (m[4] * m[8] - m[7] * m[5]) - m[3] * (m[1] * m[8] - m[7] * m[2]) + m[6] * (m[1] * m[5] - m[4] * m[2]);
    let scale = det.abs().cbrt();
    let n = s.pts.len() / 3;
    let mut pts = s.pts.clone();
    let mut z = Vec::with_capacity(n);
    for i in 0..n {
        let (x, y, d) = (pts[3 * i], pts[3 * i + 1], s.threed.as_ref().and_then(|v| v.z.get(i)).copied().unwrap_or(0.0));
        let p = [m[0] * x + m[3] * y + m[6] * d + m[9], m[1] * x + m[4] * y + m[7] * d + m[10], m[2] * x + m[5] * y + m[8] * d + m[11]];
        if p.iter().any(|c| !(c.abs() <= MAX_COORD)) {
            return None;
        }
        pts[3 * i] = p[0];
        pts[3 * i + 1] = p[1];
        z.push(p[2]);
    }
    let size = s.brush.size * scale;
    if !(size >= BRUSH_WORLD.0 && size <= BRUSH_WORLD.1) {
        return None;
    }
    let mut brush = DocBrush { size, ..s.brush.clone() };
    let shaped = brush.extra.contains_key("angle") || brush.text("tip").is_some_and(|t| t != "round") || brush.num("roundness").unwrap_or(1.0) < 1.0;
    if shaped && !brush.flag("followDirection") {
        let deg = m[1].atan2(m[0]).to_degrees();
        let angle = ((brush.num("angle").unwrap_or(0.0) + deg) % 360.0 + 360.0) % 360.0;
        brush.extra.insert("angle".into(), angle.into());
    }
    let up = s.threed.as_ref().and_then(|v| v.up.as_ref()).map(|up| {
        let mut out = up.clone();
        for u in out.chunks_exact_mut(3) {
            let t = [m[0] * u[0] + m[3] * u[1] + m[6] * u[2], m[1] * u[0] + m[4] * u[1] + m[7] * u[2], m[2] * u[0] + m[5] * u[1] + m[8] * u[2]];
            let len = (t[0] * t[0] + t[1] * t[1] + t[2] * t[2]).sqrt();
            if len > 1e-12 {
                u.copy_from_slice(&t.map(|c| (c / len * 1000.0).round() / 1000.0));
            }
        }
        out
    });
    Some((pts, brush, Some(StrokeThreeD { z, up })))
}

/// How the document's canvas units map into a painting's space: a point (x, y) (2D: y down)
/// at depth z goes to `offset + ((x - anchor.x) k, -(y - anchor.y) k, z k)` (y up, z out of the
/// paper toward a 2D viewer).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub anchor: [f64; 2],
    pub k: f64,
    pub offset: glam::Vec3,
}

impl Frame {
    pub fn point(&self, x: f64, y: f64, z: f64) -> glam::Vec3 {
        self.offset + glam::Vec3::new(((x - self.anchor[0]) * self.k) as f32, (-(y - self.anchor[1]) * self.k) as f32, (z * self.k) as f32)
    }

    /// A painting point back in canvas units (x, y, z).
    pub fn canvas(&self, p: glam::Vec3) -> [f64; 3] {
        let d = (p - self.offset).as_dvec3() / self.k;
        [self.anchor[0] + d.x, self.anchor[1] - d.y, d.z]
    }
}

/// A painting made of a document: its layers (adjustment and shape layers left out) and, by
/// place, the document layer each came from.
pub struct Converted {
    pub painting: crate::Painting,
    pub layer_ids: Vec<String>,
}

/// "#rrggbb" to sRGB 0..1.
pub fn hex_rgb(s: &str) -> [f32; 3] {
    let s = s.trim_start_matches('#');
    let c = |i: usize| u8::from_str_radix(s.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f32 / 255.0;
    if s.len() >= 6 { [c(0), c(2), c(4)] } else { [0.0; 3] }
}

/// A 2D brush as vdraw's (radius by the frame's scale): it comes along whole: the dabs (flow,
/// spacing), its opacity capping each stroke, hardness, the tip's roundness, the eraser, and the
/// dynamics with the 2D app's random numbers (seeded by the stroke's id).
pub fn brush(b: &DocBrush, k: f64, stroke_id: &str) -> crate::Brush {
    let num = |key: &str, d: f64| b.num(key).unwrap_or(d);
    let (flow, spacing) = (b.flow as f32, (b.spacing as f32).max(0.005));
    crate::Brush {
        radius: (b.size * 0.5 * k) as f32,
        color: crate::segments::to_linear(hex_rgb(&b.color)),
        pressure_size: b.pressure_size,
        min_ratio: 0.02,
        opacity: b.opacity as f32,
        hardness: b.hardness as f32,
        roundness: num("roundness", 1.0).clamp(0.05, 1.0) as f32,
        erase: b.tool == "erase",
        dabs: Some(crate::stroke::Dabs { flow, spacing, pressure_flow: b.pressure_flow }),
        flow,
        spacing,
        pressure_flow: b.pressure_flow,
        buildup: b.buildup,
        size_jitter: num("sizeJitter", 0.0).clamp(0.0, 1.0) as f32,
        angle_jitter: num("angleJitter", 0.0).clamp(0.0, 1.0) as f32,
        scatter: num("scatter", 0.0).clamp(0.0, 4.0) as f32,
        flow_jitter: num("opacityJitter", 0.0).clamp(0.0, 1.0) as f32,
        seed: crate::stroke::stroke_seed(stroke_id),
    }
}

/// A document stroke as vdraw's, in the frame's space: its points (depth 0: on the paper), and
/// the tip's turn as the 2D app's dabs (brush.ts DabWalker): its angle (degrees, clockwise on
/// the canvas, whose y runs down), plus the direction of travel when it follows it. Its width
/// lies along the turned x; it is squashed along the turned y, which is the pen's up direction.
pub fn stroke(id: &str, b: &DocBrush, pts: &[f64], vr: Option<&StrokeThreeD>, frame: &Frame) -> crate::Stroke {
    let mut out = crate::Stroke::new(brush(b, frame.k, id));
    let angle = b.num("angle").unwrap_or(0.0).to_radians();
    let follow = b.flag("followDirection");
    let pts: Vec<[f64; 3]> = pts.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    let mut dir = 0.0f64;
    for (i, p) in pts.iter().enumerate() {
        // The direction of the last piece (the first point: of the first piece).
        let (from, to) = if i == 0 { (pts[0], *pts.get(1).unwrap_or(&pts[0])) } else { (pts[i - 1], pts[i]) };
        if (to[0] - from[0]).hypot(to[1] - from[1]) > 0.0 {
            dir = (to[1] - from[1]).atan2(to[0] - from[0]);
        }
        let rot = angle + if follow { dir } else { 0.0 };
        let mut up = glam::Vec3::new(-rot.sin() as f32, -rot.cos() as f32, 0.0);
        // A 3D stroke: its depth, and the pen's own up side (canvas axes: y runs down).
        let z = vr.and_then(|v| v.z.get(i)).copied().unwrap_or(0.0);
        if let Some(u) = vr.and_then(|v| v.up.as_ref()).and_then(|u| u.get(3 * i..3 * i + 3)) {
            up = glam::Vec3::new(u[0] as f32, -u[1] as f32, u[2] as f32).normalize_or(up);
        }
        out.push(crate::Sample { up, ..crate::Sample::new(frame.point(p[0], p[1], z), p[2] as f32, i as f64) });
    }
    out
}

impl Doc {
    /// The layers a painting of the document has, in paint order: the live ones but shape
    /// layers.
    pub fn painted_layers(&self) -> Vec<&DocLayer> {
        self.paint_order().into_iter().filter(|l| l.kind.as_deref() != Some("shape")).collect()
    }

    /// The box (x0, y0, x1, y1) around every live stroke's points and brush (None: none).
    pub fn bounds(&self) -> Option<[f64; 4]> {
        let mut b: Option<[f64; 4]> = None;
        for s in self.strokes.values().filter(|s| !s.deleted) {
            let r = s.brush.size * 0.5;
            for p in s.pts.chunks_exact(3) {
                let e = b.get_or_insert([p[0] - r, p[1] - r, p[0] + r, p[1] + r]);
                *e = [e[0].min(p[0] - r), e[1].min(p[1] - r), e[2].max(p[0] + r), e[3].max(p[1] + r)];
            }
        }
        b
    }

    /// The document as a painting in a frame's space: its live layers in paint order (groups,
    /// blend modes, opacity, visibility, clipping, masks; adjustment and shape layers left
    /// out), their strokes in order, the paint mixing. 2D layers are ordered (their strokes
    /// cover each other in order, as in the 2D app).
    pub fn painting(&self, frame: &Frame) -> Converted {
        let mut layers = Vec::new();
        let mut ids = Vec::new();
        let mut num: HashMap<&str, u32> = HashMap::new();
        for l in self.painted_layers() {
            let id = layers.len() as u32 + 1;
            num.insert(&l.id, id);
            let group = l.is_group();
            // A flat layer's strokes lie on the paper (a 3D layer made flat keeps their depth
            // for when it is made a 3D layer again).
            let strokes = |mask: Option<&str>| self.strokes_of(&l.id, mask).into_iter().map(|s| stroke(&s.id, &s.brush, &s.pts, s.threed.as_ref().filter(|_| l.threed), frame)).collect::<Vec<_>>();
            layers.push(crate::Layer {
                id,
                name: l.name.clone(),
                blend: crate::Blend::from_name(&l.blend),
                opacity: l.opacity as f32,
                visible: l.visible,
                // A shared canvas's strokes cover each other in order, as the 2D app draws them;
                // a 3D layer's have depth too.
                ordered: !group,
                threed: l.threed && !group,
                group,
                parent: None,
                clip: l.clip.unwrap_or(false),
                mask: l.mask.as_ref().filter(|_| !group).map(|m| crate::Mask { enabled: m.enabled, strokes: strokes(Some(&m.id)) }),
                strokes: if group { Vec::new() } else { strokes(None) },
                // An adjustment layer's settings (one this client does not know: as none).
                adjust: if l.kind.as_deref() == Some("adjust") {
                    Some(l.extra.get("adjust").and_then(|a| serde_json::from_value(a.clone()).ok()).unwrap_or(crate::painting::Adjust::HueSat { hue: 0.0, saturation: 0.0, lightness: 0.0 }))
                } else {
                    None
                },
            });
            ids.push(l.id.clone());
        }
        // Parents, now that every layer has its number.
        for (layer, id) in layers.iter_mut().zip(&ids) {
            layer.parent = self.layers[id].parent.as_deref().and_then(|p| num.get(p).copied());
        }
        let mix = if self.mix == "pigment" { crate::Mix::Pigment } else { crate::Mix::Normal };
        let mut painting = crate::Painting { layers, mix, ..Default::default() };
        if painting.layers.is_empty() {
            painting.layers.push(crate::Layer { id: 1, name: "Layer 1".into(), ordered: true, ..Default::default() });
            ids.push(String::new());
        }
        Converted { painting, layer_ids: ids }
    }
}

const ID_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// A 16-character id made from two, the same on every client and the server (ids.ts
/// derivedId): three FNV-1a hashes of "a/b" (UTF-16 units) with different seeds, in base 62.
pub fn derived_id(a: &str, b: &str) -> String {
    let s: Vec<u16> = format!("{a}/{b}").encode_utf16().collect();
    let hash = |seed: u32| s.iter().fold(seed, |h, &c| (h ^ c as u32).wrapping_mul(0x0100_0193));
    let enc = |mut n: u32, width: usize, out: &mut String| {
        for _ in 0..width {
            out.push(ID_ALPHABET[(n % 62) as usize] as char);
            n /= 62;
        }
    };
    let mut out = String::with_capacity(16);
    enc(hash(0x811c_9dc5), 6, &mut out);
    enc(hash(0x050c_5d1f), 6, &mut out);
    enc(hash(0x2f6b_3a91), 4, &mut out);
    out
}

/// A new random id: 16 characters of [0-9a-zA-Z] (ids.ts newId).
pub fn new_id() -> String {
    let mut out = String::with_capacity(16);
    let mut bytes = [0u8; 64];
    loop {
        getrandom(&mut bytes);
        for &b in &bytes {
            // Rejection sampling: no modulo bias.
            if b < 248 {
                out.push(ID_ALPHABET[(b % 62) as usize] as char);
                if out.len() == 16 {
                    return out;
                }
            }
        }
    }
}

/// Random bytes from the system (/dev/urandom; on failure, the time and a counter mixed).
pub fn getrandom(buf: &mut [u8]) {
    use std::io::Read;
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(buf)).is_ok() {
        return;
    }
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut x = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) ^ COUNTER.fetch_add(0x9e37_79b9_7f4a_7c15, std::sync::atomic::Ordering::Relaxed);
    for b in buf {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *b = x as u8;
    }
}

/// The number of decimals points keep at a scale `s` (zoom times pixel ratio; brush.ts
/// pointDecimals): about a tenth of a pixel.
pub fn point_decimals(s: f64) -> i32 {
    ((s * 10.0).log10().ceil() as i32).clamp(-15, 15)
}

/// A value rounded to `decimals` (negative: to tens, hundreds, ...), as brush.ts roundTo.
pub fn round_to(v: f64, decimals: i32) -> f64 {
    if decimals >= 0 {
        let k = 10f64.powi(decimals);
        (v * k).round() / k
    } else {
        let k = 10f64.powi(-decimals);
        (v / k).round() * k
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derived_ids_are_the_2d_apps() {
        // From the 2D app's ids.ts (run in node).
        assert_eq!(derived_id("Ab12Cd34Ef56Gh78", "layerXYZ123"), "0DKJ92GXbO51uW7W");
        assert_eq!(derived_id("q", "w"), "4PFNC4Agl0G4kbY6");
        let id = new_id();
        assert_eq!(id.len(), 16);
        assert!(id.bytes().all(|b| b.is_ascii_alphanumeric()));
    }

    fn layer(id: &str, order: f64, parent: Option<&str>, kind: Option<&str>) -> Value {
        let mut l = json!({"id": id, "name": id, "order": order, "blend": "normal", "opacity": 1.0, "visible": true});
        if let Some(p) = parent {
            l["parent"] = p.into();
        }
        if let Some(k) = kind {
            l["kind"] = k.into();
            l["blend"] = "pass".into();
        }
        l
    }

    fn stroke(id: &str, layer: &str) -> Value {
        json!({"id": id, "layerId": layer, "brush": {"tool": "paint", "color": "#112233", "size": 10.0, "opacity": 1.0, "flow": 1.0, "hardness": 0.8, "spacing": 0.1, "pressureSize": true, "pressureFlow": false, "buildup": false, "roundness": 0.5}, "pts": [0.0, 0.0, 0.5, 10.0, 0.0, 0.5]})
    }

    #[test]
    fn ops_apply_as_the_server_applies_them() {
        let mut d = Doc::default();
        d.apply(&json!({"type": "layer.add", "layer": layer("L1aaaa", 1.0, None, None)}), "c", 1).unwrap();
        d.apply(&json!({"type": "layer.add", "layer": layer("G1aaaa", 2.0, None, Some("group"))}), "c", 2).unwrap();
        d.apply(&json!({"type": "layer.add", "layer": layer("L2aaaa", 1.0, Some("G1aaaa"), None)}), "c", 3).unwrap();
        assert_eq!(d.paint_order().iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), vec!["L1aaaa", "L2aaaa", "G1aaaa"]);
        // Strokes: not on a group; seq and author from the op.
        assert!(matches!(d.apply(&json!({"type": "stroke.add", "stroke": stroke("S0aaaa", "G1aaaa")}), "c", 4), Err(OpError::Refused(_))));
        d.apply(&json!({"type": "stroke.add", "stroke": stroke("S1aaaa", "L2aaaa")}), "peer", 5).unwrap();
        assert_eq!((d.strokes["S1aaaa"].seq, d.strokes["S1aaaa"].author.as_deref()), (Some(5), Some("peer")));
        // Unknown fields come back as they were.
        assert_eq!(d.strokes["S1aaaa"].brush.num("roundness"), Some(0.5));
        let back = serde_json::to_value(&d.strokes["S1aaaa"]).unwrap();
        assert_eq!(back["brush"]["roundness"], 0.5);
        // Update: props over the layer, a null removes.
        d.apply(&json!({"type": "layer.update", "id": "L2aaaa", "props": {"opacity": 0.5, "parent": null}}), "c", 6).unwrap();
        assert_eq!((d.layers["L2aaaa"].opacity, d.layers["L2aaaa"].parent.clone()), (0.5, None));
        assert!(matches!(d.apply(&json!({"type": "layer.update", "id": "L1aaaa", "props": {"blend": "pass"}}), "c", 7), Err(OpError::Refused(_))));
        // A group cannot go into itself.
        d.apply(&json!({"type": "layer.update", "id": "L2aaaa", "props": {"parent": "G1aaaa"}}), "c", 8).unwrap();
        assert!(d.apply(&json!({"type": "layer.update", "id": "G1aaaa", "props": {"parent": "G1aaaa"}}), "c", 9).is_err());
        // Remove and restore; a deleted group hides its layers.
        d.apply(&json!({"type": "layer.remove", "id": "G1aaaa"}), "c", 10).unwrap();
        assert!(d.effectively_deleted(&d.layers["L2aaaa"]));
        assert_eq!(d.paint_order().len(), 1);
        d.apply(&json!({"type": "layer.restore", "id": "G1aaaa"}), "c", 11).unwrap();
        // Duplicate the group: derived ids, the stroke copied.
        d.apply(&json!({"type": "layer.duplicate", "id": "G1aaaa", "newId": "G2aaaa", "name": "G copy", "order": 3.0, "parent": null}), "c", 12).unwrap();
        let inner = derived_id("G2aaaa", "L2aaaa");
        assert_eq!(d.layers[&inner].parent.as_deref(), Some("G2aaaa"));
        assert_eq!(d.strokes[&derived_id("G2aaaa", "S1aaaa")].layer_id, inner);
        // Transform: points, size by sqrt(det), the angle turned (a quarter turn, scale 2).
        d.apply(&json!({"type": "layer.transform", "id": "L2aaaa", "m": [0.0, 2.0, -2.0, 0.0, 5.0, 0.0]}), "c", 13).unwrap();
        let s = &d.strokes["S1aaaa"];
        assert_eq!(&s.pts[3..5], &[5.0, 20.0]);
        assert!((s.brush.size - 20.0).abs() < 1e-9 && (s.brush.num("angle").unwrap() - 90.0).abs() < 1e-9);
        // Remove a stroke; restore one never seen (the broadcast brings it).
        d.apply(&json!({"type": "stroke.remove", "id": "S1aaaa"}), "c", 14).unwrap();
        assert!(d.strokes_of("L2aaaa", None).is_empty());
        let mut unseen = stroke("S9aaaa", "L1aaaa");
        unseen["seq"] = 3.into();
        d.apply(&json!({"type": "stroke.restore", "id": "S9aaaa", "stroke": unseen}), "c", 15).unwrap();
        assert_eq!(d.strokes_of("L1aaaa", None).len(), 1);
        // Shapes to paint: load again.
        assert_eq!(d.apply(&json!({"type": "shapes.toPaint", "key": "k", "ids": [], "layerId": "L1aaaa"}), "c", 16), Err(OpError::Reload));
    }

    #[test]
    fn point_decimals_as_the_2d_app() {
        assert_eq!(point_decimals(1.0), 1);
        assert_eq!(point_decimals(0.001), -2);
        assert_eq!(round_to(1234.5678, 1), 1234.6);
        assert_eq!(round_to(1234.5678, -2), 1200.0);
    }

    #[test]
    fn strokes_in_3d_keep_their_depth() {
        let s: DocStroke = serde_json::from_value(json!({
            "id": "S3dddddddd", "layerId": "L1aaaa",
            "brush": {"tool": "paint", "color": "#000000", "size": 2.0, "opacity": 1.0, "flow": 1.0, "hardness": 0.8, "spacing": 0.1, "pressureSize": true, "pressureFlow": false, "buildup": false},
            "pts": [10.0, 20.0, 0.5, 30.0, 20.0, 0.5],
            "threed": {"z": [5.0, -5.0], "up": [0.0, -1.0, 0.0, 1.0, 0.0, 0.0]}
        }))
        .unwrap();
        // A turn by 90 degrees and a scale of 2: depth doubles, the up sides turn in the paper.
        let m = [0.0, 2.0, -2.0, 0.0, 0.0, 0.0];
        let (pts, brush, vr) = transform_stroke(&s, &m).unwrap();
        let vr = vr.unwrap();
        assert_eq!((pts[0], pts[1], brush.size), (-40.0, 20.0, 4.0));
        assert_eq!(vr.z, vec![10.0, -10.0]);
        let up = vr.up.unwrap();
        assert!((up[0] - 1.0).abs() < 1e-12 && up[1].abs() < 1e-12, "{up:?}");
        assert!(up[3].abs() < 1e-12 && (up[4] - 1.0).abs() < 1e-12, "{up:?}");
        // Into a painting: depth along z, and the up side with y turned up.
        let frame = Frame { anchor: [10.0, 20.0], k: 0.01, offset: glam::Vec3::ZERO };
        let st = super::stroke(&s.id, &s.brush, &s.pts, s.threed.as_ref(), &frame);
        assert!(st.samples[0].pos.abs_diff_eq(glam::Vec3::new(0.0, 0.0, 0.05), 1e-6));
        assert!(st.samples[1].pos.abs_diff_eq(glam::Vec3::new(0.2, 0.0, -0.05), 1e-6));
        assert!(st.samples[0].up.abs_diff_eq(glam::Vec3::Y, 1e-6));
        // A layer of them is a 3D layer, its strokes covering each other in order (as in 2D).
        let layer: DocLayer = serde_json::from_value(json!({"id": "L1aaaa", "name": "VR", "order": 1.0, "blend": "normal", "opacity": 1.0, "visible": true, "threed": true})).unwrap();
        let doc = Doc::from_parts(vec![layer], vec![s], Vec::new(), None, None);
        let p = doc.painting(&frame).painting;
        assert!(p.layers[0].ordered && p.layers[0].threed);
        assert_eq!(serde_json::to_value(&doc.layers["L1aaaa"]).unwrap()["threed"], json!(true));
    }
}
