//! A painting: layers of strokes (each with a blend mode and opacity, as in the 2D app), and
//! the segments the renderer draws.

use crate::filter::OneEuro3;
use crate::segments::GpuSegment;
use crate::stroke::Stroke;
use glam::Vec3;
use serde::{Deserialize, Serialize};

/// The 2D app's blend modes, in its order (the shader's mode numbers).
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
}

impl Blend {
    /// From the 2D app's name ("color-burn"); unknown names (and "pass") are normal.
    pub fn from_name(name: &str) -> Self {
        serde_json::from_value(serde_json::Value::String(name.to_string())).unwrap_or_default()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Layer {
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
    pub strokes: Vec<Stroke>,
}

impl Default for Layer {
    fn default() -> Self {
        Self { name: "Layer".into(), blend: Blend::Normal, opacity: 1.0, visible: true, ordered: false, strokes: Vec::new() }
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
    /// Bottom to top.
    pub layers: Vec<Layer>,
    pub mix: Mix,
    /// The filter for every VR stroke's path.
    #[serde(skip)]
    pub filter: OneEuro3,
}

impl Default for Painting {
    fn default() -> Self {
        Self { layers: vec![Layer { name: "Layer 1".into(), ..Default::default() }], mix: Mix::Normal, filter: OneEuro3::default() }
    }
}

/// A run of segments of one layer, as `Painting::segments` lays them out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerRun {
    /// The layer's place in `Painting::layers`.
    pub layer: usize,
    pub first: usize,
    pub count: usize,
}

impl Painting {
    /// A painting of one volume layer with these strokes.
    pub fn with_strokes(strokes: Vec<Stroke>) -> Self {
        let mut p = Self::default();
        p.layers[0].strokes = strokes;
        p
    }

    /// The layer new VR strokes go to: the top layer (made when there is none).
    pub fn active_layer(&mut self) -> usize {
        if self.layers.is_empty() {
            self.layers.push(Layer { name: "VR".into(), ..Default::default() });
        }
        self.layers.len() - 1
    }

    /// The strokes of the active layer.
    pub fn active(&mut self) -> &mut Vec<Stroke> {
        let i = self.active_layer();
        &mut self.layers[i].strokes
    }

    /// The visible layers' finished strokes as round cones, bottom layer first, each layer's
    /// strokes in order, and where each layer's run is. Stroke numbers count on across layers;
    /// the next one (for a stroke being drawn) is `next_stroke`.
    pub fn segments(&self, out: &mut Vec<GpuSegment>) -> Vec<LayerRun> {
        out.clear();
        let mut runs = Vec::new();
        let mut id = 0u32;
        for (layer, l) in self.layers.iter().enumerate().filter(|(_, l)| l.visible) {
            let first = out.len();
            for s in &l.strokes {
                s.segments_in(self.filter, id, l.ordered, out);
                id += 1;
            }
            runs.push(LayerRun { layer, first, count: out.len() - first });
        }
        runs
    }

    /// The box around every sample (None when there are none).
    pub fn bounds(&self) -> Option<(Vec3, Vec3)> {
        let mut points = self.layers.iter().flat_map(|l| &l.strokes).flat_map(|s| &s.samples).map(|s| s.pos);
        let first = points.next()?;
        Some(points.fold((first, first), |(lo, hi), p| (lo.min(p), hi.max(p))))
    }

    /// The stroke number after every visible stroke.
    pub fn next_stroke(&self) -> u32 {
        self.layers.iter().filter(|l| l.visible).map(|l| l.strokes.len() as u32).sum()
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
        assert_eq!(Blend::from_name("pass"), Blend::Normal);
    }

    #[test]
    fn segments_come_in_layer_runs() {
        let stroke = |x: f32| {
            let mut s = Stroke::new(Brush::default());
            s.push(Sample::new(Vec3::new(x, 1.0, 0.0), 1.0, 0.0));
            s.push(Sample::new(Vec3::new(x + 0.1, 1.0, 0.0), 1.0, 0.1));
            s
        };
        let mut p = Painting::default();
        p.layers[0].strokes = vec![stroke(0.0), stroke(1.0)];
        p.layers.push(Layer { visible: false, strokes: vec![stroke(2.0)], ..Default::default() });
        p.layers.push(Layer { strokes: vec![stroke(3.0)], ..Default::default() });
        let mut out = Vec::new();
        let runs = p.segments(&mut out);
        assert_eq!(runs.len(), 2, "the hidden layer is left out");
        assert_eq!((runs[0].layer, runs[0].first), (0, 0));
        assert_eq!((runs[1].layer, runs[1].first + runs[1].count), (2, out.len()));
        assert!(out[runs[1].first].a[0] >= 3.0);
        assert_eq!(p.next_stroke(), 3);
    }

    #[test]
    fn a_painting_saves_and_loads() {
        let mut p = Painting::with_strokes(vec![Stroke::new(Brush::default())]);
        p.active()[0].push(Sample::new(Vec3::ONE, 0.5, 1.0));
        p.layers[0].blend = Blend::Multiply;
        let path = std::env::temp_dir().join(format!("vdraw-test-{}.vdraw", std::process::id()));
        crate::file::save(&path, &p).unwrap();
        let back = crate::file::load(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(back.layers[0].blend, Blend::Multiply);
        assert_eq!(back.layers[0].strokes[0].samples[0].pos, Vec3::ONE);
    }
}
