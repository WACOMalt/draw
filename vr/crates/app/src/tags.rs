//! Name tags over other VR users' heads: each name laid out by egui (as the panel's text), and
//! placed in the room facing the viewer, as big to the eye at any distance (as the 2D app's
//! cursor names are on the screen).

use egui::{Color32, Pos2, Rect, epaint::ClippedShape, vec2};
use glam::{Mat4, Vec3, Vec4};
use std::time::Instant;

/// A tag's height as a part of its distance (about 2 degrees).
const ANGULAR: f32 = 0.035;
/// Text size, points; the tag's padding.
const FONT: f32 = 26.0;
const PAD: f32 = 8.0;

pub struct Tags {
    ctx: egui::Context,
    started: Instant,
}

/// One tag, ready to draw: its shapes (egui's), and where its points go in the room.
pub struct Tag {
    pub primitives: Vec<egui::ClippedPrimitive>,
    pub model: Mat4,
}

impl Tags {
    pub fn new() -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(2.0);
        Self { ctx, started: Instant::now() }
    }

    /// The tags (name, linear color, where its bottom middle goes in the room) as seen from
    /// `eye` (the head, in the room). Returns egui's texture changes, and the tags.
    pub fn run(&mut self, tags: &[(String, [f32; 3], Vec3)], eye: Vec3) -> (egui::TexturesDelta, Vec<Tag>) {
        let input = egui::RawInput { screen_rect: Some(Rect::from_min_size(Pos2::ZERO, vec2(1024.0, 1024.0))), time: Some(self.started.elapsed().as_secs_f64()), ..Default::default() };
        let mut laid = Vec::new();
        let output = self.ctx.clone().run(input, |ctx| {
            for (name, color, _) in tags {
                let c = crate::panel::to_srgb(*color).map(|v| (v * 255.0).round() as u8);
                let galley = ctx.fonts(|f| f.layout_no_wrap(name.clone(), egui::FontId::proportional(FONT), Color32::WHITE));
                let size = galley.size() + vec2(2.0 * PAD, PAD);
                let rect = Rect::from_min_size(Pos2::ZERO, size);
                let shapes = vec![
                    egui::Shape::rect_filled(rect, 6.0, Color32::from_black_alpha(150)),
                    egui::Shape::rect_stroke(rect, 6.0, egui::Stroke::new(2.0_f32, Color32::from_rgb(c[0], c[1], c[2]))),
                    egui::Shape::galley(Pos2::new(PAD, PAD * 0.5), galley, Color32::WHITE),
                ];
                laid.push((shapes, size));
            }
        });
        let ppp = output.pixels_per_point;
        let out = laid
            .into_iter()
            .zip(tags)
            .map(|((shapes, size), (_, _, at))| {
                let primitives = self.ctx.tessellate(shapes.into_iter().map(|shape| ClippedShape { clip_rect: Rect::EVERYTHING, shape }).collect(), ppp);
                // Facing the eye, upright; its bottom middle at `at`.
                let normal = (eye - *at).try_normalize().unwrap_or(Vec3::Z);
                let right = Vec3::Y.cross(normal).try_normalize().unwrap_or(Vec3::X);
                let down = right.cross(normal);
                let meters = (eye - *at).length() * ANGULAR / size.y; // per point
                let origin = *at - right * (size.x * 0.5 * meters) - down * (size.y * meters);
                let model = Mat4::from_cols((right * meters).extend(0.0), (down * meters).extend(0.0), normal.extend(0.0), Vec4::new(origin.x, origin.y, origin.z, 1.0));
                Tag { primitives, model }
            })
            .collect();
        (output.textures_delta, out)
    }
}
