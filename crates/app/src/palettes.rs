//! Color palettes, as the 2D app's Palettes tab (multiplayer-canvas PalettesTab.svelte): your
//! own palettes (kept in a file beside the painting: VR has no server to share them), the
//! built-in ones (measured Golden paints, and limited palettes of them), and the paint library
//! (artistpigments.org, by medium and brand line), searched by name, line, medium or pigment.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// At most this many colors in a palette, and this long a name (the 2D app's limits).
pub const MAX_COLORS: usize = 128;
pub const MAX_NAME: usize = 40;
/// Search results shown at most.
pub const MAX_RESULTS: usize = 180;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PaletteColor {
    /// "#rrggbb", sRGB.
    pub hex: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Palette {
    pub name: String,
    pub colors: Vec<PaletteColor>,
}

/// Your palettes, and the one "Add current color" adds to.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Palettes {
    pub mine: Vec<Palette>,
    pub active: Option<usize>,
    #[serde(skip)]
    pub path: Option<PathBuf>,
}

impl Palettes {
    /// Your palettes from `path` (none when there is no file yet).
    pub fn load(path: PathBuf) -> Self {
        let mut p: Palettes = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        p.path = Some(path);
        p
    }

    pub fn save(&self) {
        if let Some(path) = &self.path {
            let write = || -> anyhow::Result<()> {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(path, serde_json::to_vec_pretty(self)?)?;
                Ok(())
            };
            if let Err(e) = write() {
                log::error!("saving {}: {e:#}", path.display());
            }
        }
    }

    /// Adds a color to the active palette (else the newest; with none, a new "My colors").
    /// Refused (with why) when it is there already or the palette is full.
    pub fn add(&mut self, color: PaletteColor) -> Result<String, String> {
        if self.mine.is_empty() {
            self.mine.push(Palette { name: "My colors".into(), colors: Vec::new() });
        }
        let i = self.active.filter(|&i| i < self.mine.len()).unwrap_or(self.mine.len() - 1);
        let p = &mut self.mine[i];
        if p.colors.iter().any(|c| c.hex.eq_ignore_ascii_case(&color.hex)) {
            return Err(format!("{} is in {} already", color.hex, p.name));
        }
        if p.colors.len() >= MAX_COLORS {
            return Err(format!("{} is full ({MAX_COLORS} colors)", p.name));
        }
        let name = p.name.clone();
        p.colors.push(PaletteColor { name: color.name.map(|n| n.chars().take(MAX_NAME).collect()), ..color });
        self.active = Some(i);
        self.save();
        Ok(name)
    }

    pub fn create(&mut self, name: &str) {
        let name: String = name.trim().chars().take(MAX_NAME).collect();
        self.mine.push(Palette { name: if name.is_empty() { "My colors".into() } else { name }, colors: Vec::new() });
        self.active = Some(self.mine.len() - 1);
        self.save();
    }
}

/// Where your palettes are kept: beside the painting.
pub fn path_beside(painting: Option<&Path>) -> Option<PathBuf> {
    Some(painting?.parent()?.join("palettes.json"))
}

/// A built-in palette.
#[derive(Clone, Debug, Deserialize)]
pub struct Builtin {
    pub id: String,
    pub name: String,
    pub note: String,
    pub colors: Vec<PaletteColor>,
}

/// A library paint: name, hex, pigment codes (space-separated), and 1 when discontinued.
#[derive(Clone, Debug, Deserialize)]
pub struct LibraryPaint(pub String, pub String, pub String, #[serde(default)] pub Option<u8>);

#[derive(Clone, Debug, Deserialize)]
pub struct Line {
    pub id: String,
    pub name: String,
    /// The brand in a few words, for color names.
    pub short: String,
    pub paints: Vec<LibraryPaint>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Medium {
    pub id: String,
    pub name: String,
    pub brands: Vec<Line>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Library {
    pub license: String,
    pub media: Vec<Medium>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Paints {
    pub builtin: Vec<Builtin>,
    pub library: Library,
}

/// The built-in palettes and the paint library (assets/paints.json; read the first time).
pub fn paints() -> &'static Paints {
    static PAINTS: OnceLock<Paints> = OnceLock::new();
    PAINTS.get_or_init(|| serde_json::from_str(include_str!("../../../assets/paints.json")).expect("assets/paints.json"))
}

/// A library paint as a palette color: "<paint> (<brand>)".
pub fn paint_color(p: &LibraryPaint, line: &Line) -> PaletteColor {
    PaletteColor { hex: p.1.clone(), name: Some(format!("{} ({})", p.0, line.short)) }
}

/// Library paints matching every word of `query` (in the name, line, medium or pigment
/// codes), as the 2D app searches: paints made only of the searched pigments first, then those
/// that hold them, then the rest; at most `MAX_RESULTS`. (medium, line, paint) places.
pub fn search(query: &str) -> Vec<(usize, usize, usize)> {
    let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let lib = &paints().library;
    let mut hits: Vec<(u8, (usize, usize, usize))> = Vec::new();
    for (m, medium) in lib.media.iter().enumerate() {
        for (l, line) in medium.brands.iter().enumerate() {
            for (k, p) in line.paints.iter().enumerate() {
                let hay = format!("{} {} {} {}", p.0, line.name, medium.name, p.2).to_lowercase();
                if !words.iter().all(|w| hay.contains(w.as_str())) {
                    continue;
                }
                // Pigment words: those that are pigment codes of this paint.
                let codes: Vec<String> = p.2.split_whitespace().map(|c| c.to_lowercase()).collect();
                let pig: Vec<&String> = words.iter().filter(|w| codes.contains(w)).collect();
                let rank = if !pig.is_empty() && codes.iter().all(|c| pig.contains(&c)) { 0 } else if !pig.is_empty() { 1 } else { 2 };
                hits.push((rank, (m, l, k)));
            }
        }
    }
    hits.sort_by_key(|h| h.0);
    hits.into_iter().take(MAX_RESULTS).map(|h| h.1).collect()
}

/// "#rrggbb" to sRGB 0..1.
pub fn parse_hex(s: &str) -> Option<[f32; 3]> {
    let s = s.trim().trim_start_matches('#');
    let full: String = match s.len() {
        3 => s.chars().flat_map(|c| [c, c]).collect(),
        6 => s.to_string(),
        _ => return None,
    };
    let v = u32::from_str_radix(&full, 16).ok()?;
    Some([(v >> 16) as f32 / 255.0, ((v >> 8) & 255) as f32 / 255.0, (v & 255) as f32 / 255.0])
}

pub fn to_hex(c: [f32; 3]) -> String {
    let b = c.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8);
    format!("#{:02x}{:02x}{:02x}", b[0], b[1], b[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_paints_load() {
        let p = paints();
        assert_eq!(p.builtin.len(), 4);
        assert_eq!(p.builtin[0].colors.len(), 78);
        assert!(p.library.license.contains("CC BY-NC"));
        let n: usize = p.library.media.iter().flat_map(|m| &m.brands).map(|l| l.paints.len()).sum();
        assert!(n > 4000, "{n}");
    }

    #[test]
    fn search_ranks_pure_pigments_first() {
        let hits = search("pb29");
        assert!(!hits.is_empty() && hits.len() <= MAX_RESULTS);
        let lib = &paints().library;
        let first = &lib.media[hits[0].0].brands[hits[0].1].paints[hits[0].2];
        assert_eq!(first.2.to_lowercase(), "pb29", "{first:?}");
        // Every word must match.
        assert!(search("pb29 zzzz").is_empty());
    }

    #[test]
    fn adding_colors_to_palettes() {
        let mut p = Palettes::default();
        let red = PaletteColor { hex: "#ff0000".into(), name: None };
        assert_eq!(p.add(red.clone()).unwrap(), "My colors");
        assert!(p.add(PaletteColor { hex: "#FF0000".into(), name: None }).is_err(), "the same color twice");
        p.create("Skin");
        p.add(red).unwrap();
        assert_eq!((p.mine.len(), p.mine[1].colors.len()), (2, 1));
        assert_eq!(parse_hex("#f80"), Some([1.0, 0x88 as f32 / 255.0, 0.0]));
        assert_eq!(to_hex([1.0, 0.5, 0.0]), "#ff8000");
        assert!(parse_hex("#12345").is_none());
    }
}
