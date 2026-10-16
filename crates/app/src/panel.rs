//! The brush panel. It floats above the hand that is not painting, turned to face the head;
//! the painting hand points at it and clicks with the trigger.
//!
//! Made with egui and drawn by `vdraw_render::UiRenderer`, as bs-humany's xr-viewer does its
//! panels. Its controls and look follow the 2D app (multiplayer-canvas: OptionsBar, Slider and
//! ColorPanel) as far as they apply in 3D: size (logarithmic), opacity, hardness, pressure to
//! size, an HSV square with a hue strip, recent colors, undo and redo.

use egui::{Color32, Pos2, Rect, RichText, Sense, Stroke, pos2, vec2};
use glam::{Mat4, Vec3, Vec4};
use std::time::Instant;
use vdraw_core::Brush;

/// Meters per panel point.
pub const POINT: f32 = 0.0005;
/// The panel's size in points (0.22 x 0.30 m).
pub const SIZE: [f32; 2] = [440.0, 600.0];
/// Texture pixels per point: sharp text at arm's length.
const PIXELS_PER_POINT: f32 = 2.0;
/// How far above the hand the panel's center floats (meters).
const ABOVE_HAND: f32 = 0.19;

// The 2D app's theme (multiplayer-canvas src/client/app.css).
const BG_2: Color32 = Color32::from_rgb(0x2f, 0x2f, 0x2f);
const BG_3: Color32 = Color32::from_rgb(0x3a, 0x3a, 0x3a);
const BG_4: Color32 = Color32::from_rgb(0x47, 0x47, 0x47);
const LINE: Color32 = Color32::from_rgb(0x3d, 0x3d, 0x3d);
const TEXT: Color32 = Color32::from_rgb(0xd6, 0xd6, 0xd6);
const TEXT_DIM: Color32 = Color32::from_rgb(0x9a, 0x9a, 0x9a);
const ACCENT: Color32 = Color32::from_rgb(0x31, 0xa8, 0xff);
const ACCENT_DIM: Color32 = Color32::from_rgb(0x1f, 0x6f, 0xb0);
const TOGGLE_ON: Color32 = Color32::from_rgb(0x24, 0x39, 0x4c);

/// A line of `width` points (typed, for egui's `impl Into<f32>`).
fn stroke(width: f32, color: Color32) -> Stroke {
    Stroke::new(width, color)
}

/// Brush diameter range, meters (the 2D app's 1 to 1000 px, as a log slider).
const DIAMETER: (f32, f32) = (0.001, 0.4);
/// Recent colors kept, as in the 2D app.
pub const RECENT: usize = 18;

/// Where the panel is, in stage space: its top-left corner and the directions its points run.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub origin: Vec3,
    pub right: Vec3,
    pub down: Vec3,
    pub normal: Vec3,
}

impl Placement {
    /// Above the hand, facing the head (turned in both directions, so it stays square to the
    /// eyes), upright.
    pub fn above_hand(hand: Vec3, head: Vec3) -> Self {
        let center = hand + Vec3::Y * ABOVE_HAND;
        let normal = (head - center).try_normalize().unwrap_or(Vec3::Z);
        let right = Vec3::Y.cross(normal).try_normalize().unwrap_or(Vec3::X);
        let down = right.cross(normal);
        Self::centered(center, right, down, normal)
    }

    /// Centered at `center` (the snapshot's placement).
    pub fn centered(center: Vec3, right: Vec3, down: Vec3, normal: Vec3) -> Self {
        let origin = center - right * (SIZE[0] * POINT * 0.5) - down * (SIZE[1] * POINT * 0.5);
        Self { origin, right, down, normal }
    }

    /// From panel points (x, y, 0) to stage space.
    pub fn model(&self) -> Mat4 {
        Mat4::from_cols(
            (self.right * POINT).extend(0.0),
            (self.down * POINT).extend(0.0),
            self.normal.extend(0.0),
            Vec4::new(self.origin.x, self.origin.y, self.origin.z, 1.0),
        )
    }

    /// Where a ray meets the panel's plane in front of it: the distance along the ray, and the
    /// point in panel points (maybe outside the panel).
    fn plane_point(&self, from: Vec3, dir: Vec3) -> Option<(f32, Pos2)> {
        let den = dir.dot(self.normal);
        if den.abs() < 1e-6 {
            return None;
        }
        let t = (self.origin - from).dot(self.normal) / den;
        if t < 0.0 {
            return None;
        }
        let at = from + dir * t - self.origin;
        Some((t, pos2(at.dot(self.right) / POINT, at.dot(self.down) / POINT)))
    }

    /// Where a ray meets the panel, if it does: the distance along the ray, and the point.
    pub fn hit(&self, from: Vec3, dir: Vec3) -> Option<(f32, Pos2)> {
        let (t, p) = self.plane_point(from, dir)?;
        (p.x >= 0.0 && p.y >= 0.0 && p.x <= SIZE[0] && p.y <= SIZE[1]).then_some((t, p))
    }

    /// Where a ray points on the panel, held to its edges: a press that began on the panel
    /// keeps it while the ray strays off, so a slider dragged past its end stops at the end.
    pub fn project(&self, from: Vec3, dir: Vec3) -> Option<Pos2> {
        let (_, p) = self.plane_point(from, dir)?;
        Some(pos2(p.x.clamp(0.0, SIZE[0]), p.y.clamp(0.0, SIZE[1])))
    }

    /// A panel point in stage space.
    pub fn to_stage(&self, p: Pos2) -> Vec3 {
        self.origin + (self.right * p.x + self.down * p.y) * POINT
    }
}

/// The painting hand's pointer on the panel this frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pointer {
    /// Where it points, in panel points; None when it is off the panel.
    pub at: Option<Pos2>,
    pub pressed: bool,
}

/// What the panel asks for beyond the brush settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    Undo,
    Redo,
    Recenter,
}

/// One frame of the panel: what to draw, egui's texture changes, and what was asked.
pub struct Frame {
    pub primitives: Vec<egui::ClippedPrimitive>,
    pub textures: egui::TexturesDelta,
    pub actions: Vec<Action>,
}

/// What the panel shows and changes.
pub struct Model<'a> {
    pub brush: &'a mut Brush,
    /// Newest first, sRGB.
    pub recent: &'a [[u8; 3]],
    pub can_undo: bool,
    pub can_redo: bool,
}

pub struct Panel {
    ctx: egui::Context,
    started: Instant,
    was_pressed: bool,
    was_on: bool,
    /// The color picker (sRGB HSV). Kept here so a gray keeps its hue on the strip.
    hsv: [f32; 3],
    /// The brush color the picker last saw (linear RGB), to notice changes from elsewhere.
    seen: [f32; 3],
}

impl Panel {
    pub fn new(brush: &Brush) -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(PIXELS_PER_POINT);
        let mut v = egui::Visuals::dark();
        v.panel_fill = BG_2;
        v.override_text_color = Some(TEXT);
        v.selection.bg_fill = ACCENT_DIM;
        v.selection.stroke = stroke(1.0, ACCENT);
        for (w, fill) in [(&mut v.widgets.inactive, BG_3), (&mut v.widgets.hovered, BG_4), (&mut v.widgets.active, ACCENT_DIM)] {
            w.bg_fill = fill;
            w.weak_bg_fill = fill;
            w.rounding = egui::Rounding::same(4.0);
            w.fg_stroke = stroke(1.0, TEXT);
            w.bg_stroke = stroke(1.0, LINE);
        }
        ctx.set_visuals(v);
        // A click is a press that moves under 6 points; a hand pulling a trigger moves more.
        ctx.options_mut(|o| {
            o.input_options.max_click_dist = 30.0;
            o.input_options.max_click_duration = 3.0;
        });
        ctx.style_mut(|s| {
            for font in s.text_styles.values_mut() {
                font.size *= 1.25;
            }
            s.spacing.button_padding = vec2(12.0, 7.0);
            s.spacing.item_spacing = vec2(10.0, 9.0);
            s.spacing.interact_size.y = 30.0;
            s.interaction.selectable_labels = false;
        });
        let srgb = to_srgb(brush.color);
        Self { ctx, started: Instant::now(), was_pressed: false, was_on: false, hsv: rgb_to_hsv(srgb), seen: brush.color }
    }

    /// Lays the panel out for this frame, with the pointer's events.
    pub fn run(&mut self, pointer: Pointer, model: Model) -> Frame {
        let mut events = Vec::new();
        match pointer.at {
            Some(at) => {
                events.push(egui::Event::PointerMoved(at));
                if pointer.pressed != self.was_pressed {
                    events.push(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Primary, pressed: pointer.pressed, modifiers: Default::default() });
                }
                self.was_on = true;
            }
            None => {
                if self.was_on {
                    if self.was_pressed {
                        // A press that leaves the panel is let go, not left held.
                        events.push(egui::Event::PointerButton { pos: pos2(-1.0, -1.0), button: egui::PointerButton::Primary, pressed: false, modifiers: Default::default() });
                    }
                    events.push(egui::Event::PointerGone);
                }
                self.was_on = false;
            }
        }
        self.was_pressed = pointer.pressed && pointer.at.is_some();
        let input = egui::RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, vec2(SIZE[0], SIZE[1]))),
            time: Some(self.started.elapsed().as_secs_f64()),
            predicted_dt: 1.0 / 144.0,
            events,
            focused: true,
            ..Default::default()
        };
        if model.brush.color != self.seen {
            self.hsv = rgb_to_hsv(to_srgb(model.brush.color));
        }
        let mut actions = Vec::new();
        let hsv = &mut self.hsv;
        let output = self.ctx.run(input, |ctx| {
            let frame = egui::Frame { inner_margin: egui::Margin::same(16.0), rounding: egui::Rounding::same(8.0), fill: BG_2, stroke: stroke(1.0, LINE), ..Default::default() };
            egui::CentralPanel::default().frame(frame).show(ctx, |ui| content(ui, model.brush, hsv, model.recent, model.can_undo, model.can_redo, &mut actions));
            // The pointer: a ring where the ray meets the panel.
            if let Some(at) = pointer.at {
                let p = ctx.layer_painter(egui::LayerId::new(egui::Order::Tooltip, egui::Id::new("pointer")));
                p.circle_stroke(at, 6.0, stroke(2.0, Color32::WHITE));
                p.circle_stroke(at, 8.0, stroke(1.5, Color32::from_black_alpha(160)));
            }
        });
        self.seen = model.brush.color;
        let primitives = self.ctx.tessellate(output.shapes, output.pixels_per_point);
        Frame { primitives, textures: output.textures_delta, actions }
    }
}

fn content(ui: &mut egui::Ui, brush: &mut Brush, hsv: &mut [f32; 3], recent: &[[u8; 3]], can_undo: bool, can_redo: bool, actions: &mut Vec<Action>) {
    ui.horizontal(|ui| {
        ui.label(RichText::new("Brush").strong().size(19.0));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.add_enabled(can_redo, egui::Button::new("Redo")).clicked() {
                actions.push(Action::Redo);
            }
            if ui.add_enabled(can_undo, egui::Button::new("Undo")).clicked() {
                actions.push(Action::Undo);
            }
        });
    });
    ui.add_space(4.0);
    let mut diameter = brush.radius * 2.0;
    if slider(ui, "Size", &mut diameter, DIAMETER, true, |d| if d < 0.01 { format!("{:.1} mm", d * 1000.0) } else { format!("{:.1} cm", d * 100.0) }) {
        brush.radius = diameter * 0.5;
    }
    slider(ui, "Opacity", &mut brush.opacity, (0.01, 1.0), false, percent);
    slider(ui, "Hardness", &mut brush.hardness, (0.0, 1.0), false, percent);
    ui.horizontal(|ui| {
        ui.add_space(80.0);
        if toggle(ui, "P·size", brush.pressure_size).clicked() {
            brush.pressure_size = !brush.pressure_size;
        }
    });

    ui.add_space(6.0);
    section(ui, "COLOR");
    let mut changed = sv_square(ui, hsv);
    changed |= hue_strip(ui, hsv);
    let srgb = hsv_to_rgb(*hsv);
    let bytes = srgb.map(|c| (c * 255.0).round() as u8);
    ui.horizontal(|ui| {
        let (chip, _) = ui.allocate_exact_size(vec2(26.0, 26.0), Sense::hover());
        ui.painter().rect(chip, 4.0, Color32::from_rgb(bytes[0], bytes[1], bytes[2]), stroke(1.0, LINE));
        ui.label(RichText::new(format!("#{:02X}{:02X}{:02X}", bytes[0], bytes[1], bytes[2])).monospace().color(TEXT_DIM));
    });
    if let Some(pick) = swatches(ui, recent) {
        *hsv = rgb_to_hsv(pick.map(|c| c as f32 / 255.0));
        changed = true;
    }
    if changed {
        brush.color = to_linear(hsv_to_rgb(*hsv));
    }

    ui.add_space(6.0);
    ui.separator();
    ui.horizontal(|ui| {
        if ui.button("Recenter").clicked() {
            actions.push(Action::Recenter);
        }
        ui.label(RichText::new("Left stick: fly · Right stick: turn, rise").color(TEXT_DIM).size(13.0));
    });
}

fn percent(v: f32) -> String {
    if v < 0.1 { format!("{:.1}%", v * 100.0) } else { format!("{:.0}%", v * 100.0) }
}

/// A section header, as the 2D app's: small capitals, dim.
fn section(ui: &mut egui::Ui, text: &str) {
    ui.label(RichText::new(text).size(13.0).color(TEXT_DIM).extra_letter_spacing(0.8));
}

/// The 2D app's toggle button: dim text with a thin border, blue when on.
fn toggle(ui: &mut egui::Ui, text: &str, on: bool) -> egui::Response {
    let button = egui::Button::new(RichText::new(text).size(14.0).color(if on { TEXT } else { TEXT_DIM }))
        .fill(if on { TOGGLE_ON } else { BG_2 })
        .stroke(stroke(1.0, if on { ACCENT_DIM } else { LINE }));
    ui.add(button)
}

/// The 2D app's slider position of a value (0..1): logarithmic or linear.
pub fn slider_pos(v: f32, (lo, hi): (f32, f32), log: bool) -> f32 {
    if log { ((v / lo).ln() / (hi / lo).ln()).clamp(0.0, 1.0) } else { ((v - lo) / (hi - lo)).clamp(0.0, 1.0) }
}

/// The value at a slider position. Logarithmic values keep 3 significant digits, as in the 2D
/// app (multiplayer-canvas src/client/ui/Slider.svelte).
pub fn slider_value(p: f32, (lo, hi): (f32, f32), log: bool) -> f32 {
    let p = p.clamp(0.0, 1.0);
    if log {
        let v = lo * (hi / lo).powf(p);
        let q = 10f32.powf(v.log10().floor() - 2.0);
        ((v / q).round() * q).clamp(lo, hi)
    } else {
        lo + (hi - lo) * p
    }
}

/// The 2D app's slider: a dim label, a thin rail with an accent fill and a round thumb, then the
/// value. Returns whether the value changed.
fn slider(ui: &mut egui::Ui, label: &str, value: &mut f32, range: (f32, f32), log: bool, text: impl Fn(f32) -> String) -> bool {
    let mut changed = false;
    ui.horizontal(|ui| {
        let (label_rect, _) = ui.allocate_exact_size(vec2(70.0, 30.0), Sense::hover());
        ui.painter().text(label_rect.left_center(), egui::Align2::LEFT_CENTER, label, egui::FontId::proportional(15.0), TEXT_DIM);
        let width = ui.available_width() - 78.0;
        let (rect, response) = ui.allocate_exact_size(vec2(width, 30.0), Sense::click_and_drag());
        if let Some(at) = response.interact_pointer_pos() {
            if response.is_pointer_button_down_on() || response.clicked() {
                let v = slider_value((at.x - rect.left()) / rect.width(), range, log);
                if v != *value {
                    *value = v;
                    changed = true;
                }
            }
        }
        let p = slider_pos(*value, range, log);
        let rail = Rect::from_center_size(rect.center(), vec2(rect.width(), 4.0));
        let x = rail.left() + rail.width() * p;
        let painter = ui.painter();
        painter.rect_filled(rail, 2.0, BG_4);
        painter.rect_filled(Rect::from_min_max(rail.min, pos2(x, rail.max.y)), 2.0, ACCENT_DIM);
        let grow = if response.is_pointer_button_down_on() { 1.25 } else if response.hovered() { 1.1 } else { 1.0 };
        painter.circle_filled(pos2(x, rect.center().y), 7.0 * grow, TEXT);
        let (value_rect, _) = ui.allocate_exact_size(vec2(68.0, 30.0), Sense::hover());
        ui.painter().text(value_rect.right_center(), egui::Align2::RIGHT_CENTER, text(*value), egui::FontId::proportional(15.0), TEXT);
    });
    changed
}

/// Saturation (left to right) and value (top to bottom) of the hue, as the 2D app's square:
/// white to the hue across, black over it downward. Drawn as a grid so the colors match.
fn sv_square(ui: &mut egui::Ui, hsv: &mut [f32; 3]) -> bool {
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 150.0), Sense::click_and_drag());
    let mut changed = false;
    if let Some(at) = response.interact_pointer_pos() {
        if response.is_pointer_button_down_on() || response.clicked() {
            hsv[1] = ((at.x - rect.left()) / rect.width()).clamp(0.0, 1.0);
            hsv[2] = 1.0 - ((at.y - rect.top()) / rect.height()).clamp(0.0, 1.0);
            changed = true;
        }
    }
    const N: usize = 16;
    let mut mesh = egui::Mesh::default();
    for j in 0..=N {
        for i in 0..=N {
            let (s, v) = (i as f32 / N as f32, 1.0 - j as f32 / N as f32);
            let c = hsv_to_rgb([hsv[0], s, v]).map(|c| (c * 255.0).round() as u8);
            mesh.colored_vertex(pos2(rect.left() + rect.width() * s, rect.top() + rect.height() * (1.0 - v)), Color32::from_rgb(c[0], c[1], c[2]));
        }
    }
    for j in 0..N as u32 {
        for i in 0..N as u32 {
            let a = j * (N as u32 + 1) + i;
            let b = a + N as u32 + 1;
            mesh.add_triangle(a, a + 1, b);
            mesh.add_triangle(a + 1, b + 1, b);
        }
    }
    let painter = ui.painter();
    painter.add(egui::Shape::mesh(mesh));
    painter.rect_stroke(rect, 2.0, stroke(1.0, LINE));
    let knob = pos2(rect.left() + rect.width() * hsv[1], rect.top() + rect.height() * (1.0 - hsv[2]));
    painter.circle_stroke(knob, 7.0, stroke(2.5, Color32::WHITE));
    painter.circle_stroke(knob, 8.5, stroke(1.0, Color32::from_black_alpha(140)));
    changed
}

/// The hue strip, as the 2D app's: a rainbow left to right, with a white-bordered knob.
fn hue_strip(ui: &mut egui::Ui, hsv: &mut [f32; 3]) -> bool {
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 22.0), Sense::click_and_drag());
    let mut changed = false;
    if let Some(at) = response.interact_pointer_pos() {
        if response.is_pointer_button_down_on() || response.clicked() {
            hsv[0] = ((at.x - rect.left()) / rect.width()).clamp(0.0, 0.9999);
            changed = true;
        }
    }
    const N: usize = 36;
    let mut mesh = egui::Mesh::default();
    for i in 0..=N {
        let h = i as f32 / N as f32;
        let c = hsv_to_rgb([h.min(0.9999), 1.0, 1.0]).map(|c| (c * 255.0).round() as u8);
        let x = rect.left() + rect.width() * h;
        mesh.colored_vertex(pos2(x, rect.top()), Color32::from_rgb(c[0], c[1], c[2]));
        mesh.colored_vertex(pos2(x, rect.bottom()), Color32::from_rgb(c[0], c[1], c[2]));
    }
    for i in 0..N as u32 {
        mesh.add_triangle(2 * i, 2 * i + 1, 2 * i + 2);
        mesh.add_triangle(2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    let painter = ui.painter();
    painter.add(egui::Shape::mesh(mesh));
    let x = rect.left() + rect.width() * hsv[0];
    let knob = Rect::from_center_size(pos2(x, rect.center().y), vec2(8.0, rect.height() + 6.0));
    painter.rect_stroke(knob, 2.0, stroke(2.5, Color32::WHITE));
    changed
}

/// Recent colors, 9 to a row as in the 2D app. Returns the one clicked.
fn swatches(ui: &mut egui::Ui, recent: &[[u8; 3]]) -> Option<[u8; 3]> {
    if recent.is_empty() {
        return None;
    }
    let mut picked = None;
    let size = (ui.available_width() - 8.0 * 4.0) / 9.0;
    for row in recent.chunks(9) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            for c in row {
                let (rect, response) = ui.allocate_exact_size(vec2(size, size * 0.75), Sense::click());
                let stroke = if response.hovered() { stroke(2.0, TEXT) } else { stroke(1.0, LINE) };
                ui.painter().rect(rect, 3.0, Color32::from_rgb(c[0], c[1], c[2]), stroke);
                if response.clicked() {
                    picked = Some(*c);
                }
            }
        });
    }
    picked
}

pub fn hsv_to_rgb([h, s, v]: [f32; 3]) -> [f32; 3] {
    let h = h.rem_euclid(1.0) * 6.0;
    let c = v * s;
    let x = c * (1.0 - ((h % 2.0) - 1.0).abs());
    let (r, g, b) = match h as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    [r + m, g + m, b + m]
}

pub fn rgb_to_hsv([r, g, b]: [f32; 3]) -> [f32; 3] {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let h = if d <= 0.0 {
        0.0
    } else if max == r {
        ((g - b) / d).rem_euclid(6.0) / 6.0
    } else if max == g {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    [h, if max > 0.0 { d / max } else { 0.0 }, max]
}

/// sRGB (0..1) to linear.
pub fn to_linear(c: [f32; 3]) -> [f32; 3] {
    c.map(|c| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) })
}

/// Linear to sRGB (0..1).
pub fn to_srgb(c: [f32; 3]) -> [f32; 3] {
    c.map(|c| {
        let c = c.clamp(0.0, 1.0);
        if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_slider_round_trips_with_three_digits() {
        let r = DIAMETER;
        for v in [0.001, 0.0123, 0.05, 0.4] {
            let back = slider_value(slider_pos(v, r, true), r, true);
            assert!((back - v).abs() <= v * 0.005, "{v} -> {back}");
        }
        // Three significant digits.
        let v = slider_value(0.37, r, true);
        let q = 10f32.powf(v.log10().floor() - 2.0);
        assert!(((v / q) - (v / q).round()).abs() < 1e-3, "{v}");
    }

    #[test]
    fn colors_round_trip() {
        for c in [[1.0, 0.0, 0.0], [0.2, 0.6, 0.9], [0.5, 0.5, 0.5], [0.0, 0.0, 0.0]] {
            let back = hsv_to_rgb(rgb_to_hsv(c));
            assert!(back.iter().zip(c).all(|(a, b)| (a - b).abs() < 1e-5), "{c:?} -> {back:?}");
            let lin = to_srgb(to_linear(c));
            assert!(lin.iter().zip(c).all(|(a, b)| (a - b).abs() < 1e-5));
        }
    }

    #[test]
    fn a_ray_hits_the_panel_where_it_points() {
        let p = Placement::above_hand(Vec3::new(0.0, 1.0, -0.4), Vec3::new(0.0, 1.19, 0.0));
        // Straight at the center from the head.
        let center = p.to_stage(pos2(SIZE[0] * 0.5, SIZE[1] * 0.5));
        assert!(center.abs_diff_eq(Vec3::new(0.0, 1.19, -0.4), 1e-5));
        let (t, at) = p.hit(Vec3::new(0.0, 1.19, 0.0), Vec3::NEG_Z).unwrap();
        assert!((t - 0.4).abs() < 1e-5 && (at - pos2(220.0, 300.0)).length() < 1e-3, "{t} {at:?}");
        // A little right and up: the point moves right and up on the panel.
        let (_, at) = p.hit(Vec3::new(0.02, 1.2, 0.0), Vec3::NEG_Z).unwrap();
        assert!(at.x > 220.0 && at.y < 300.0, "{at:?}");
        // Off the side: no hit, but the projection holds to the edge.
        assert!(p.hit(Vec3::new(0.5, 1.19, 0.0), Vec3::NEG_Z).is_none());
        assert_eq!(p.project(Vec3::new(0.5, 1.19, 0.0), Vec3::NEG_Z).unwrap().x, SIZE[0]);
        // The model matrix puts point (0, 0) at the corner.
        assert!(p.model().transform_point3(Vec3::ZERO).abs_diff_eq(p.origin, 1e-6));
    }
}
