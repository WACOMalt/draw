//! Where the player is: the play area (the OpenXR stage) placed in the painting. Moved and
//! turned about the vertical only, never tilted or scaled, so the floor stays level.

use glam::{Mat4, Quat, Vec3};

/// A painting point = `rig.point(stage point)`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rig {
    pub pos: Vec3,
    pub yaw: f32,
}

impl Rig {
    pub fn mat(&self) -> Mat4 {
        Mat4::from_translation(self.pos) * Mat4::from_rotation_y(self.yaw)
    }

    fn rot(&self) -> Quat {
        Quat::from_rotation_y(self.yaw)
    }

    /// A stage point in the painting.
    pub fn point(&self, p: Vec3) -> Vec3 {
        self.pos + self.rot() * p
    }

    /// A stage direction in the painting.
    pub fn dir(&self, v: Vec3) -> Vec3 {
        self.rot() * v
    }

    /// Turns by `angle` (radians, counterclockwise from above) about the vertical through
    /// `pivot`, a painting point (the head) that stays where it is.
    pub fn turn(&mut self, angle: f32, pivot: Vec3) {
        self.pos = pivot + Quat::from_rotation_y(angle) * (self.pos - pivot);
        self.yaw += angle;
    }

    /// Moves so that the stage point `hand` is at the painting point `held`: the hand holds
    /// on to the painting while the player drags.
    pub fn hold(&mut self, held: Vec3, hand: Vec3) {
        self.pos = held - self.rot() * hand;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_keeps_the_pivot() {
        let mut rig = Rig { pos: Vec3::new(1.0, 0.5, -2.0), yaw: 0.3 };
        let head = Vec3::new(0.2, 1.7, 0.1);
        let before = rig.point(head);
        rig.turn(0.5, before);
        assert!(rig.point(head).abs_diff_eq(before, 1e-5));
        assert!(rig.mat().transform_point3(head).abs_diff_eq(before, 1e-5));
    }

    #[test]
    fn hold_keeps_the_held_point_at_the_hand() {
        let mut rig = Rig { pos: Vec3::new(0.0, 0.0, 1.0), yaw: -1.0 };
        let held = rig.point(Vec3::new(0.3, 1.2, -0.4));
        let hand = Vec3::new(-0.2, 0.8, 0.0);
        rig.hold(held, hand);
        assert!(rig.point(hand).abs_diff_eq(held, 1e-5));
    }
}
