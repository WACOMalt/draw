//! The panel's widgets, in the 2D app's look (multiplayer-canvas app.css, Slider.svelte,
//! ColorPanel.svelte, Icon.svelte): sliders, toggles, icons (its SVG paths), the color square
//! and hue strip, swatches; and color conversions.

use egui::{Color32, Pos2, Rect, RichText, Sense, Stroke, pos2, vec2};

// The 2D app's theme (app.css).
pub const BG_1: Color32 = Color32::from_rgb(0x26, 0x26, 0x26);
pub const BG_2: Color32 = Color32::from_rgb(0x2f, 0x2f, 0x2f);
pub const BG_3: Color32 = Color32::from_rgb(0x3a, 0x3a, 0x3a);
pub const BG_4: Color32 = Color32::from_rgb(0x47, 0x47, 0x47);
pub const LINE: Color32 = Color32::from_rgb(0x3d, 0x3d, 0x3d);
pub const BORDER: Color32 = Color32::from_rgb(0x16, 0x16, 0x16);
pub const TEXT: Color32 = Color32::from_rgb(0xd6, 0xd6, 0xd6);
pub const TEXT_DIM: Color32 = Color32::from_rgb(0x9a, 0x9a, 0x9a);
pub const TEXT_FAINT: Color32 = Color32::from_rgb(0x6c, 0x6c, 0x6c);
pub const ACCENT: Color32 = Color32::from_rgb(0x31, 0xa8, 0xff);
pub const ACCENT_DIM: Color32 = Color32::from_rgb(0x1f, 0x6f, 0xb0);
pub const TOGGLE_ON: Color32 = Color32::from_rgb(0x24, 0x39, 0x4c);
/// The Layers panel's active row, and a row under the pointer.
pub const ROW_ACTIVE: Color32 = Color32::from_rgb(0x3d, 0x4b, 0x59);
pub const ROW_HOVER: Color32 = Color32::from_rgb(0x34, 0x34, 0x34);
pub const ROW_LINE: Color32 = Color32::from_rgb(0x29, 0x29, 0x29);

/// Recent colors kept, as in the 2D app.
pub const RECENT: usize = 18;

/// A line of `width` points (typed, for egui's `impl Into<f32>`).
pub fn stroke(width: f32, color: Color32) -> Stroke {
    Stroke::new(width, color)
}

/// The 2D app's icons (Icon.svelte: 16x16, drawn with a 1.6 line, round ends).
pub fn icon_path(name: &str) -> &'static str {
    match name {
        "brush" => "M14.5 1.5l-7 8M7.5 9.5c-1.5-1.5-4 -0.5-4 1.5 0 1.5-1 2.5-2 3 3 0.5 6 0 6-3z",
        "eraser" => "M6 14h8M2.5 10.5l7-7a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2L7 14H5.5z M5.5 7.5l4 4",
        "strokeEraser" => "M1.5 12.5c2.5-5 4.5-5 6.5-1.5s4.5 3 6.5-3M8.5 2.5l4 4M12.5 2.5l-4 4",
        "eyedropper" => "M10 3.5l2.5 2.5M2 14l1-3 6.5-6.5 2.5 2.5L5.5 13.5zM9.5 2.5a1.8 1.8 0 0 1 2.5 0l1.5 1.5a1.8 1.8 0 0 1 0 2.5l-1 1-4-4z",
        "undo" => "M4 6h6a4 4 0 0 1 0 8H6M4 6l3-3M4 6l3 3",
        "redo" => "M12 6H6a4 4 0 0 0 0 8h4M12 6L9 3M12 6L9 9",
        "eye" => "M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
        "eyeoff" => "M2 2l12 12M6.5 3.3A7 7 0 0 1 8 3c4.5 0 7 5 7 5a12 12 0 0 1-2 2.6M4 4.8C2 6.2 1 8 1 8s2.5 5 7 5a7 7 0 0 0 3-.7",
        "plus" => "M8 3v10M3 8h10",
        "minus" => "M3 8h10",
        "trash" => "M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5",
        "up" => "M8 13V3M4 7l4-4 4 4",
        "down" => "M8 3v10M4 9l4 4 4-4",
        "swap" => "M10 2.5l2.5 2.5L10 7.5M12.5 5H6M6 13.5L3.5 11 6 8.5M3.5 11H10",
        "layers" => "M8 2L1.5 5.5 8 9l6.5-3.5zM1.5 8.5L8 12l6.5-3.5M1.5 11.5L8 15l6.5-3.5",
        "close" => "M4 4l8 8M12 4l-8 8",
        "mask" => "M2 2h12v12H2zM8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
        "clip" => "M4 2v6a3 3 0 0 0 3 3h6M10.5 8.5L13 11l-2.5 2.5",
        "dynamics" => "M2 13c2-6 4-9 6-9s2 5 4 5 2-3 2-3M3 4h2M4 3v2M11 12h2",
        "presets" => "M2 3h5v5H2zM9 3h5v5H9zM2 10h5v4H2zM9 10h5v4H9z",
        "folder" => "M1.5 4V13h13V5.5H7.5L6 4z",
        "group" => "M1.5 4V13h13V5.5H7.5L6 4zM8 7.5v4M6 9.5h4",
        "copy" => "M5.5 5.5h8v8h-8zM2.5 10.5v-8h8",
        "grip" => "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01",
        "chevron" => "M6 4l4 4-4 4",
        "settings" => "M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
        "transform" => "M2.5 2.5h4M2.5 2.5v4M13.5 13.5h-4M13.5 13.5v-4M4.5 11.5l7-7M8 4.5h3.5V8",
        "pushpin" => "M5.5 1.5h5M6.5 1.5v4.5L4 9h8L9.5 6V1.5M8 9v5.5",
        "color" => "M8 1.5a6.5 6.5 0 1 0 0 13c1 0 1.5-.7 1.5-1.4 0-1.3 1-1.6 2-1.6h1.2a1.8 1.8 0 0 0 1.8-1.8A6.6 6.6 0 0 0 8 1.5zM4.5 8a.6.6 0 1 0 0 .1M6 5a.6.6 0 1 0 0 .1M10 5a.6.6 0 1 0 0 .1",
        _ => "",
    }
}

/// Draws an icon (by name) centered in `rect`, `size` points across.
pub fn paint_icon(painter: &egui::Painter, name: &str, rect: Rect, size: f32, color: Color32) {
    let origin = rect.center() - vec2(size, size) * 0.5;
    for (points, closed) in svg_polylines(icon_path(name)) {
        let mut points: Vec<Pos2> = points.into_iter().map(|p| origin + p.to_vec2() * (size / 16.0)).collect();
        let line = stroke(1.6 * size / 16.0, color);
        if points.len() == 2 && (points[0] - points[1]).length() < 0.1 {
            // A dot (the grip's): a round one.
            painter.circle_filled(points[0], line.width * 0.6, color);
            continue;
        }
        if closed && points.first() == points.last() {
            points.pop();
        }
        painter.add(if closed { egui::Shape::closed_line(points, line) } else { egui::Shape::line(points, line) });
    }
}

/// An icon button, as the 2D app's `button.icon`: transparent, a lighter fill under the
/// pointer, raised (bg-4 with a dark border) when `on`; dim when not `enabled`.
pub fn icon_button(ui: &mut egui::Ui, name: &str, size: egui::Vec2, on: bool, enabled: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(size, if enabled { Sense::click() } else { Sense::hover() });
    let painter = ui.painter();
    if on {
        painter.rect(rect, 4.0, BG_4, stroke(1.0, BORDER));
    } else if enabled && response.hovered() {
        painter.rect_filled(rect, 4.0, BG_3);
    }
    paint_icon(painter, name, rect, (size.y * 0.55).min(26.0), if enabled { TEXT } else { TEXT_FAINT });
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

pub fn percent(v: f32) -> String {
    if v < 0.1 { format!("{:.1}%", v * 100.0) } else { format!("{:.0}%", v * 100.0) }
}

/// A section header, as the 2D app's: small capitals, dim.
pub fn section(ui: &mut egui::Ui, text: &str) {
    ui.label(RichText::new(text).size(13.0).color(TEXT_DIM).extra_letter_spacing(0.8));
}

/// The 2D app's toggle button: dim text with a thin border, blue when on.
pub fn toggle(ui: &mut egui::Ui, text: &str, on: bool) -> egui::Response {
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
pub fn slider(ui: &mut egui::Ui, label: &str, value: &mut f32, range: (f32, f32), log: bool, text: impl Fn(f32) -> String) -> bool {
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
pub fn sv_square(ui: &mut egui::Ui, hsv: &mut [f32; 3]) -> bool {
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
pub fn hue_strip(ui: &mut egui::Ui, hsv: &mut [f32; 3]) -> bool {
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
pub fn swatches(ui: &mut egui::Ui, recent: &[[u8; 3]]) -> Option<[u8; 3]> {
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
