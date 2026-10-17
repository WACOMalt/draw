//! The tool panel. It floats above the hand that is not painting, turned to face the head;
//! the painting hand points at it and clicks with the trigger, and scrolls a list with its
//! stick.
//!
//! Made with egui and drawn by `vdraw_render::UiRenderer`, as bs-humany's xr-viewer does its
//! panels. Its look and controls follow the 2D app (multiplayer-canvas), its panels gathered as
//! tabs on one panel: the toolbar down the left side (brush, eraser, stroke eraser, the
//! foreground and background colors, the eyedropper); the Tool tab (the options bar: the
//! tool's settings); Color (the color panel and the palettes); Layers (the layers panel); and
//! Settings. Names and hex colors are typed on a keyboard on the panel.

mod color;
pub mod home;
mod keyboard;
mod layers;
pub mod widgets;

pub use widgets::{RECENT, to_linear, to_srgb};

use crate::painter::Painter;
use crate::palettes::Palettes;
use crate::presets::{Preset, Presets};
use crate::tools::Tool;
use egui::{Color32, Pos2, Rect, RichText, Sense, pos2, vec2};
use glam::{Mat4, Vec3, Vec4};
use keyboard::{Done, Target, Typing};
use std::time::Instant;
use vdraw_core::Brush;
use widgets::*;

/// Meters per panel point.
pub const POINT: f32 = 0.0005;
/// The panel's size in points (0.26 x 0.38 m).
pub const SIZE: [f32; 2] = [520.0, 760.0];
/// Texture pixels per point: sharp text at arm's length.
const PIXELS_PER_POINT: f32 = 2.0;
/// How far above the hand the panel's center floats (meters).
const ABOVE_HAND: f32 = 0.2;
/// The toolbar's width, points.
const RAIL: f32 = 58.0;

/// Brush diameter range, meters (the 2D app's 1 to 1000 px, as a log slider).
const DIAMETER: (f32, f32) = (0.001, 0.4);
/// The stroke eraser's diameter range, meters (the 2D app's 2 to 400 px).
const SWEEP: (f32, f32) = (0.002, 0.4);

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
    /// The painting hand's stick, up and down, while it points at the panel: scrolls.
    pub scroll: f32,
}

/// What the panel asks for beyond the painting and the tools.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Recenter,
    /// Write a debug snapshot: both eyes as shown, the view, and the state (debug.rs).
    DebugSnapshot,
    /// Paint on this device alone (vdraw's own painting), from the start screen.
    PaintLocal,
    /// Back to the start screen (leaving the canvas, or this device's painting).
    Leave,
    /// The canvas's password, to try.
    Password(String),
}

/// What the panel shows: the start screen, or the tools for painting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    Home,
    Paint,
}

/// The open canvas, as the Settings tab shows it.
#[derive(Clone, Debug, Default)]
pub struct CanvasInfo {
    pub key: String,
    pub role: String,
    pub state: String,
    pub peers: Vec<(String, String)>,
}

/// One frame of the panel: what to draw, egui's texture changes, and what was asked.
pub struct Frame {
    pub primitives: Vec<egui::ClippedPrimitive>,
    pub textures: egui::TexturesDelta,
    pub actions: Vec<Action>,
}

/// What the panel shows and changes.
pub struct Model<'a> {
    pub painter: &'a mut Painter,
    pub palettes: &'a mut Palettes,
    pub presets: &'a mut Presets,
    pub lobby: &'a mut crate::lobby::Lobby,
    /// The open canvas (None: this device's painting).
    pub canvas: Option<CanvasInfo>,
}

/// The panel's tabs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Tool,
    Color,
    Layers,
    Settings,
}

pub struct Panel {
    ctx: egui::Context,
    started: Instant,
    was_pressed: bool,
    was_on: bool,
    pub tab: Tab,
    color: color::ColorState,
    layers: layers::LayersState,
    typing: Option<Typing>,
    /// The Tool tab's dynamics shown.
    dynamics_open: bool,
    pub screen: Screen,
    home: home::HomeState,
    /// A canvas being opened (the start screen shows how it goes).
    pub opening: Option<home::Opening>,
}

impl Panel {
    pub fn new(brush: &Brush) -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(PIXELS_PER_POINT);
        let mut v = egui::Visuals::dark();
        v.panel_fill = BG_2;
        v.window_fill = BG_2;
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
        // A click is a press that moves under 30 points; a hand pulling a trigger moves more.
        ctx.options_mut(|o| {
            o.input_options.max_click_dist = 30.0;
            o.input_options.max_click_duration = 3.0;
        });
        ctx.style_mut(|s| {
            for font in s.text_styles.values_mut() {
                font.size *= 1.25;
            }
            s.spacing.button_padding = vec2(12.0, 7.0);
            s.spacing.item_spacing = vec2(10.0, 8.0);
            s.spacing.interact_size.y = 30.0;
            s.spacing.scroll = egui::style::ScrollStyle::solid();
            s.interaction.selectable_labels = false;
        });
        Self { ctx, started: Instant::now(), was_pressed: false, was_on: false, tab: Tab::Tool, color: color::ColorState::new(brush.color), layers: layers::LayersState::default(), typing: None, dynamics_open: false, screen: Screen::Home, home: home::HomeState::default(), opening: None }
    }

    /// Opens the Color tab on its palettes.
    pub fn show_palettes(&mut self) {
        self.tab = Tab::Color;
        self.color.page = color::Page::Palettes;
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
                if pointer.scroll.abs() > 0.15 {
                    // The stick scrolls a list as a wheel would, faster the further it is pushed.
                    let speed = (pointer.scroll.abs() - 0.15) / 0.85;
                    events.push(egui::Event::MouseWheel { unit: egui::MouseWheelUnit::Point, delta: vec2(0.0, pointer.scroll.signum() * speed * speed * 18.0), modifiers: Default::default() });
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
        let mut actions = Vec::new();
        let Model { painter, palettes, presets, lobby, canvas } = model;
        let output = self.ctx.clone().run(input, |ctx| {
            let frame = egui::Frame { inner_margin: egui::Margin::same(12.0), rounding: egui::Rounding::same(8.0), fill: BG_2, stroke: stroke(1.0, LINE), ..Default::default() };
            egui::CentralPanel::default().frame(frame).show(ctx, |ui| match self.screen {
                Screen::Home => self.home_screen(ui, painter, palettes, presets, lobby, &mut actions),
                Screen::Paint => self.content(ui, painter, palettes, presets, lobby, canvas.as_ref(), &mut actions),
            });
            // The pointer: a ring where the ray meets the panel.
            if let Some(at) = pointer.at {
                let p = ctx.layer_painter(egui::LayerId::new(egui::Order::Tooltip, egui::Id::new("pointer")));
                p.circle_stroke(at, 6.0, stroke(2.0, Color32::WHITE));
                p.circle_stroke(at, 8.0, stroke(1.5, Color32::from_black_alpha(160)));
            }
        });
        let primitives = self.ctx.tessellate(output.shapes, output.pixels_per_point);
        Frame { primitives, textures: output.textures_delta, actions }
    }

    /// The start screen, with the keyboard below it when it is typing.
    fn home_screen(&mut self, ui: &mut egui::Ui, painter: &mut Painter, palettes: &mut Palettes, presets: &mut Presets, lobby: &mut crate::lobby::Lobby, actions: &mut Vec<Action>) {
        if let Some(typing) = &mut self.typing {
            let done = ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| keyboard::keyboard(ui, typing)).inner;
            match done {
                Some(Done::Commit(target, text)) => {
                    self.typing = None;
                    self.commit(painter, palettes, presets, lobby, actions, &target, &text);
                }
                Some(Done::Cancel) => self.typing = None,
                None => {}
            }
            return;
        }
        home::home(ui, lobby, &mut self.home, self.opening.as_ref(), &mut self.typing, actions);
    }

    fn content(&mut self, ui: &mut egui::Ui, painter: &mut Painter, palettes: &mut Palettes, presets: &mut Presets, lobby: &mut crate::lobby::Lobby, canvas: Option<&CanvasInfo>, actions: &mut Vec<Action>) {
        // The tabs, and undo and redo.
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            let tool = painter.tools.tool.name();
            for (tab, name) in [(Tab::Tool, tool), (Tab::Color, "Color"), (Tab::Layers, "Layers"), (Tab::Settings, "Settings")] {
                let on = self.tab == tab;
                let button = egui::Button::new(RichText::new(name).size(15.5).color(if on { TEXT } else { TEXT_DIM }))
                    .fill(if on { BG_4 } else { BG_2 })
                    .stroke(stroke(1.0, if on { BORDER } else { LINE }))
                    .min_size(vec2(0.0, 36.0));
                if ui.add(button).clicked() {
                    self.tab = tab;
                    self.typing = None;
                }
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                if icon_button(ui, "redo", vec2(38.0, 36.0), false, painter.can_redo()).clicked() {
                    painter.redo();
                }
                if icon_button(ui, "undo", vec2(38.0, 36.0), false, painter.can_undo()).clicked() {
                    painter.undo();
                }
            });
        });
        ui.separator();
        let height = ui.available_height();
        ui.horizontal_top(|ui| {
            // The toolbar, down the left side.
            ui.allocate_ui_with_layout(vec2(RAIL, height), egui::Layout::top_down(egui::Align::Center), |ui| self.rail(ui, painter));
            ui.separator();
            let width = ui.available_width();
            ui.allocate_ui_with_layout(vec2(width, height), egui::Layout::top_down(egui::Align::Min), |ui| {
                ui.set_min_size(vec2(width, height));
                if let Some(typing) = &mut self.typing {
                    // The keyboard takes the bottom; the tab shows above it, smaller.
                    let done = ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| keyboard::keyboard(ui, typing)).inner;
                    match done {
                        Some(Done::Commit(target, text)) => {
                            self.typing = None;
                            self.commit(painter, palettes, presets, lobby, actions, &target, &text);
                        }
                        Some(Done::Cancel) => self.typing = None,
                        None => {}
                    }
                    return;
                }
                match self.tab {
                    Tab::Tool => tool_tab(ui, painter, presets, &mut self.dynamics_open, &mut self.typing),
                    Tab::Color => color::color_tab(ui, painter, palettes, &mut self.color, &mut self.typing),
                    Tab::Layers => layers::layers_tab(ui, painter, &mut self.layers, &mut self.typing),
                    Tab::Settings => settings_tab(ui, canvas, actions),
                }
            });
        });
    }

    /// The keyboard's text, committed.
    #[allow(clippy::too_many_arguments)]
    fn commit(&mut self, painter: &mut Painter, palettes: &mut Palettes, presets: &mut Presets, lobby: &mut crate::lobby::Lobby, actions: &mut Vec<Action>, target: &Target, text: &str) {
        match target {
            Target::Join => {
                self.home.join = text.trim().to_string();
                if !self.home.join.is_empty() {
                    lobby.join(self.home.join.clone());
                }
            }
            Target::CanvasName => self.home.name = text.trim().to_string(),
            Target::UserName => lobby.set_name(text),
            Target::Password => actions.push(Action::Password(text.to_string())),
            Target::PresetName => {
                let name: String = text.trim().chars().take(40).collect();
                if let (false, Some((brush, angle))) = (name.is_empty(), painter.tools.current()) {
                    let eraser = brush.erase;
                    presets.list.push(Preset { name, eraser, brush: *brush, angle: *angle });
                    presets.save();
                }
            }
            Target::LayerName(id) => {
                let name: String = text.trim().chars().take(64).collect();
                if let (false, Some(i)) = (name.is_empty(), painter.painting.index_of(*id)) {
                    painter.edit_layers(|p| {
                        p.layers[i].name = name;
                        (None, crate::painter::Removed::default())
                    });
                }
            }
            _ => color::commit(painter, palettes, &mut self.color, target, text),
        }
    }

    /// The toolbar, as the 2D app's: brush, eraser, stroke eraser; the foreground and
    /// background colors (a press on the background swaps them; swap, and black on white);
    /// the eyedropper.
    fn rail(&mut self, ui: &mut egui::Ui, painter: &mut Painter) {
        ui.spacing_mut().item_spacing.y = 4.0;
        let size = vec2(52.0, 46.0);
        for (tool, icon) in [(Tool::Brush, "brush"), (Tool::Eraser, "eraser"), (Tool::StrokeEraser, "strokeEraser")] {
            if icon_button(ui, icon, size, painter.tools.tool == tool, true).clicked() {
                painter.tools.tool = tool;
            }
        }
        ui.add_space(6.0);
        // The colors: the foreground over the background.
        let (rect, _) = ui.allocate_exact_size(vec2(52.0, 52.0), Sense::hover());
        let fg = Rect::from_min_size(rect.min + vec2(4.0, 4.0), vec2(30.0, 30.0));
        let bg = Rect::from_min_size(rect.min + vec2(18.0, 18.0), vec2(30.0, 30.0));
        let rgb = |c: [f32; 3]| {
            let b = to_srgb(c).map(|c| (c * 255.0).round() as u8);
            Color32::from_rgb(b[0], b[1], b[2])
        };
        let bg_r = ui.interact(bg, egui::Id::new("bg color"), Sense::click());
        ui.painter().rect(bg, 3.0, rgb(painter.tools.bg), stroke(1.0, BORDER));
        ui.painter().rect(fg, 3.0, rgb(painter.tools.brush.color), stroke(1.5, if bg_r.hovered() { TEXT_DIM } else { TEXT }));
        let fg_r = ui.interact(fg, egui::Id::new("fg color"), Sense::click());
        if bg_r.clicked() && !fg_r.clicked() {
            painter.tools.swap_colors();
        }
        if fg_r.clicked() {
            // The foreground's color: the Color tab.
            self.tab = Tab::Color;
        }
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 2.0;
            if icon_button(ui, "swap", vec2(25.0, 26.0), false, true).clicked() {
                painter.tools.swap_colors();
            }
            let (r, response) = ui.allocate_exact_size(vec2(25.0, 26.0), Sense::click());
            if response.hovered() {
                ui.painter().rect_filled(r, 3.0, BG_3);
            }
            ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, "D", egui::FontId::proportional(14.0), TEXT);
            if response.clicked() {
                painter.tools.default_colors();
            }
        });
        ui.add_space(6.0);
        if icon_button(ui, "eyedropper", size, painter.tools.tool == Tool::Eyedropper, true).clicked() {
            painter.tools.tool = Tool::Eyedropper;
        }
        ui.add_space(6.0);
        if icon_button(ui, "transform", size, painter.tools.tool == Tool::Transform, true).clicked() {
            painter.tools.tool = Tool::Transform;
        }
    }
}

/// The Tool tab: the tool's settings (the 2D app's options bar), and the brush presets.
fn tool_tab(ui: &mut egui::Ui, painter: &mut Painter, presets: &mut Presets, dynamics_open: &mut bool, typing: &mut Option<Typing>) {
    let height = ui.available_height();
    egui::ScrollArea::vertical().max_height(height).auto_shrink([false, false]).show(ui, |ui| {
        let tools = &mut painter.tools;
        match tools.tool {
            Tool::Brush | Tool::Eraser => {
                let mut smoothing = tools.smoothing;
                let (brush, angle) = tools.current().unwrap();
                brush_settings(ui, brush, angle, &mut smoothing, dynamics_open);
                painter.tools.smoothing = smoothing;
                presets_section(ui, painter, presets, typing);
            }
            Tool::StrokeEraser => {
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
            Tool::Eyedropper => {
                ui.label(RichText::new("Point at the painting and pull the trigger to pick its color there, from all layers.").color(TEXT_DIM).size(14.0));
            }
            Tool::Transform => {
                ui.label(RichText::new("Hold the trigger to take the active layer (a group: all its layers) in your hand: it moves and turns with it; the stick scales it about your hand. Undo puts it back.").color(TEXT_DIM).size(14.0));
            }
        }
    });
}

/// The brush's or the eraser's settings, as the 2D app's options bar: size (logarithmic),
/// opacity, flow (logarithmic), hardness, spacing (logarithmic), smoothing; pressure to size
/// and to flow, airbrush; and the dynamics (the tip's angle and roundness, the jitters).
fn brush_settings(ui: &mut egui::Ui, brush: &mut Brush, angle: &mut f32, smoothing: &mut f32, dynamics_open: &mut bool) {
    let mut diameter = brush.radius * 2.0;
    if slider(ui, "Size", &mut diameter, DIAMETER, true, length) {
        brush.radius = diameter * 0.5;
    }
    slider(ui, "Opacity", &mut brush.opacity, (0.01, 1.0), false, percent);
    slider(ui, "Flow", &mut brush.flow, (0.005, 1.0), true, percent);
    slider(ui, "Hardness", &mut brush.hardness, (0.0, 1.0), false, percent);
    slider(ui, "Spacing", &mut brush.spacing, (0.01, 2.0), true, percent);
    slider(ui, "Smoothing", smoothing, (0.0, 0.95), false, percent);
    ui.horizontal(|ui| {
        ui.add_space(94.0);
        if toggle(ui, "P·size", brush.pressure_size).clicked() {
            brush.pressure_size = !brush.pressure_size;
        }
        if toggle(ui, "P·flow", brush.pressure_flow).clicked() {
            brush.pressure_flow = !brush.pressure_flow;
        }
        if toggle(ui, "Airbrush", brush.buildup).clicked() {
            brush.buildup = !brush.buildup;
        }
    });
    // The dynamics, shown "on" when any is not its default (as the 2D app's button).
    let on = brush.roundness < 1.0 || *angle != 0.0 || brush.jitters();
    ui.horizontal(|ui| {
        ui.add_space(94.0);
        if toggle(ui, if *dynamics_open { "Dynamics: hide" } else { "Dynamics" }, on || *dynamics_open).clicked() {
            *dynamics_open = !*dynamics_open;
        }
    });
    if *dynamics_open {
        slider(ui, "Angle", angle, (0.0, 360.0), false, |a| format!("{a:.0}°"));
        slider(ui, "Roundness", &mut brush.roundness, (0.05, 1.0), false, percent);
        slider(ui, "Size jit.", &mut brush.size_jitter, (0.0, 1.0), false, percent);
        slider(ui, "Angle jit.", &mut brush.angle_jitter, (0.0, 1.0), false, percent);
        slider(ui, "Scatter", &mut brush.scatter, (0.0, 4.0), false, percent);
        slider(ui, "Flow jit.", &mut brush.flow_jitter, (0.0, 1.0), false, percent);
    }
}

/// Brush presets: save the current brush (or eraser) under a name; press one to use it (its
/// tool too); the cross deletes it.
fn presets_section(ui: &mut egui::Ui, painter: &mut Painter, presets: &mut Presets, typing: &mut Option<Typing>) {
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        section(ui, "PRESETS");
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button("Save current").clicked() {
                *typing = Some(Typing::new(Target::PresetName, ""));
            }
        });
    });
    if presets.list.is_empty() {
        ui.label(RichText::new("None yet.").color(TEXT_FAINT).size(13.0));
    }
    let color = painter.tools.brush.color;
    let mut apply = None;
    let mut delete = None;
    for (k, p) in presets.list.iter().enumerate() {
        let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 46.0), Sense::click());
        if response.hovered() {
            ui.painter().rect_filled(rect, 4.0, ROW_HOVER);
        }
        // A squiggle drawn with the brush: its width by a pressure swell, its paint by opacity
        // and flow, its edge by hardness.
        let thumb = Rect::from_min_size(rect.min + vec2(4.0, 4.0), vec2(120.0, 38.0));
        ui.painter().rect_filled(thumb, 3.0, BG_1);
        let c = if p.eraser { [0.85; 3] } else { color };
        let b = to_srgb(c).map(|c| (c * 255.0).round() as u8);
        let alpha = (p.brush.opacity * (0.3 + 0.7 * p.brush.flow)).clamp(0.05, 1.0);
        let size = (p.brush.radius * 2.0 / DIAMETER.1).sqrt().clamp(0.08, 1.0) * 14.0;
        for i in 0..40 {
            let t = i as f32 / 39.0;
            let pressure = if p.brush.pressure_size { (t * std::f32::consts::PI).sin().max(0.15) } else { 1.0 };
            let at = pos2(thumb.left() + 10.0 + t * (thumb.width() - 20.0), thumb.center().y + (t * std::f32::consts::TAU).sin() * 8.0);
            let r = (size * pressure).max(1.0);
            let hard = p.brush.hardness;
            ui.painter().circle_filled(at, r, Color32::from_rgba_unmultiplied(b[0], b[1], b[2], (alpha * 255.0 * (0.25 + 0.75 * hard)) as u8 / 2));
            ui.painter().circle_filled(at, r * (0.4 + 0.6 * hard), Color32::from_rgba_unmultiplied(b[0], b[1], b[2], (alpha * 255.0) as u8 / 3));
        }
        ui.painter().text(pos2(thumb.right() + 10.0, rect.center().y), egui::Align2::LEFT_CENTER, format!("{}{}", p.name, if p.eraser { " (eraser)" } else { "" }), egui::FontId::proportional(15.0), TEXT);
        let cross = Rect::from_center_size(pos2(rect.right() - 18.0, rect.center().y), vec2(30.0, 30.0));
        let cross_r = ui.interact(cross, egui::Id::new(("preset delete", k)), Sense::click());
        paint_icon(ui.painter(), "close", cross, 14.0, if cross_r.hovered() { TEXT } else { TEXT_FAINT });
        if cross_r.clicked() {
            delete = Some(k);
        } else if response.clicked() {
            apply = Some(k);
        }
    }
    if let Some(k) = apply {
        // The 2D app's apply: the eraser's settings when it is for the eraser, else the
        // brush's (and the brush comes up); the color stays.
        let p = presets.list[k].clone();
        let tools = &mut painter.tools;
        if p.eraser {
            tools.eraser = Brush { erase: true, ..p.brush };
            tools.angle[1] = p.angle;
            tools.tool = Tool::Eraser;
        } else {
            tools.brush = Brush { color: tools.brush.color, erase: false, ..p.brush };
            tools.angle[0] = p.angle;
            tools.tool = Tool::Brush;
        }
    }
    if let Some(k) = delete {
        presets.list.remove(k);
        presets.save();
    }
}

/// The Settings tab: moving back to the start, the debug snapshot, and the controls.
fn settings_tab(ui: &mut egui::Ui, canvas: Option<&CanvasInfo>, actions: &mut Vec<Action>) {
    match canvas {
        Some(c) => {
            section(ui, "CANVAS");
            ui.horizontal(|ui| {
                ui.label(RichText::new(&c.key).monospace().size(16.0));
                ui.label(RichText::new(format!("{} · {}", c.role, c.state)).size(13.0).color(TEXT_DIM));
            });
            for (name, color) in &c.peers {
                ui.horizontal(|ui| {
                    let rgb = vdraw_core::doc::hex_rgb(color).map(|v| (v * 255.0).round() as u8);
                    let (r, _) = ui.allocate_exact_size(vec2(12.0, 12.0), Sense::hover());
                    ui.painter().circle_filled(r.center(), 5.0, Color32::from_rgb(rgb[0], rgb[1], rgb[2]));
                    ui.label(RichText::new(name).size(14.0));
                });
            }
            if ui.button("Leave canvas").clicked() {
                actions.push(Action::Leave);
            }
        }
        None => {
            if ui.button("Start screen").clicked() {
                actions.push(Action::Leave);
            }
        }
    }
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        if ui.button("Recenter").clicked() {
            actions.push(Action::Recenter);
        }
        if ui.button("Debug snapshot").clicked() {
            actions.push(Action::DebugSnapshot);
        }
    });
    ui.add_space(8.0);
    section(ui, "CONTROLS");
    for line in [
        "Trigger: use the tool (the pull is the pressure)",
        "Point at the panel: the trigger clicks, the stick scrolls",
        "Move layer: hold the trigger; the stick scales the layer",
        "Eyedropper: point and hold the trigger",
        "B / A: undo / redo",
        "Left stick: fly where you look",
        "Right stick: turn (left, right), rise and sink",
        "Panel hand's stick click: hide or show the panel",
        "Roll the wrist: a flat tip turns with it",
        "Grips: hold the canvas; with both hands, turn and zoom it",
    ] {
        ui.label(RichText::new(line).color(TEXT_DIM).size(14.0));
    }
}

/// A length in millimeters or centimeters.
fn length(d: f32) -> String {
    if d < 0.01 { format!("{:.1} mm", d * 1000.0) } else { format!("{:.1} cm", d * 100.0) }
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
        let brush = svg_polylines(icon_path("brush"));
        assert_eq!(brush.len(), 2);
        assert_eq!(brush[0].0, vec![pos2(14.5, 1.5), pos2(7.5, 9.5)]);
        assert!(brush[1].1 && brush[1].0.len() > 20);
        // The eraser: its base, its body (with two round corners, closed), and the band.
        let eraser = svg_polylines(icon_path("eraser"));
        assert_eq!(eraser.iter().map(|l| l.1).collect::<Vec<_>>(), vec![false, true, false]);
        // A round corner stays on its circle: from (9.5, 3.5) over to (11.5, 3.5), bulging up.
        let body = &eraser[1].0;
        assert!(body.iter().any(|p| p.y < 3.3 && (p.x - 10.5).abs() < 0.3), "{body:?}");
        // The stroke eraser: a squiggle and two strokes of an X; all inside the 16x16 box.
        let se = svg_polylines(icon_path("strokeEraser"));
        assert_eq!(se.len(), 3);
        assert!(se.iter().flat_map(|l| &l.0).all(|p| (0.0..=16.0).contains(&p.x) && (0.0..=16.0).contains(&p.y)));
    }

    #[test]
    fn a_ray_hits_the_panel_where_it_points() {
        let y = 1.0 + ABOVE_HAND;
        let p = Placement::above_hand(Vec3::new(0.0, 1.0, -0.4), Vec3::new(0.0, y, 0.0));
        // Straight at the center from the head.
        let center = p.to_stage(pos2(SIZE[0] * 0.5, SIZE[1] * 0.5));
        assert!(center.abs_diff_eq(Vec3::new(0.0, y, -0.4), 1e-5));
        let (t, at) = p.hit(Vec3::new(0.0, y, 0.0), Vec3::NEG_Z).unwrap();
        assert!((t - 0.4).abs() < 1e-5 && (at - pos2(SIZE[0] * 0.5, SIZE[1] * 0.5)).length() < 1e-3, "{t} {at:?}");
        // A little right and up: the point moves right and up on the panel.
        let (_, at) = p.hit(Vec3::new(0.02, y + 0.01, 0.0), Vec3::NEG_Z).unwrap();
        assert!(at.x > SIZE[0] * 0.5 && at.y < SIZE[1] * 0.5, "{at:?}");
        // Off the side: no hit, but the projection holds to the edge.
        assert!(p.hit(Vec3::new(0.5, y, 0.0), Vec3::NEG_Z).is_none());
        assert_eq!(p.project(Vec3::new(0.5, y, 0.0), Vec3::NEG_Z).unwrap().x, SIZE[0]);
        // The model matrix puts point (0, 0) at the corner.
        assert!(p.model().transform_point3(Vec3::ZERO).abs_diff_eq(p.origin, 1e-6));
    }
}
