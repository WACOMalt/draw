//! A keyboard on the panel (VR has no keys): for layer and palette names, and hex colors.
//! What it types into, and the text so far; Enter commits, Cancel drops it.

use super::widgets::{BG_1, BG_3, BG_4, LINE, TEXT, TEXT_DIM, ACCENT_DIM, stroke};
use egui::{Color32, RichText, Sense, vec2};

/// What the text is for.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// A layer's name (by id).
    LayerName(u32),
    /// The color as #RRGGBB.
    Hex,
    /// A new palette's name, or a palette's (by place).
    PaletteName(Option<usize>),
    /// Search the paint library.
    Search,
    /// A new brush preset's name.
    PresetName,
}

#[derive(Clone, Debug)]
pub struct Typing {
    pub target: Target,
    pub text: String,
    pub shift: bool,
    /// The most it takes (the 2D app's limits: 64 for a layer name, 40 for a palette's).
    pub max: usize,
}

impl Typing {
    pub fn new(target: Target, text: &str) -> Self {
        let max = match target {
            Target::LayerName(_) => 64,
            Target::Hex => 7,
            Target::PaletteName(_) => 40,
            Target::Search => 40,
            Target::PresetName => 40,
        };
        Self { target, text: text.to_string(), shift: false, max }
    }
}

/// What the keyboard did this frame.
pub enum Done {
    Commit(Target, String),
    Cancel,
}

const ROWS: [&str; 4] = ["1234567890", "qwertyuiop", "asdfghjkl-", "zxcvbnm.'#"];

/// The text and the keys, at the bottom of the panel. Returns what was done, if anything.
pub fn keyboard(ui: &mut egui::Ui, typing: &mut Typing) -> Option<Done> {
    let mut done = None;
    egui::Frame { inner_margin: egui::Margin::same(10.0), rounding: egui::Rounding::same(6.0), fill: BG_1, stroke: stroke(1.0, LINE), ..Default::default() }.show(ui, |ui| {
        let label = match typing.target {
            Target::LayerName(_) => "Layer name",
            Target::Hex => "Color (hex)",
            Target::PaletteName(_) => "Palette name",
            Target::Search => "Search paints and pigments, e.g. PB29",
            Target::PresetName => "Name for the current brush",
        };
        ui.label(RichText::new(label).color(TEXT_DIM).size(13.0));
        // The text, with a caret.
        let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::hover());
        ui.painter().rect(rect, 4.0, BG_3, stroke(1.0, ACCENT_DIM));
        ui.painter().text(rect.left_center() + vec2(8.0, 0.0), egui::Align2::LEFT_CENTER, format!("{}|", typing.text), egui::FontId::proportional(17.0), TEXT);
        let key_w = (ui.available_width() - 9.0 * 4.0) / 10.0;
        let key = |ui: &mut egui::Ui, text: &str, w: f32, on: bool| -> bool {
            let (rect, response) = ui.allocate_exact_size(vec2(w, 40.0), Sense::click());
            let fill = if on { ACCENT_DIM } else if response.hovered() { BG_4 } else { BG_3 };
            ui.painter().rect(rect, 4.0, fill, stroke(1.0, LINE));
            ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, text, egui::FontId::proportional(17.0), TEXT);
            response.clicked()
        };
        for row in ROWS {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                for c in row.chars() {
                    let c = if typing.shift { c.to_ascii_uppercase() } else { c };
                    if key(ui, &c.to_string(), key_w, false) && typing.text.chars().count() < typing.max {
                        typing.text.push(c);
                        typing.shift = false;
                    }
                }
            });
        }
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            if key(ui, "Shift", key_w * 1.6, typing.shift) {
                typing.shift = !typing.shift;
            }
            if key(ui, "Space", key_w * 3.2, false) && typing.text.chars().count() < typing.max {
                typing.text.push(' ');
            }
            if key(ui, "Del", key_w * 1.4, false) {
                typing.text.pop();
            }
            if key(ui, "Cancel", key_w * 1.8, false) {
                done = Some(Done::Cancel);
            }
            let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 40.0), Sense::click());
            ui.painter().rect(rect, 4.0, if response.hovered() { Color32::from_rgb(0x31, 0xa8, 0xff) } else { ACCENT_DIM }, stroke(1.0, LINE));
            ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, "OK", egui::FontId::proportional(17.0), TEXT);
            if response.clicked() {
                done = Some(Done::Commit(typing.target.clone(), typing.text.clone()));
            }
        });
    });
    done
}
