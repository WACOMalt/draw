//! The Color tab, as the 2D app's Color panel (ColorPanel.svelte, PalettesTab.svelte): a Color
//! page (the saturation and value square, the hue strip, the hex color, red green and blue, and
//! recent colors) and a Palettes page (your palettes, the built-in ones, and the paint library).

use super::keyboard::{Target, Typing};
use super::widgets::*;
use crate::painter::Painter;
use crate::palettes::{self, PaletteColor, Palettes};
use egui::{Color32, Rect, RichText, Sense, pos2, vec2};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Color,
    Palettes,
}

pub struct ColorState {
    pub page: Page,
    /// The picker (sRGB HSV). Kept here so a gray keeps its hue on the strip.
    pub hsv: [f32; 3],
    /// The color the picker last saw (linear RGB), to notice changes from elsewhere.
    pub seen: [f32; 3],
    /// The picker was dragged: the color goes to the recent ones when it is let go.
    dragged: bool,
    /// Sections open (palettes, media and lines, by key); your palettes start open.
    open: HashSet<String>,
    closed: HashSet<String>,
    /// Your palette being edited, and the one whose delete waits for a second press.
    editing: Option<usize>,
    confirm: Option<usize>,
    pub search: String,
    /// The last pick, or what was added where.
    status: String,
}

impl ColorState {
    pub fn new(color: [f32; 3]) -> Self {
        Self {
            page: Page::Color,
            hsv: rgb_to_hsv(to_srgb(color)),
            seen: color,
            dragged: false,
            open: HashSet::new(),
            closed: HashSet::new(),
            editing: None,
            confirm: None,
            search: String::new(),
            status: String::new(),
        }
    }
}

/// Sets the foreground color (sRGB) and puts it first among the recent ones.
fn pick(painter: &mut Painter, state: &mut ColorState, srgb: [f32; 3]) {
    painter.tools.brush.color = to_linear(srgb);
    state.hsv = rgb_to_hsv(srgb);
    state.seen = painter.tools.brush.color;
    painter.add_recent(srgb);
}

pub fn color_tab(ui: &mut egui::Ui, painter: &mut Painter, palettes: &mut Palettes, state: &mut ColorState, typing: &mut Option<Typing>) {
    if painter.tools.brush.color != state.seen {
        state.hsv = rgb_to_hsv(to_srgb(painter.tools.brush.color));
        state.seen = painter.tools.brush.color;
    }
    ui.horizontal(|ui| {
        for (name, page) in [("Color", Page::Color), ("Palettes", Page::Palettes)] {
            if toggle(ui, name, state.page == page).clicked() {
                state.page = page;
            }
        }
    });
    ui.add_space(4.0);
    match state.page {
        Page::Color => color_page(ui, painter, state, typing),
        Page::Palettes => palettes_page(ui, painter, palettes, state, typing),
    }
}

fn color_page(ui: &mut egui::Ui, painter: &mut Painter, state: &mut ColorState, typing: &mut Option<Typing>) {
    let mut changed = sv_square(ui, &mut state.hsv);
    changed |= hue_strip(ui, &mut state.hsv);
    let mut srgb = hsv_to_rgb(state.hsv);
    // The hex color (the keyboard types it), and red, green and blue.
    ui.horizontal(|ui| {
        let (chip, _) = ui.allocate_exact_size(vec2(30.0, 30.0), Sense::hover());
        let b = srgb.map(|c| (c * 255.0).round() as u8);
        ui.painter().rect(chip, 4.0, Color32::from_rgb(b[0], b[1], b[2]), stroke(1.0, LINE));
        let hex = palettes::to_hex(srgb).to_uppercase();
        if ui.button(RichText::new(&hex).monospace()).clicked() {
            *typing = Some(Typing::new(Target::Hex, &hex));
        }
    });
    for (k, name) in ["R", "G", "B"].into_iter().enumerate() {
        let mut v = (srgb[k] * 255.0).round();
        if slider(ui, name, &mut v, (0.0, 255.0), false, |v| format!("{v:.0}")) {
            srgb[k] = v.round() / 255.0;
            // Red, green and blue keep the hue of a gray.
            let hsv = rgb_to_hsv(srgb);
            state.hsv = if hsv[1] > 0.0 { hsv } else { [state.hsv[0], hsv[1], hsv[2]] };
            painter.tools.brush.color = to_linear(srgb);
            state.seen = painter.tools.brush.color;
        }
    }
    if changed {
        painter.tools.brush.color = to_linear(srgb);
        state.seen = painter.tools.brush.color;
        state.dragged = true;
    }
    // A drag on the square or the strip ends: the color goes to the recent ones.
    if state.dragged && !ui.input(|i| i.pointer.primary_down()) {
        state.dragged = false;
        painter.add_recent(srgb);
    }
    ui.add_space(4.0);
    section(ui, "RECENT");
    if let Some(c) = swatches(ui, &painter.recent) {
        painter.tools.brush.color = to_linear(c.map(|c| c as f32 / 255.0));
    }
}

/// A grid of color swatches, 9 to a row (faded ones dim). Returns the one clicked, and the one
/// under the pointer.
fn grid(ui: &mut egui::Ui, colors: &[(String, bool)], plus: bool, cross: bool) -> (Option<usize>, Option<usize>, bool, Option<usize>) {
    let size = ((ui.available_width() - 8.0 * 4.0) / 9.0).floor();
    let (mut clicked, mut hovered, mut plus_clicked, mut crossed) = (None, None, false, None);
    let n = colors.len() + plus as usize;
    for row in 0..n.div_ceil(9) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            for k in row * 9..(row * 9 + 9).min(n) {
                let (rect, response) = ui.allocate_exact_size(vec2(size, size * 0.8), Sense::click());
                if k == colors.len() {
                    // The dashed "+" tile: add the current color here.
                    ui.painter().rect_stroke(rect.shrink(1.0), 3.0, stroke(1.0, if response.hovered() { TEXT } else { TEXT_FAINT }));
                    paint_icon(ui.painter(), "plus", rect, 16.0, TEXT_DIM);
                    plus_clicked |= response.clicked();
                    continue;
                }
                let (hex, faded) = &colors[k];
                let c = palettes::parse_hex(hex).unwrap_or([0.0; 3]).map(|c| (c * 255.0).round() as u8);
                let mut fill = Color32::from_rgb(c[0], c[1], c[2]);
                if *faded {
                    fill = fill.gamma_multiply(0.55);
                }
                let line = if response.hovered() { stroke(2.0, TEXT) } else { stroke(1.0, LINE) };
                ui.painter().rect(rect, 3.0, fill, line);
                if cross {
                    paint_icon(ui.painter(), "close", Rect::from_min_size(rect.right_top() - vec2(14.0, 0.0), vec2(14.0, 14.0)), 10.0, Color32::WHITE);
                }
                if response.hovered() {
                    hovered = Some(k);
                }
                if response.clicked() {
                    if cross { crossed = Some(k) } else { clicked = Some(k) }
                }
            }
        });
    }
    (clicked, hovered, plus_clicked, crossed)
}

/// A section's header with a chevron: open or closed (by key; `default` when not yet chosen).
fn header(ui: &mut egui::Ui, state: &mut ColorState, key: &str, text: &str, default: bool, right: impl FnOnce(&mut egui::Ui)) -> bool {
    let open = if state.open.contains(key) { true } else if state.closed.contains(key) { false } else { default };
    let mut toggled = false;
    ui.horizontal(|ui| {
        let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width() - 90.0, 32.0), Sense::click());
        let c = pos2(rect.left() + 10.0, rect.center().y);
        let pts = if open { vec![c + vec2(-5.0, -2.5), c + vec2(0.0, 3.0), c + vec2(5.0, -2.5)] } else { vec![c + vec2(-2.5, -5.0), c + vec2(3.0, 0.0), c + vec2(-2.5, 5.0)] };
        ui.painter().add(egui::Shape::line(pts, stroke(1.6, TEXT)));
        ui.painter().text(pos2(rect.left() + 24.0, rect.center().y), egui::Align2::LEFT_CENTER, text, egui::FontId::proportional(15.0), TEXT);
        toggled = response.clicked();
        right(ui);
    });
    if toggled {
        if open {
            state.open.remove(key);
            state.closed.insert(key.to_string());
        } else {
            state.closed.remove(key);
            state.open.insert(key.to_string());
        }
    }
    open != toggled
}

fn palettes_page(ui: &mut egui::Ui, painter: &mut Painter, palettes: &mut Palettes, state: &mut ColorState, typing: &mut Option<Typing>) {
    let current = to_srgb(painter.tools.brush.color);
    // The bar: the current color, add it, a new palette.
    ui.horizontal(|ui| {
        let (chip, _) = ui.allocate_exact_size(vec2(28.0, 28.0), Sense::hover());
        let b = current.map(|c| (c * 255.0).round() as u8);
        ui.painter().rect(chip, 4.0, Color32::from_rgb(b[0], b[1], b[2]), stroke(1.0, LINE));
        if ui.button("+ Add current color").clicked() {
            add(palettes, state, PaletteColor { hex: palettes::to_hex(current), name: None });
        }
        if ui.button("New palette").clicked() {
            *typing = Some(Typing::new(Target::PaletteName(None), "My colors"));
        }
    });
    let status = if state.status.is_empty() {
        match palettes.active.and_then(|i| palettes.mine.get(i)).or(palettes.mine.last()) {
            Some(p) => format!("Adds to {}", p.name),
            None => "Adds to a new palette, My colors".into(),
        }
    } else {
        state.status.clone()
    };
    ui.label(RichText::new(status).color(TEXT_DIM).size(13.0));

    let mut hover_name: Option<String> = None;
    let height = ui.available_height() - 8.0;
    egui::ScrollArea::vertical().max_height(height).auto_shrink([false, false]).show(ui, |ui| {
        // Yours.
        section(ui, "YOURS");
        if palettes.mine.is_empty() {
            ui.label(RichText::new("None yet: add the current color to start one.").color(TEXT_FAINT).size(13.0));
        }
        let mut remove: Option<(usize, usize)> = None;
        let mut delete: Option<usize> = None;
        for i in 0..palettes.mine.len() {
            let editing = state.editing == Some(i);
            let title = format!("{}  ·  {}", palettes.mine[i].name, palettes.mine[i].colors.len());
            let mut edit_pressed = false;
            let open = header(ui, state, &format!("mine{i}"), &title, true, |ui| {
                edit_pressed = toggle(ui, if editing { "Done" } else { "Edit" }, editing).clicked();
            });
            if edit_pressed {
                state.editing = if editing { None } else { Some(i) };
                state.confirm = None;
            }
            if palettes.active == Some(i) {
                let r = ui.min_rect();
                ui.painter().vline(r.left() - 2.0, r.bottom() - 32.0..=r.bottom(), stroke(2.0, ACCENT));
            }
            if !open {
                continue;
            }
            let colors: Vec<(String, bool)> = palettes.mine[i].colors.iter().map(|c| (c.hex.clone(), false)).collect();
            let (clicked, hovered, plus, crossed) = grid(ui, &colors, !editing, editing);
            if let Some(k) = hovered {
                let c = &palettes.mine[i].colors[k];
                hover_name = Some(c.name.clone().map_or(c.hex.clone(), |n| format!("{n} · {}", c.hex)));
            }
            if let Some(k) = clicked {
                let c = palettes.mine[i].colors[k].clone();
                pick(painter, state, palettes::parse_hex(&c.hex).unwrap_or(current));
                state.status = c.name.map_or(c.hex.clone(), |n| format!("{n} · {}", c.hex));
            }
            if let Some(k) = crossed {
                remove = Some((i, k));
            }
            if plus {
                palettes.active = Some(i);
                add(palettes, state, PaletteColor { hex: palettes::to_hex(current), name: None });
            }
            if editing {
                ui.horizontal(|ui| {
                    if ui.button("Rename").clicked() {
                        *typing = Some(Typing::new(Target::PaletteName(Some(i)), &palettes.mine[i].name));
                    }
                    let sure = state.confirm == Some(i);
                    if ui.button(if sure { "Press again to delete" } else { "Delete this palette" }).clicked() {
                        if sure {
                            delete = Some(i);
                        } else {
                            state.confirm = Some(i);
                        }
                    }
                });
            }
        }
        if let Some((i, k)) = remove {
            palettes.mine[i].colors.remove(k);
            palettes.save();
        }
        if let Some(i) = delete {
            palettes.mine.remove(i);
            palettes.active = None;
            state.editing = None;
            state.confirm = None;
            palettes.save();
        }

        // Paint: search, the built-in palettes, the library.
        ui.add_space(6.0);
        section(ui, "PAINT");
        ui.horizontal(|ui| {
            let text = if state.search.is_empty() { "Search paints and pigments, e.g. PB29".to_string() } else { format!("Search: {}", state.search) };
            if ui.button(text).clicked() {
                *typing = Some(Typing::new(Target::Search, &state.search));
            }
            if !state.search.is_empty() && ui.button("Clear").clicked() {
                state.search.clear();
            }
        });
        let lib = &palettes::paints().library;
        if !state.search.is_empty() {
            let hits = palettes::search(&state.search);
            if hits.is_empty() {
                ui.label(RichText::new("No paint matches.").color(TEXT_FAINT).size(13.0));
            }
            let colors: Vec<(String, bool)> = hits.iter().map(|&(m, l, k)| { let p = &lib.media[m].brands[l].paints[k]; (p.1.clone(), p.3.is_some()) }).collect();
            let (clicked, hovered, _, _) = grid(ui, &colors, false, false);
            let detail = |k: usize| {
                let (m, l, p) = hits[k];
                let line = &lib.media[m].brands[l];
                let paint = &line.paints[p];
                format!("{} · {} · {} · {}", paint.0, line.name, paint.2, paint.1)
            };
            if let Some(k) = hovered {
                hover_name = Some(detail(k));
            }
            if let Some(k) = clicked {
                let (m, l, p) = hits[k];
                let line = &lib.media[m].brands[l];
                let c = palettes::paint_color(&line.paints[p], line);
                pick(painter, state, palettes::parse_hex(&c.hex).unwrap_or(current));
                state.status = detail(k);
            }
        }
        for b in &palettes::paints().builtin {
            if !header(ui, state, &b.id, &format!("{}  ·  {}", b.name, b.colors.len()), false, |_| {}) {
                continue;
            }
            ui.label(RichText::new(&b.note).color(TEXT_FAINT).size(12.5));
            let colors: Vec<(String, bool)> = b.colors.iter().map(|c| (c.hex.clone(), false)).collect();
            let (clicked, hovered, _, _) = grid(ui, &colors, false, false);
            if let Some(k) = hovered {
                hover_name = Some(format!("{} · {}", b.colors[k].name.clone().unwrap_or_default(), b.colors[k].hex));
            }
            if let Some(k) = clicked {
                let c = &b.colors[k];
                pick(painter, state, palettes::parse_hex(&c.hex).unwrap_or(current));
                state.status = format!("{} · {}", c.name.clone().unwrap_or_default(), c.hex);
            }
        }
        for medium in &lib.media {
            let count: usize = medium.brands.iter().map(|l| l.paints.len()).sum();
            if !header(ui, state, &medium.id, &format!("{}  ·  {count}", medium.name), false, |_| {}) {
                continue;
            }
            ui.indent(&medium.id, |ui| {
                for line in &medium.brands {
                    let key = format!("{}/{}", medium.id, line.id);
                    if !header(ui, state, &key, &format!("{}  ·  {}", line.name, line.paints.len()), false, |_| {}) {
                        continue;
                    }
                    let colors: Vec<(String, bool)> = line.paints.iter().map(|p| (p.1.clone(), p.3.is_some())).collect();
                    let (clicked, hovered, _, _) = grid(ui, &colors, false, false);
                    let detail = |k: usize| format!("{} · {} · {} · {}", line.paints[k].0, line.name, line.paints[k].2, line.paints[k].1);
                    if let Some(k) = hovered {
                        hover_name = Some(detail(k));
                    }
                    if let Some(k) = clicked {
                        let c = palettes::paint_color(&line.paints[k], line);
                        pick(painter, state, palettes::parse_hex(&c.hex).unwrap_or(current));
                        state.status = detail(k);
                    }
                }
            });
        }
        ui.add_space(6.0);
        ui.label(RichText::new(format!("Paint colors: artistpigments.org, {}", lib.license)).color(TEXT_FAINT).size(11.5));
    });
    if let Some(name) = hover_name {
        state.status = name;
    }
}

/// Adds a color to your active palette, keeping the name of the paint just picked.
fn add(palettes: &mut Palettes, state: &mut ColorState, mut color: PaletteColor) {
    if let Some((name, _)) = state.status.split_once(" · ").filter(|(_, rest)| rest.to_lowercase().contains(&color.hex.to_lowercase())) {
        color.name = Some(name.to_string());
    }
    state.status = match palettes.add(color) {
        Ok(to) => format!("Added to {to}"),
        Err(why) => why,
    };
}

/// The keyboard's text, committed: a hex color, a palette's name, a search.
pub fn commit(painter: &mut Painter, palettes: &mut Palettes, state: &mut ColorState, target: &Target, text: &str) {
    match target {
        Target::Hex => {
            if let Some(c) = palettes::parse_hex(text) {
                pick(painter, state, c);
            }
        }
        Target::PaletteName(None) => palettes.create(text),
        Target::PaletteName(Some(i)) => {
            let name: String = text.trim().chars().take(palettes::MAX_NAME).collect();
            if let Some(p) = palettes.mine.get_mut(*i).filter(|_| !name.is_empty()) {
                p.name = name;
                palettes.save();
            }
        }
        Target::Search => state.search = text.trim().to_string(),
        _ => {}
    }
}
