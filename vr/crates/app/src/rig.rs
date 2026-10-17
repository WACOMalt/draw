//! Where the player is: the play area (the OpenXR stage) placed in the painting. Moved and
//! turned about the vertical only, never tilted or scaled, so the floor stays level.

use glam::{Mat4, Quat, Vec2, Vec3};

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
}

/// Movement like VRChat's, without gravity. The left stick flies where the head faces (up and
/// down too) and strafes to the head's right; the right stick turns in steps (left and right)
/// and rises or sinks straight up and down.
#[derive(Debug, Default)]
pub struct Locomotion {
    /// A turn happened and the stick has not come back to the middle yet.
    turned: bool,
}

/// Flying speed at full stick, meters per second.
pub const FLY_SPEED: f32 = 2.0;
/// Rising and sinking speed at full stick, meters per second.
pub const RISE_SPEED: f32 = 1.5;
/// One turn step.
pub const TURN_STEP: f32 = std::f32::consts::PI / 6.0;

/// A stick past its dead zone, rescaled so the edge of the dead zone is 0.
fn dead_zone(v: Vec2) -> Vec2 {
    const DEAD: f32 = 0.15;
    let len = v.length();
    if len < DEAD { Vec2::ZERO } else { v / len * ((len - DEAD) / (1.0 - DEAD)).min(1.0) }
}

impl Locomotion {
    /// One frame. `head`: the head pose in stage space. `fly` and `turn`: the left and right
    /// sticks (x right, y forward).
    pub fn update(&mut self, rig: &mut Rig, head: Mat4, fly: Vec2, turn: Vec2, dt: f32) {
        let fly = dead_zone(fly);
        let forward = head.transform_vector3(Vec3::NEG_Z).normalize_or_zero();
        let right = {
            let r = head.transform_vector3(Vec3::X);
            Vec3::new(r.x, 0.0, r.z).normalize_or_zero()
        };
        rig.pos += rig.dir(forward * fly.y + right * fly.x) * FLY_SPEED * dt;
        let turn = Vec2::new(turn.x, dead_zone(turn).y);
        rig.pos.y += turn.y * RISE_SPEED * dt;
        if !self.turned && turn.x.abs() > 0.7 {
            // Stick right turns right: clockwise from above.
            rig.turn(-turn.x.signum() * TURN_STEP, rig.point(head.w_axis.truncate()));
            self.turned = true;
        } else if turn.x.abs() < 0.3 {
            self.turned = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::{FRAC_PI_2, FRAC_PI_4};

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
    fn fly_goes_where_the_head_faces() {
        // Head looking up 45 degrees, turned 90 degrees left; the rig turned 90 degrees too.
        let head = Mat4::from_rotation_translation(Quat::from_rotation_y(FRAC_PI_2) * Quat::from_rotation_x(FRAC_PI_4), Vec3::new(0.0, 1.7, 0.0));
        let mut rig = Rig { pos: Vec3::ZERO, yaw: FRAC_PI_2 };
        let mut loco = Locomotion::default();
        loco.update(&mut rig, head, Vec2::Y, Vec2::ZERO, 1.0);
        // Head forward in the stage: -x, up; the rig turns that to +z, up.
        let want = Vec3::new(0.0, 1.0, 1.0).normalize() * FLY_SPEED;
        assert!(rig.pos.abs_diff_eq(want, 1e-4), "{}", rig.pos);
    }

    #[test]
    fn strafe_stays_level_and_turns_step_once() {
        // Head rolled: strafing still stays level.
        let head = Mat4::from_rotation_translation(Quat::from_rotation_z(0.4), Vec3::new(0.3, 1.6, 0.0));
        let mut rig = Rig::default();
        let mut loco = Locomotion::default();
        loco.update(&mut rig, head, Vec2::X, Vec2::ZERO, 1.0);
        assert!(rig.pos.abs_diff_eq(Vec3::X * FLY_SPEED, 1e-4), "{}", rig.pos);
        // Holding the stick right turns one step; back to the middle and right again, another.
        let before = rig.point(head.w_axis.truncate());
        for _ in 0..5 {
            loco.update(&mut rig, head, Vec2::ZERO, Vec2::X, 0.01);
        }
        assert!((rig.yaw + TURN_STEP).abs() < 1e-5);
        assert!(rig.point(head.w_axis.truncate()).abs_diff_eq(before, 1e-5), "the head stays put");
        loco.update(&mut rig, head, Vec2::ZERO, Vec2::ZERO, 0.01);
        loco.update(&mut rig, head, Vec2::ZERO, Vec2::X, 0.01);
        assert!((rig.yaw + 2.0 * TURN_STEP).abs() < 1e-5);
    }
}
