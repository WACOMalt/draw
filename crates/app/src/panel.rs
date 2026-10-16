//! The tool panel. It floats above the hand that is not painting, turned to face the head;
//! the painting hand points at it and clicks with the trigger.
//!
//! Made with egui and drawn by `vdraw_render::UiRenderer`, as bs-humany's xr-viewer does its
//! panels. Its controls and look follow the 2D app (multiplayer-canvas: Toolbar, OptionsBar,
//! Slider, ColorPanel, and the Layers panel's paint mixing) as far as they apply in 3D: the
//! tools (brush, eraser, stroke eraser, with the 2D app's icons), each tool's settings (size,
//! logarithmic; opacity, hardness, roundness, angle, pressure to size; the stroke eraser's size
//! and layers), an HSV square with a hue strip, recent colors, undo and redo, and how paint
//! mixes.

use crate::tools::{Tool, Tools};
use egui::{Color32, Pos2, Rect, RichText, Sense, Stroke, pos2, vec2};
use glam::{Mat4, Vec3, Vec4};
use std::time::Instant;
use vdraw_core::{Brush, Mix};

/// Meters per panel point.
pub const POINT: f32 = 0.0005;
/// The panel's size in points (0.22 x 0.39 m).
pub const SIZE: [f32; 2] = [440.0, 780.0];
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
const BORDER: Color32 = Color32::from_rgb(0x16, 0x16, 0x16);

/// A line of `width` points (typed, for egui's `impl Into<f32>`).
fn stroke(width: f32, color: Color32) -> Stroke {
    Stroke::new(width, color)
}

/// Brush diameter range, meters (the 2D app's 1 to 1000 px, as a log slider).
const DIAMETER: (f32, f32) = (0.001, 0.4);
/// The stroke eraser's diameter range, meters (the 2D app's 2 to 400 px).
const SWEEP: (f32, f32) = (0.002, 0.4);
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

/// What the panel asks for beyond the tool settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    Undo,
    Redo,
    Recenter,
    /// Paint mixing (the painting's, an edit that undo takes back).
    Mix(Mix),
}

/// One frame of the panel: what to draw, egui's texture changes, and what was asked.
pub struct Frame {
    pub primitives: Vec<egui::ClippedPrimitive>,
    pub textures: egui::TexturesDelta,
    pub actions: Vec<Action>,
}

/// What the panel shows and changes.
pub struct Model<'a> {
    pub tools: &'a mut Tools,
    pub mix: Mix,
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
        if model.tools.brush.color != self.seen {
            self.hsv = rgb_to_hsv(to_srgb(model.tools.brush.color));
        }
        let mut actions = Vec::new();
        let hsv = &mut self.hsv;
        let output = self.ctx.run(input, |ctx| {
            let frame = egui::Frame { inner_margin: egui::Margin::same(16.0), rounding: egui::Rounding::same(8.0), fill: BG_2, stroke: stroke(1.0, LINE), ..Default::default() };
            egui::CentralPanel::default().frame(frame).show(ctx, |ui| content(ui, model.tools, model.mix, hsv, model.recent, model.can_undo, model.can_redo, &mut actions));
            // The pointer: a ring where the ray meets the panel.
            if let Some(at) = pointer.at {
                let p = ctx.layer_painter(egui::LayerId::new(egui::Order::Tooltip, egui::Id::new("pointer")));
                p.circle_stroke(at, 6.0, stroke(2.0, Color32::WHITE));
                p.circle_stroke(at, 8.0, stroke(1.5, Color32::from_black_alpha(160)));
            }
        });
        self.seen = model.tools.brush.color;
        let primitives = self.ctx.tessellate(output.shapes, output.pixels_per_point);
        Frame { primitives, textures: output.textures_delta, actions }
    }
}

#[allow(clippy::too_many_arguments)]
fn content(ui: &mut egui::Ui, tools: &mut Tools, mix: Mix, hsv: &mut [f32; 3], recent: &[[u8; 3]], can_undo: bool, can_redo: bool, actions: &mut Vec<Action>) {
    // The toolbar, as the 2D app's: its icons, the chosen one raised.
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        for tool in Tool::ALL {
            if tool_button(ui, tool, tools.tool == tool).clicked() {
                tools.tool = tool;
            }
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.add_enabled(can_redo, egui::Button::new("Redo")).clicked() {
                actions.push(Action::Redo);
            }
            if ui.add_enabled(can_undo, egui::Button::new("Undo")).clicked() {
                actions.push(Action::Undo);
            }
        });
    });
    ui.add_space(2.0);
    // The tool's settings, under its name (the 2D app's options bar).
    ui.label(RichText::new(tools.tool.name()).strong().size(19.0));
    let tool = tools.tool;
    match tools.current() {
        Some((brush, angle)) => brush_settings(ui, brush, angle),
        None => {
            let mut diameter = tools.sweep_size;
            if slider(ui, "Size", &mut diameter, SWEEP, true, length) {
                tools.sweep_size = diameter;
            }
            ui.horizontal(|ui| {
                ui.add_space(94.0);
                if toggle(ui, "All layers", tools.sweep_all).clicked() {
                    tools.sweep_all = true;
                }
                if toggle(ui, "Active layer", !tools.sweep_all).clicked() {
                    tools.sweep_all = false;
                }
            });
            ui.label(RichText::new("Removes every stroke whose path the ball touches. Undo brings them back.").color(TEXT_DIM).size(14.0));
        }
    }

    if tool == Tool::Brush {
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
            tools.brush.color = to_linear(hsv_to_rgb(*hsv));
        }
    }

    // The bottom: the painting's paint mixing (the 2D app's canvas setting), and moving.
    ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
        ui.horizontal(|ui| {
            if ui.button("Recenter").clicked() {
                actions.push(Action::Recenter);
            }
            ui.label(RichText::new("Left stick: fly · Right stick: turn, rise").color(TEXT_DIM).size(13.0));
        });
        ui.separator();
        ui.horizontal(|ui| {
            let (label, _) = ui.allocate_exact_size(vec2(120.0, 30.0), Sense::hover());
            ui.painter().text(label.left_center(), egui::Align2::LEFT_CENTER, "Paint mixing", egui::FontId::proportional(15.0), TEXT_DIM);
            for (name, m) in [("Normal", Mix::Normal), ("Pigment", Mix::Pigment)] {
                if toggle(ui, name, mix == m).clicked() && mix != m {
                    actions.push(Action::Mix(m));
                }
            }
        });
    });
}

/// The brush's or the eraser's settings: size (logarithmic), opacity, hardness, the tip's
/// roundness and angle, and pressure to size.
fn brush_settings(ui: &mut egui::Ui, brush: &mut Brush, angle: &mut f32) {
    let mut diameter = brush.radius * 2.0;
    if slider(ui, "Size", &mut diameter, DIAMETER, true, length) {
        brush.radius = diameter * 0.5;
    }
    slider(ui, "Opacity", &mut brush.opacity, (0.01, 1.0), false, percent);
    slider(ui, "Hardness", &mut brush.hardness, (0.0, 1.0), false, percent);
    slider(ui, "Roundness", &mut brush.roundness, (0.05, 1.0), false, percent);
    slider(ui, "Angle", angle, (0.0, 360.0), false, |a| format!("{a:.0}°"));
    ui.horizontal(|ui| {
        ui.add_space(94.0);
        if toggle(ui, "P·size", brush.pressure_size).clicked() {
            brush.pressure_size = !brush.pressure_size;
        }
    });
}

/// A length in millimeters or centimeters.
fn length(d: f32) -> String {
    if d < 0.01 { format!("{:.1} mm", d * 1000.0) } else { format!("{:.1} cm", d * 100.0) }
}

/// The 2D app's tool icons (multiplayer-canvas Icon.svelte: 16x16, drawn with a 1.6 line).
fn icon_path(tool: Tool) -> &'static str {
    match tool {
        Tool::Brush => "M14.5 1.5l-7 8M7.5 9.5c-1.5-1.5-4 -0.5-4 1.5 0 1.5-1 2.5-2 3 3 0.5 6 0 6-3z",
        Tool::Eraser => "M6 14h8M2.5 10.5l7-7a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2L7 14H5.5z M5.5 7.5l4 4",
        Tool::StrokeEraser => "M1.5 12.5c2.5-5 4.5-5 6.5-1.5s4.5 3 6.5-3M8.5 2.5l4 4M12.5 2.5l-4 4",
    }
}

/// A tool button: transparent, a lighter fill under the pointer, raised (bg-4 with a dark
/// border) when chosen, as the 2D app's toolbar.
fn tool_button(ui: &mut egui::Ui, tool: Tool, on: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(54.0, 44.0), Sense::click());
    let painter = ui.painter();
    if on {
        painter.rect(rect, 4.0, BG_4, stroke(1.0, BORDER));
    } else if response.hovered() {
        painter.rect_filled(rect, 4.0, BG_3);
    }
    let size = 26.0;
    let origin = rect.center() - vec2(size, size) * 0.5;
    for (points, closed) in svg_polylines(icon_path(tool)) {
        let points: Vec<Pos2> = points.into_iter().map(|p| origin + p.to_vec2() * (size / 16.0)).collect();
        let line = stroke(1.6 * size / 16.0, TEXT);
        painter.add(if closed { egui::Shape::closed_line(points, line) } else { egui::Shape::line(points, line) });
    }
    response
}

/// The polylines of an SVG path (M, L, H, V, C, S, A, Z, absolute and relative; arcs of
/// circles), curves cut into short lines. Each: its points, and whether it closes.
pub fn svg_polylines(d: &str) -> Vec<(Vec<Pos2>, bool)> {
    // Tokens: command letters and numbers ("-4 -0.5", "1.4 1.4", "0-1.5").
    let mut tokens: Vec<Result<char, f32>> = Vec::new();
    let mut num = String::new();
    let flush = |num: &mut String, tokens: &mut Vec<Result<char, f32>>| {
        if !num.is_empty() {
            tokens.push(Err(num.parse().unwrap_or(0.0)));
            num.clear();
        }
    };
    for c in d.chars() {
        if c.is_ascii_alphabetic() {
            flush(&mut num, &mut tokens);
            tokens.push(Ok(c));
        } else if (c == '-' && !num.is_empty() && !num.ends_with('e')) || (c == '.' && num.contains('.')) {
            // A sign, or a second point, starts the next number.
            flush(&mut num, &mut tokens);
            num.push(c);
        } else if c.is_ascii_digit() || c == '.' || c == '-' {
            num.push(c);
        } else {
            flush(&mut num, &mut tokens);
        }
    }
    flush(&mut num, &mut tokens);

    let mut out: Vec<(Vec<Pos2>, bool)> = Vec::new();
    let mut line: Vec<Pos2> = Vec::new();
    let (mut at, mut start, mut ctrl) = (Pos2::ZERO, Pos2::ZERO, None::<Pos2>);
    let mut cmd = 'M';
    let mut i = 0;
    let take = |i: &mut usize, n: usize| -> Option<Vec<f32>> {
        let v: Vec<f32> = tokens[*i..].iter().take(n).map_while(|t| t.err()).collect();
        (v.len() == n).then(|| {
            *i += n;
            v
        })
    };
    let cubic = |line: &mut Vec<Pos2>, p0: Pos2, c1: Pos2, c2: Pos2, p3: Pos2| {
        for k in 1..=12 {
            let t = k as f32 / 12.0;
            let u = 1.0 - t;
            line.push(pos2(
                u * u * u * p0.x + 3.0 * u * u * t * c1.x + 3.0 * u * t * t * c2.x + t * t * t * p3.x,
                u * u * u * p0.y + 3.0 * u * u * t * c1.y + 3.0 * u * t * t * c2.y + t * t * t * p3.y,
            ));
        }
    };
    while i < tokens.len() {
        if let Ok(c) = tokens[i] {
            cmd = c;
            i += 1;
            if c == 'Z' || c == 'z' {
                if line.len() > 1 {
                    out.push((std::mem::take(&mut line), true));
                }
                at = start;
                continue;
            }
        }
        let rel = cmd.is_ascii_lowercase();
        let base = if rel { at.to_vec2() } else { egui::Vec2::ZERO };
        let next = match cmd.to_ascii_uppercase() {
            'M' => take(&mut i, 2).map(|v| {
                if line.len() > 1 {
                    out.push((std::mem::take(&mut line), false));
                }
                line.clear();
                at = pos2(v[0], v[1]) + base;
                start = at;
                line.push(at);
                // Pairs after a move are lines.
                cmd = if rel { 'l' } else { 'L' };
                ctrl = None;
            }),
            'L' => take(&mut i, 2).map(|v| {
                at = pos2(v[0], v[1]) + base;
                line.push(at);
                ctrl = None;
            }),
            'H' => take(&mut i, 1).map(|v| {
                at = pos2(v[0] + base.x, at.y);
                line.push(at);
                ctrl = None;
            }),
            'V' => take(&mut i, 1).map(|v| {
                at = pos2(at.x, v[0] + base.y);
                line.push(at);
                ctrl = None;
            }),
            'C' => take(&mut i, 6).map(|v| {
                let (c1, c2, p) = (pos2(v[0], v[1]) + base, pos2(v[2], v[3]) + base, pos2(v[4], v[5]) + base);
                cubic(&mut line, at, c1, c2, p);
                (at, ctrl) = (p, Some(c2));
            }),
            'S' => take(&mut i, 4).map(|v| {
                let c1 = ctrl.map_or(at, |c| at + (at - c));
                let (c2, p) = (pos2(v[0], v[1]) + base, pos2(v[2], v[3]) + base);
                cubic(&mut line, at, c1, c2, p);
                (at, ctrl) = (p, Some(c2));
            }),
            'A' => take(&mut i, 7).map(|v| {
                // A circle's arc (the icons' arcs are round): its center from the ends, the
                // radius and the flags (SVG implementation notes, F.6.5).
                let (r, large, sweep, p) = (v[0].max(1e-6), v[3] != 0.0, v[4] != 0.0, pos2(v[5], v[6]) + base);
                let half = (at - p) * 0.5;
                let d2 = half.length_sq().max(1e-12);
                let r = r.max(d2.sqrt());
                let k = ((r * r - d2) / d2).max(0.0).sqrt() * if large == sweep { -1.0 } else { 1.0 };
                let c = pos2(k * half.y, -k * half.x) + ((at.to_vec2() + p.to_vec2()) * 0.5);
                let a0 = (at.y - c.y).atan2(at.x - c.x);
                let mut da = (p.y - c.y).atan2(p.x - c.x) - a0;
                if sweep && da < 0.0 {
                    da += std::f32::consts::TAU;
                } else if !sweep && da > 0.0 {
                    da -= std::f32::consts::TAU;
                }
                for s in 1..=8 {
                    let a = a0 + da * s as f32 / 8.0;
                    line.push(c + vec2(a.cos(), a.sin()) * r);
                }
                at = p;
                ctrl = None;
            }),
            _ => None,
        };
        if next.is_none() {
            // A command with too few numbers, or one not handled: skip a token.
            i += 1;
        }
    }
    if line.len() > 1 {
        out.push((line, false));
    }
    out
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
        let (label_rect, _) = ui.allocate_exact_size(vec2(84.0, 30.0), Sense::hover());
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
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 130.0), Sense::click_and_drag());
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
    fn icons_parse_into_their_lines() {
        // The brush: a handle (one line) and a closed bristle (cubic curves).
        let brush = svg_polylines(icon_path(Tool::Brush));
        assert_eq!(brush.len(), 2);
        assert_eq!(brush[0].0, vec![pos2(14.5, 1.5), pos2(7.5, 9.5)]);
        assert!(brush[1].1 && brush[1].0.len() > 20);
        // The eraser: its base, its body (with two round corners, closed), and the band.
        let eraser = svg_polylines(icon_path(Tool::Eraser));
        assert_eq!(eraser.iter().map(|l| l.1).collect::<Vec<_>>(), vec![false, true, false]);
        // A round corner stays on its circle: from (9.5, 3.5) over to (11.5, 3.5), bulging up.
        let body = &eraser[1].0;
        assert!(body.iter().any(|p| p.y < 3.3 && (p.x - 10.5).abs() < 0.3), "{body:?}");
        // The stroke eraser: a squiggle and two strokes of an X; all inside the 16x16 box.
        let se = svg_polylines(icon_path(Tool::StrokeEraser));
        assert_eq!(se.len(), 3);
        assert!(se.iter().flat_map(|l| &l.0).all(|p| (0.0..=16.0).contains(&p.x) && (0.0..=16.0).contains(&p.y)));
    }

    #[test]
    fn a_ray_hits_the_panel_where_it_points() {
        let p = Placement::above_hand(Vec3::new(0.0, 1.0, -0.4), Vec3::new(0.0, 1.19, 0.0));
        // Straight at the center from the head.
        let center = p.to_stage(pos2(SIZE[0] * 0.5, SIZE[1] * 0.5));
        assert!(center.abs_diff_eq(Vec3::new(0.0, 1.19, -0.4), 1e-5));
        let (t, at) = p.hit(Vec3::new(0.0, 1.19, 0.0), Vec3::NEG_Z).unwrap();
        assert!((t - 0.4).abs() < 1e-5 && (at - pos2(SIZE[0] * 0.5, SIZE[1] * 0.5)).length() < 1e-3, "{t} {at:?}");
        // A little right and up: the point moves right and up on the panel.
        let (_, at) = p.hit(Vec3::new(0.02, 1.2, 0.0), Vec3::NEG_Z).unwrap();
        assert!(at.x > SIZE[0] * 0.5 && at.y < SIZE[1] * 0.5, "{at:?}");
        // Off the side: no hit, but the projection holds to the edge.
        assert!(p.hit(Vec3::new(0.5, 1.19, 0.0), Vec3::NEG_Z).is_none());
        assert_eq!(p.project(Vec3::new(0.5, 1.19, 0.0), Vec3::NEG_Z).unwrap().x, SIZE[0]);
        // The model matrix puts point (0, 0) at the corner.
        assert!(p.model().transform_point3(Vec3::ZERO).abs_diff_eq(p.origin, 1e-6));
    }
}
