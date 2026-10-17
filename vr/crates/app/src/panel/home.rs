//! The start screen, as the 2D app's landing page (Landing.svelte, NewCanvasForm.svelte,
//! AccountButton.svelte): the account, a new canvas (temporary, or named and private or
//! public when signed in), painting on this device alone (vdraw's own painting), a .bdraw
//! file, joining by a code, name or link, and the lists of canvases. Also what shows while a
//! canvas opens: connecting, its password, or why it was turned away.

use super::keyboard::{Target, Typing};
use super::widgets::*;
use super::Action;
use crate::lobby::Lobby;
use egui::{Color32, RichText, Sense, vec2};
use vdraw_net::identity::PEER_COLORS;

/// A canvas being opened, as the start screen shows it.
#[derive(Clone, Debug, PartialEq)]
pub enum Opening {
    Connecting(String),
    Password { key: String, wrong: bool },
    Denied { key: String, reason: String },
}

/// The start screen's own state: the join box's text, a new canvas's name, the files shown.
#[derive(Default)]
pub struct HomeState {
    pub join: String,
    pub name: String,
    pub files_open: bool,
}

fn ago(seconds: f64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
    let s = now - seconds;
    if s < 60.0 {
        "just now".into()
    } else if s < 3600.0 {
        format!("{} min ago", (s / 60.0) as u64)
    } else if s < 86400.0 {
        format!("{} h ago", (s / 3600.0) as u64)
    } else {
        format!("{} d ago", (s / 86400.0) as u64)
    }
}

/// A heading between parts ("or join one").
fn or(ui: &mut egui::Ui, text: &str) {
    ui.add_space(6.0);
    ui.horizontal(|ui| {
        let w = (ui.available_width() - text.len() as f32 * 7.5 - 20.0).max(0.0) * 0.5;
        let line = |ui: &mut egui::Ui| {
            let (r, _) = ui.allocate_exact_size(vec2(w, 12.0), Sense::hover());
            ui.painter().hline(r.x_range(), r.center().y, stroke(1.0, LINE));
        };
        line(ui);
        ui.label(RichText::new(text).size(13.0).color(TEXT_FAINT));
        line(ui);
    });
    ui.add_space(2.0);
}

fn primary(ui: &mut egui::Ui, text: &str, width: f32, enabled: bool) -> bool {
    let b = egui::Button::new(RichText::new(text).size(15.5).color(Color32::WHITE)).fill(ACCENT_DIM).stroke(stroke(1.0, BORDER)).min_size(vec2(width, 40.0));
    ui.add_enabled(enabled, b).clicked()
}

fn plain(ui: &mut egui::Ui, text: &str, width: f32, enabled: bool) -> bool {
    let b = egui::Button::new(RichText::new(text).size(15.0)).min_size(vec2(width, 38.0));
    ui.add_enabled(enabled, b).clicked()
}

fn hint(ui: &mut egui::Ui, text: &str) {
    ui.label(RichText::new(text).size(12.5).color(TEXT_DIM));
}

/// A box with text that opens the keyboard.
fn text_box(ui: &mut egui::Ui, text: &str, placeholder: &str, width: f32) -> bool {
    let (rect, response) = ui.allocate_exact_size(vec2(width, 38.0), Sense::click());
    ui.painter().rect(rect, 4.0, BG_1, stroke(1.0, if response.hovered() { ACCENT_DIM } else { LINE }));
    let (t, c) = if text.is_empty() { (placeholder, TEXT_FAINT) } else { (text, TEXT) };
    ui.painter().text(rect.left_center() + vec2(10.0, 0.0), egui::Align2::LEFT_CENTER, t, egui::FontId::proportional(15.0), c);
    response.clicked()
}

/// A canvas in a list: its key (a button), and a note to the right; maybe a button to forget it.
fn row(ui: &mut egui::Ui, key: &str, note: &str, forget: bool) -> (bool, bool) {
    let mut out = (false, false);
    ui.horizontal(|ui| {
        let open = egui::Button::new(RichText::new(key).monospace().size(15.0).color(ACCENT)).frame(false);
        out.0 = ui.add(open).clicked();
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if forget {
                out.1 = ui.add(egui::Button::new(RichText::new("x").size(14.0).color(TEXT_DIM)).frame(false)).clicked();
            }
            ui.label(RichText::new(note).size(13.0).color(TEXT_DIM));
        });
    });
    out
}

/// The start screen. `opening`: a canvas being opened (shown instead of the rest).
pub fn home(ui: &mut egui::Ui, lobby: &mut Lobby, state: &mut HomeState, opening: Option<&Opening>, typing: &mut Option<Typing>, actions: &mut Vec<Action>) {
    let width = ui.available_width();
    // The account, top right; the title.
    ui.horizontal(|ui| {
        let (r, _) = ui.allocate_exact_size(vec2(16.0, 16.0), Sense::hover());
        ui.painter().circle_filled(r.center(), 8.0, ACCENT);
        ui.label(RichText::new("Draw").size(26.0).strong());
        let user = lobby.user.as_ref().map(|u| u.name.clone());
        let signing_in = lobby.sign_in.is_some();
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| match (user, signing_in) {
            (Some(name), _) => {
                if ui.button(RichText::new("Log out").size(13.5)).clicked() {
                    lobby.sign_out();
                }
                ui.label(RichText::new(name).size(14.0));
            }
            (None, false) => {
                if ui.add_enabled(lobby.busy.is_none(), egui::Button::new(RichText::new("Log in").size(14.0))).clicked() {
                    lobby.start_sign_in();
                }
            }
            (None, true) => {}
        });
    });
    hint(ui, "An infinite canvas you share with a link.");
    ui.add_space(8.0);

    if let Some(o) = opening {
        opening_screen(ui, o, typing, actions, width);
        return;
    }
    if let Some((url, code)) = lobby.sign_in.as_ref().map(|si| (si.start.url.clone(), si.start.code.clone())) {
        egui::Frame { inner_margin: egui::Margin::same(12.0), rounding: egui::Rounding::same(6.0), fill: BG_1, stroke: stroke(1.0, LINE), ..Default::default() }.show(ui, |ui| {
            ui.label(RichText::new("Log in from a browser").size(16.0).strong());
            hint(ui, "Open this address where you are logged in, and enter the code:");
            ui.label(RichText::new(url).monospace().size(14.0).color(ACCENT));
            ui.label(RichText::new(code).monospace().size(30.0).strong());
            if ui.button("Cancel").clicked() {
                lobby.sign_in = None;
            }
        });
        ui.add_space(8.0);
    }

    let height = ui.available_height();
    egui::ScrollArea::vertical().max_height(height - 34.0).auto_shrink([false, false]).show(ui, |ui| {
        let busy = lobby.busy.is_some();
        if lobby.user.is_some() {
            // A named canvas, private or public.
            if text_box(ui, &state.name, "Random code", width - 12.0) {
                *typing = Some(Typing::new(Target::CanvasName, &state.name));
            }
            hint(ui, if state.name.trim().is_empty() { "Empty: a random code like K7QX-2MPD." } else { "Use 3 to 40 letters, digits or dashes." });
            ui.horizontal(|ui| {
                let w = (width - 22.0) * 0.5;
                let name = Some(state.name.trim().to_string()).filter(|n| !n.is_empty());
                if primary(ui, "Create private canvas", w, !busy) {
                    lobby.create(name.clone(), false);
                }
                if primary(ui, "Create public canvas", w, !busy) {
                    lobby.create(name, true);
                }
            });
            hint(ui, "Private: only you and people you add or send a link. Public: anyone with the link can draw.");
        } else {
            if primary(ui, "New canvas", width - 12.0, !busy) {
                lobby.create(None, false);
            }
            hint(ui, "Temporary: deleted after 5 days unless you log in and keep it. Named and private canvases need an account.");
        }
        ui.add_space(4.0);
        if plain(ui, "Paint on this device", width - 12.0, true) {
            actions.push(Action::PaintLocal);
        }
        hint(ui, "vdraw's own painting, saved here. Works without a connection; not shared.");
        ui.add_space(4.0);
        if plain(ui, if state.files_open { "Open a .bdraw file  (close)" } else { "Open a .bdraw file" }, width - 12.0, !busy) {
            state.files_open = !state.files_open;
            if state.files_open {
                lobby.refresh();
            }
        }
        if state.files_open {
            if lobby.files.is_empty() {
                hint(ui, "No .bdraw files in Downloads, Desktop or Documents.");
            }
            let mut chosen = None;
            for f in &lobby.files {
                let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if ui.add(egui::Button::new(RichText::new(name).size(14.0).color(ACCENT)).frame(false)).clicked() {
                    chosen = Some(f.clone());
                }
            }
            if let Some(f) = chosen {
                state.files_open = false;
                lobby.import(f);
            }
        }

        or(ui, "or join one");
        ui.horizontal(|ui| {
            if text_box(ui, &state.join, "Code, name or link", width - 180.0) {
                *typing = Some(Typing::new(Target::Join, &state.join));
            }
            // What is copied on the PC (a code, or a link from the 2D app).
            if plain(ui, "Paste", 72.0, true) {
                if let Some(t) = super::keyboard::clipboard() {
                    state.join = t.chars().take(300).collect();
                }
            }
            if primary(ui, "Join", 76.0, !busy && !state.join.trim().is_empty()) {
                lobby.join(state.join.trim().to_string());
            }
        });
        if let Some(b) = lobby.busy {
            hint(ui, &format!("{b}..."));
        }
        if let Some(e) = &lobby.error {
            ui.label(RichText::new(e).size(13.0).color(Color32::from_rgb(0xff, 0x6b, 0x6b)));
        }

        let mut open = None;
        if !lobby.canvases.owned.is_empty() {
            or(ui, "your canvases");
            for c in &lobby.canvases.owned {
                let note = c.last_active_at.map_or(String::new(), |t| ago(t / 1000.0));
                if row(ui, &c.key, &note, false).0 {
                    open = Some(c.key.clone());
                }
            }
        }
        if !lobby.canvases.shared.is_empty() {
            or(ui, "shared with you");
            for c in &lobby.canvases.shared {
                let owner = c.owner.as_ref().and_then(|o| o.as_str()).unwrap_or("");
                let note = format!("{} · {owner}", if c.role == "viewer" { "view" } else { "edit" });
                if row(ui, &c.key, &note, false).0 {
                    open = Some(c.key.clone());
                }
            }
        }
        let server = lobby.identity.server.clone();
        let recent: Vec<_> = lobby.identity.recent.iter().filter(|r| r.server == server).cloned().collect();
        if !recent.is_empty() {
            or(ui, "recent on this device");
            for r in &recent {
                let (o, forget) = row(ui, &r.key, &ago(r.at), true);
                if o {
                    open = Some(r.key.clone());
                }
                if forget {
                    lobby.identity.recent.retain(|x| !(x.key == r.key && x.server == server));
                    lobby.identity.save();
                }
            }
        }
        if let Some(key) = open {
            lobby.open(&key);
        }
    });

    // Who you are to others: your name (the keyboard) and color.
    ui.horizontal(|ui| {
        ui.label(RichText::new("You appear as").size(13.0).color(TEXT_DIM));
        for c in PEER_COLORS {
            let rgb = vdraw_core::doc::hex_rgb(c).map(|v| (v * 255.0).round() as u8);
            let (r, response) = ui.allocate_exact_size(vec2(15.0, 15.0), Sense::click());
            let on = lobby.identity.color == c;
            ui.painter().circle(r.center(), if on { 7.5 } else { 5.5 }, Color32::from_rgb(rgb[0], rgb[1], rgb[2]), stroke(if on { 1.5 } else { 0.0 }, Color32::WHITE));
            if response.clicked() {
                lobby.set_color(c);
            }
        }
        let name = lobby.identity.name.clone();
        if ui.add(egui::Button::new(RichText::new(name.as_str()).size(14.0)).frame(false)).clicked() {
            *typing = Some(Typing::new(Target::UserName, &name));
        }
    });
}

/// A canvas opening: connecting, asking for its password, or turned away.
fn opening_screen(ui: &mut egui::Ui, o: &Opening, typing: &mut Option<Typing>, actions: &mut Vec<Action>, width: f32) {
    match o {
        Opening::Connecting(key) => {
            ui.label(RichText::new(format!("Opening {key}...")).size(17.0));
        }
        Opening::Password { key, wrong } => {
            ui.label(RichText::new(format!("{key} needs a password")).size(17.0));
            if *wrong {
                ui.label(RichText::new("That was not it.").size(13.0).color(Color32::from_rgb(0xff, 0x6b, 0x6b)));
            }
            if primary(ui, "Enter the password", width - 12.0, true) {
                *typing = Some(Typing::new(Target::Password, ""));
            }
        }
        Opening::Denied { key, reason } => {
            let why = match reason.as_str() {
                "no_access" => "You do not have access to this canvas.",
                "login_required" => "Log in to open this canvas.",
                "expired" => "This temporary canvas expired.",
                "deleted" | "not_found" => "This canvas is gone.",
                "unreadable" => "This canvas could not be read here.",
                _ => reason.as_str(),
            };
            ui.label(RichText::new(key).monospace().size(17.0));
            ui.label(RichText::new(why).size(15.0));
        }
    }
    ui.add_space(10.0);
    if plain(ui, "Back", 120.0, true) {
        actions.push(Action::Leave);
    }
}
