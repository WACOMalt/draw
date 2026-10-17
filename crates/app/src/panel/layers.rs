//! The Layers tab, as the 2D app's Layers panel (multiplayer-canvas LayersPanel.svelte): the
//! active layer's blend mode and opacity; the layers, top first, groups opening to show their
//! layers (each row: a grip to drag it, the clip arrow, the eye, the group's chevron, its name,
//! its mask, and tags for a blend mode and an opacity); paint mixing; the mask row; and the
//! footer's buttons. Adjustment layers and layer effects are left out.

use super::keyboard::{Target, Typing};
use super::widgets::*;
use crate::painter::{Painter, Removed};
use egui::{Color32, Rect, RichText, Sense, pos2, vec2};
use std::collections::HashSet;
use vdraw_core::{Blend, Mask, Mix, Place};

/// Rows' height (the 2D app's 34 px, larger for a laser).
const ROW: f32 = 40.0;
/// Indent per group level.
const INDENT: f32 = 16.0;

#[derive(Default)]
pub struct LayersState {
    /// Groups shown closed (by id).
    pub collapsed: HashSet<u32>,
    /// The layer being dragged by its grip (by id).
    drag: Option<u32>,
    /// A message for a while (a refused delete), and when it came.
    message: Option<(String, std::time::Instant)>,
}

/// The rows, top first: (layer place, depth).
fn rows(p: &vdraw_core::Painting, collapsed: &HashSet<u32>) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    fn walk(p: &vdraw_core::Painting, parent: Option<u32>, depth: usize, collapsed: &HashSet<u32>, out: &mut Vec<(usize, usize)>) {
        for i in p.children(parent).into_iter().rev() {
            out.push((i, depth));
            if p.layers[i].group && !collapsed.contains(&p.layers[i].id) {
                walk(p, Some(p.layers[i].id), depth + 1, collapsed, out);
            }
        }
    }
    walk(p, None, 0, collapsed, &mut out);
    out
}

/// The first word of a blend mode's label (the 2D app's tag).
fn tag(b: Blend) -> &'static str {
    b.label().split_whitespace().next().unwrap_or("")
}

pub fn layers_tab(ui: &mut egui::Ui, painter: &mut Painter, state: &mut LayersState, typing: &mut Option<Typing>) {
    let active = painter.active_index();
    let is_group = painter.painting.layers[active].group;

    // The active layer's blend mode and opacity.
    ui.horizontal(|ui| {
        let current = painter.painting.layers[active].blend;
        let mut chosen = current;
        egui::ComboBox::from_id_salt("blend")
            .selected_text(current.label())
            .width(170.0)
            .height(520.0)
            .show_ui(ui, |ui| {
                ui.style_mut().spacing.button_padding = vec2(10.0, 8.0);
                if is_group {
                    ui.selectable_value(&mut chosen, Blend::Pass, Blend::Pass.label());
                }
                for b in Blend::LAYER {
                    ui.selectable_value(&mut chosen, b, b.label());
                }
            });
        if chosen != current {
            painter.edit_layers(|p| {
                p.layers[active].blend = chosen;
                (Some(active), Removed::default())
            });
        }
        let mut opacity = painter.painting.layers[active].opacity;
        if slider(ui, "Opacity", &mut opacity, (0.0, 1.0), false, percent) {
            painter.edit_layers_merged("opacity", |p| {
                p.layers[active].opacity = opacity;
                (Some(active), Removed::default())
            });
        }
    });

    // The list, top first. Rows' rects are kept to drop a dragged layer on.
    let list = rows(&painter.painting, &state.collapsed);
    let mut rects: Vec<(usize, Rect)> = Vec::new();
    let height = (ui.available_height() - 190.0).max(3.0 * ROW);
    egui::ScrollArea::vertical().max_height(height).auto_shrink([false, true]).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        for &(i, depth) in &list {
            if let Some(r) = layer_row(ui, painter, state, typing, i, depth) {
                rects.push((i, r));
            }
        }
    });

    // Dragging a layer by its grip: where it would go, and the drop when it is let go.
    if let Some(id) = state.drag {
        let pointer = ui.ctx().pointer_interact_pos();
        let from = painter.painting.index_of(id);
        let target = pointer.zip(from).and_then(|(at, from)| {
            let block = painter.painting.block(from);
            let (t, r) = rects.iter().find(|(_, r)| r.y_range().contains(at.y))?;
            if block.contains(t) {
                return None;
            }
            let f = (at.y - r.top()) / r.height();
            let place = if painter.painting.layers[*t].group {
                if f < 0.25 { Place::Above } else if f > 0.75 { Place::Below } else { Place::Into }
            } else if f < 0.5 {
                Place::Above
            } else {
                Place::Below
            };
            Some((*t, *r, place))
        });
        if let Some((_, r, place)) = target {
            let p = ui.ctx().layer_painter(egui::LayerId::new(egui::Order::Foreground, egui::Id::new("drop")));
            match place {
                Place::Above => p.hline(r.x_range(), r.top(), stroke(2.0, ACCENT)),
                Place::Below => p.hline(r.x_range(), r.bottom(), stroke(2.0, ACCENT)),
                Place::Into => p.rect_stroke(r.shrink(1.0), 2.0, stroke(2.0, ACCENT)),
            };
        }
        let released = ui.input(|i| !i.pointer.primary_down());
        if released {
            state.drag = None;
            if let (Some(from), Some((t, _, place))) = (from, target) {
                painter.edit_layers(|p| (Some(p.move_to(from, t, place)), Removed::default()));
                if place == Place::Into {
                    state.collapsed.remove(&painter.painting.layers[t.min(painter.painting.layers.len() - 1)].id);
                }
            }
        }
    }

    ui.add_space(4.0);
    // Paint mixing (the canvas's, as the 2D app's row here).
    ui.horizontal(|ui| {
        let (label, _) = ui.allocate_exact_size(vec2(110.0, 32.0), Sense::hover());
        ui.painter().text(label.left_center(), egui::Align2::LEFT_CENTER, "Paint mixing", egui::FontId::proportional(15.0), TEXT_DIM);
        let mix = painter.painting.mix;
        for (name, m) in [("Normal", Mix::Normal), ("Pigment", Mix::Pigment)] {
            if toggle(ui, name, mix == m).clicked() && mix != m {
                painter.set_mix(m);
            }
        }
    });
    // The mask row: paint the layer or its mask; the mask on or off.
    let active = painter.active_index();
    if let Some(enabled) = painter.painting.layers[active].mask.as_ref().map(|m| m.enabled) {
        ui.horizontal(|ui| {
            let (label, _) = ui.allocate_exact_size(vec2(110.0, 32.0), Sense::hover());
            ui.painter().text(label.left_center(), egui::Align2::LEFT_CENTER, "Mask", egui::FontId::proportional(15.0), TEXT_DIM);
            if toggle(ui, "Layer", !painter.mask_target).clicked() {
                painter.mask_target = false;
            }
            if toggle(ui, "Mask", painter.mask_target).clicked() {
                painter.mask_target = true;
            }
            if toggle(ui, "On", enabled).clicked() {
                painter.edit_layers(|p| {
                    if let Some(m) = &mut p.layers[active].mask {
                        m.enabled = !m.enabled;
                    }
                    (Some(active), Removed::default())
                });
            }
        });
    }

    // What the footer button under the pointer does (the 2D app's tooltips), or a message.
    let hint = footer(ui, painter, state);
    let message = state.message.as_ref().filter(|(_, t)| t.elapsed().as_secs_f32() < 3.0).map(|(m, _)| m.clone());
    if let Some(text) = hint.or(message) {
        ui.label(RichText::new(text).color(TEXT_DIM).size(13.0));
    }
}

/// One layer's row. Returns its rect (to drop a dragged layer on).
fn layer_row(ui: &mut egui::Ui, painter: &mut Painter, state: &mut LayersState, typing: &mut Option<Typing>, i: usize, depth: usize) -> Option<Rect> {
    let p = &painter.painting;
    let l = &p.layers[i];
    let (id, group, visible, clip, name, blend, opacity) = (l.id, l.group, l.visible, l.clip && p.can_clip(i), l.name.clone(), l.blend, l.opacity);
    let mask = l.mask.as_ref().map(|m| m.enabled);
    let active = painter.active_layer == id;
    let (rect, row) = ui.allocate_exact_size(vec2(ui.available_width(), ROW), Sense::click());
    let fill = if active { ROW_ACTIVE } else if row.hovered() { ROW_HOVER } else { Color32::TRANSPARENT };
    ui.painter().rect_filled(rect, 0.0, fill);
    ui.painter().hline(rect.x_range(), rect.bottom() - 0.5, stroke(1.0, ROW_LINE));
    if state.drag == Some(id) {
        ui.painter().rect_filled(rect, 0.0, Color32::from_black_alpha(110));
    }
    let mut x = rect.left() + 2.0 + depth as f32 * INDENT;
    let cell = |x: &mut f32, w: f32| -> Rect {
        let r = Rect::from_min_size(pos2(*x, rect.top()), vec2(w, ROW));
        *x += w;
        r
    };
    // The grip: drag to move (into a group: drop on its middle).
    let grip = cell(&mut x, 24.0);
    let grip_r = ui.interact(grip, egui::Id::new(("grip", id)), Sense::drag());
    paint_icon(ui.painter(), "grip", grip, 16.0, TEXT_DIM);
    if grip_r.drag_started() {
        state.drag = Some(id);
    }
    if clip {
        // Clipped to the layer below.
        let r = cell(&mut x, 20.0);
        paint_icon(ui.painter(), "clip", r, 14.0, TEXT_DIM);
    }
    // The eye.
    let eye = cell(&mut x, 34.0);
    let eye_r = ui.interact(eye, egui::Id::new(("eye", id)), Sense::click());
    paint_icon(ui.painter(), if visible { "eye" } else { "eyeoff" }, eye, 18.0, if visible { TEXT } else { TEXT_FAINT });
    if eye_r.clicked() {
        painter.edit_layers(|p| {
            p.layers[i].visible = !p.layers[i].visible;
            (None, Removed::default())
        });
        return Some(rect);
    }
    // A group's chevron, then its folder.
    if group {
        let chev = cell(&mut x, 26.0);
        let open = !state.collapsed.contains(&id);
        let chev_r = ui.interact(chev, egui::Id::new(("chev", id)), Sense::click());
        let c = chev.center();
        let pts: Vec<egui::Pos2> = if open { vec![c + vec2(-5.0, -2.5), c + vec2(0.0, 3.0), c + vec2(5.0, -2.5)] } else { vec![c + vec2(-2.5, -5.0), c + vec2(3.0, 0.0), c + vec2(-2.5, 5.0)] };
        ui.painter().add(egui::Shape::line(pts, stroke(1.6, TEXT)));
        if chev_r.clicked() {
            if open {
                state.collapsed.insert(id);
            } else {
                state.collapsed.remove(&id);
            }
        }
        let f = cell(&mut x, 24.0);
        paint_icon(ui.painter(), "folder", f, 16.0, TEXT_DIM);
    }
    // The tags and the mask chip, from the right.
    let mut right = rect.right() - 6.0;
    let mut tags = Vec::new();
    if opacity < 1.0 {
        tags.push(format!("{:.0}%", opacity * 100.0));
    }
    if blend != Blend::Normal && blend != Blend::Pass {
        tags.push(tag(blend).to_string());
    }
    // On a shared canvas, a VR layer (its strokes in 3D) says so, as the 2D app's badge.
    let vr = painter.shared && !group && !p.layers[i].ordered;
    for (t, color) in tags.into_iter().map(|t| (t, TEXT_DIM)).chain(vr.then(|| ("VR".to_string(), ACCENT))) {
        let galley = ui.painter().layout_no_wrap(t, egui::FontId::proportional(12.0), color);
        let w = galley.size().x + 10.0;
        let r = Rect::from_center_size(pos2(right - w * 0.5, rect.center().y), vec2(w, 20.0));
        ui.painter().rect_filled(r, 3.0, BG_1);
        ui.painter().galley(r.center() - galley.size() * 0.5, galley, color);
        right -= w + 4.0;
    }
    if let Some(enabled) = mask {
        let r = Rect::from_center_size(pos2(right - 16.0, rect.center().y), vec2(28.0, 28.0));
        right -= 34.0;
        let target = active && painter.mask_target;
        if target {
            ui.painter().rect_stroke(r, 3.0, stroke(2.0, ACCENT));
        }
        paint_icon(ui.painter(), "mask", r, 18.0, if enabled { TEXT } else { TEXT_FAINT });
        // The chip: paint this layer's mask.
        if ui.interact(r, egui::Id::new(("mask", id)), Sense::click()).clicked() {
            painter.active_layer = id;
            painter.mask_target = true;
            return Some(rect);
        }
    }
    // The name: bold for a group, faint when hidden; outlined when it is what strokes go to.
    let name_rect = Rect::from_min_max(pos2(x + 4.0, rect.top()), pos2(right, rect.bottom()));
    let color = if !visible { TEXT_FAINT } else { TEXT };
    let font = egui::FontId::proportional(15.0);
    let text = if group { RichText::new(&name).strong() } else { RichText::new(&name) };
    let galley = egui::WidgetText::from(text.color(color)).into_galley(ui, Some(egui::TextWrapMode::Truncate), name_rect.width(), font);
    ui.painter().galley(name_rect.left_center() - vec2(0.0, galley.size().y * 0.5), galley, color);
    if active && !painter.mask_target && !group {
        ui.painter().rect_stroke(name_rect.shrink2(vec2(-3.0, 7.0)), 3.0, stroke(1.0, ACCENT_DIM));
    }
    // A click makes it active (painting the layer, not its mask); a double click on the name
    // renames it.
    if row.double_clicked() && name_rect.contains(row.interact_pointer_pos().unwrap_or(rect.center())) {
        *typing = Some(Typing::new(Target::LayerName(id), &name));
    } else if row.clicked() || row.is_pointer_button_down_on() {
        painter.active_layer = id;
        painter.mask_target = false;
    }
    Some(rect)
}

/// The footer's buttons, left to right as the 2D app's (without adjustment layers and
/// effects), the delete at the right end. Returns what the one under the pointer does.
fn footer(ui: &mut egui::Ui, painter: &mut Painter, state: &mut LayersState) -> Option<String> {
    let i = painter.active_index();
    let p = &painter.painting;
    let (group, has_mask, clip, can_clip) = (p.layers[i].group, p.layers[i].mask.is_some(), p.layers[i].clip, p.can_clip(i));
    let size = vec2(44.0, 40.0);
    let mut hint = String::new();
    let mut note = |r: &egui::Response, text: &str| {
        if r.hovered() {
            hint = text.to_string();
        }
    };
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 3.0;
        let r = icon_button(ui, "plus", size, false, true);
        note(&r, "New layer");
        if r.clicked() {
            painter.edit_layers(|p| (Some(p.add_layer(Some(i))), Removed::default()));
        }
        let r = icon_button(ui, if group { "folder" } else { "group" }, size, false, true);
        note(&r, if group { "Ungroup: take the layers out" } else { "Put the layer in a new group" });
        if r.clicked() {
            painter.edit_layers(|p| {
                if p.layers[i].group {
                    let (a, g) = p.ungroup(i);
                    (a, Removed { layers: g.into_iter().collect(), masks: Vec::new() })
                } else {
                    (Some(p.group_layer(i)), Removed::default())
                }
            });
        }
        let r = icon_button(ui, "mask", size, has_mask, !group);
        note(&r, if has_mask { "Delete the layer mask" } else { "Add a layer mask" });
        if r.clicked() {
            painter.edit_layers(|p| {
                let id = p.layers[i].id;
                match p.layers[i].mask.take() {
                    Some(m) => (Some(i), Removed { layers: Vec::new(), masks: vec![(id, m)] }),
                    None => {
                        p.layers[i].mask = Some(Mask { enabled: true, strokes: Vec::new() });
                        (Some(i), Removed::default())
                    }
                }
            });
            // A new mask is what strokes go to, as in the 2D app.
            painter.mask_target = painter.painting.layers[painter.active_index()].mask.is_some();
        }
        let r = icon_button(ui, "clip", size, clip, can_clip);
        note(&r, if clip { "Release from the clipping mask" } else { "Clip to the layer below (clipping mask)" });
        if r.clicked() {
            painter.edit_layers(|p| {
                p.layers[i].clip = !p.layers[i].clip;
                (Some(i), Removed::default())
            });
        }
        let r = icon_button(ui, "copy", size, false, true);
        note(&r, "Duplicate");
        if r.clicked() {
            painter.edit_layers(|p| (Some(p.duplicate(i)), Removed::default()));
        }
        let r = icon_button(ui, "up", size, false, true);
        note(&r, "Move up");
        if r.clicked() {
            painter.edit_layers(|p| (Some(p.move_layer(i, true)), Removed::default()));
        }
        let r = icon_button(ui, "down", size, false, true);
        note(&r, "Move down");
        if r.clicked() {
            painter.edit_layers(|p| (Some(p.move_layer(i, false)), Removed::default()));
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let r = icon_button(ui, "trash", size, false, true);
            note(&r, if group { "Delete the group and its layers" } else { "Delete layer" });
            if r.clicked() {
                if painter.painting.layers.iter().enumerate().filter(|(k, l)| !l.group && !painter.painting.block(i).contains(k)).count() == 0 {
                    state.message = Some(("A painting needs at least one layer".into(), std::time::Instant::now()));
                } else {
                    painter.edit_layers(|p| match p.delete(i) {
                        Some((a, layers)) => (Some(a), Removed { layers, masks: Vec::new() }),
                        None => (None, Removed::default()),
                    });
                }
            }
        });
    });
    (!hint.is_empty()).then_some(hint)
}
