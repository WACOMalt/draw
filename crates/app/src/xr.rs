//! `vdraw --xr`: paint in VR through OpenXR (SteamVR, Monado, WiVRn).
//!
//! The runtime creates the Vulkan instance and device (XR_KHR_vulkan_enable2), so it can add
//! what its compositor needs and pick the GPU the headset is on. Each frame the raymarcher
//! writes both eyes into a two-layer RGBA16F target, and a blit copies it into the swapchain
//! (an sRGB array image, one layer per eye; the blit encodes sRGB).
//!
//! Controls (Valve Index; other controllers through the simple profile). Either hand paints;
//! the hand that painted last is the brush hand, the other one is the move hand.
//!   trigger                    paint (the pull is the pressure)
//!   B / A                      undo / redo (simple profile: menu = undo)
//!   brush hand:
//!     thumbstick up/down       brush size (logarithmic)
//!     thumbstick left/right    hue
//!     grip + thumbstick        opacity (up/down), hardness (left/right); a tick every 10%
//!   move hand:
//!     thumbstick up/down       fly where the controller points (also up and down)
//!     thumbstick left/right    turn 30 degrees
//!     grip                     hold on to the painting and drag it (any direction)
//!     thumbstick click         back to the start

use crate::camera::perspective_fov;
use crate::rig::Rig;
use anyhow::{Context, Result, anyhow, bail};
use ash::vk::{self, Handle};
use glam::{Mat4, Quat, Vec3};
use openxr as xr;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use vdraw_core::{Brush, GpuSegment, Painting, Sample, Stroke};
use vdraw_render::raymarch::FRAMES;
use vdraw_render::{BrushTip, EyeView, Gpu, Raymarcher, barrier};

const VIEW_TYPE: xr::ViewConfigurationType = xr::ViewConfigurationType::PRIMARY_STEREO;
const NEAR: f32 = 0.02;
const FAR: f32 = 100.0;
/// How far in front of the controller's aim point the brush tip sits (meters).
const TIP_OFFSET: f32 = 0.03;
/// Trigger pull below this is not painting (a resting finger).
const TRIGGER_DEAD: f32 = 0.05;
/// Grip pull that counts as held.
const GRIP_HELD: f32 = 0.5;
/// Flying speed at full thumbstick, meters per second.
const FLY_SPEED: f32 = 1.5;
const TURN_STEP: f32 = std::f32::consts::PI / 6.0;

fn load_entry() -> Result<xr::Entry> {
    // The crate looks for the unversioned libopenxr_loader.so (a dev package); most systems
    // install only the .so.1.
    unsafe { xr::Entry::load().or_else(|_| xr::Entry::load_from(Path::new("libopenxr_loader.so.1"))) }
        .map_err(|e| anyhow!("no OpenXR loader (libopenxr_loader.so.1): {e}"))
}

fn pose_mat(p: xr::Posef) -> Mat4 {
    Mat4::from_rotation_translation(quat(p.orientation), vec3(p.position))
}

fn quat(q: xr::Quaternionf) -> Quat {
    Quat::from_xyzw(q.x, q.y, q.z, q.w)
}

fn vec3(v: xr::Vector3f) -> Vec3 {
    Vec3::new(v.x, v.y, v.z)
}

/// A thumbstick with a dead zone, and only its stronger axis.
fn stick_axis(v: xr::Vector2f) -> (f32, f32) {
    let dead = |x: f32| if x.abs() < 0.2 { 0.0 } else { x };
    if v.x.abs() > v.y.abs() { (dead(v.x), 0.0) } else { (0.0, dead(v.y)) }
}

fn hsv(h: f32, s: f32, v: f32) -> [f32; 3] {
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

struct Swapchain {
    handle: xr::Swapchain<xr::Vulkan>,
    images: Vec<vk::Image>,
    width: u32,
    height: u32,
}

/// The controller actions, one subaction path per hand.
struct Input {
    set: xr::ActionSet,
    aim: xr::Action<xr::Posef>,
    paint: xr::Action<f32>,
    stick: xr::Action<xr::Vector2f>,
    undo: xr::Action<bool>,
    redo: xr::Action<bool>,
    grip: xr::Action<f32>,
    reset: xr::Action<bool>,
    haptic: xr::Action<xr::Haptic>,
    hands: [xr::Path; 2],
    spaces: [xr::Space; 2],
}

impl Input {
    fn new(instance: &xr::Instance, session: &xr::Session<xr::Vulkan>) -> Result<Self> {
        let hands = [instance.string_to_path("/user/hand/left")?, instance.string_to_path("/user/hand/right")?];
        let set = instance.create_action_set("paint", "Paint", 0)?;
        let aim = set.create_action::<xr::Posef>("aim", "Brush pose", &hands)?;
        let paint = set.create_action::<f32>("paint", "Paint", &hands)?;
        let stick = set.create_action::<xr::Vector2f>("brush", "Brush size and color", &hands)?;
        let undo = set.create_action::<bool>("undo", "Undo", &hands)?;
        let redo = set.create_action::<bool>("redo", "Redo", &hands)?;
        let grip = set.create_action::<f32>("grip", "Grab, or brush style", &hands)?;
        let reset = set.create_action::<bool>("reset", "Back to the start", &hands)?;
        let haptic = set.create_action::<xr::Haptic>("tick", "Tick", &hands)?;

        let p = |s: &str| instance.string_to_path(s);
        let mut index = Vec::new();
        for side in ["left", "right"] {
            let h = |s: &str| p(&format!("/user/hand/{side}/input/{s}"));
            index.push(xr::Binding::new(&aim, h("aim/pose")?));
            index.push(xr::Binding::new(&paint, h("trigger/value")?));
            index.push(xr::Binding::new(&stick, h("thumbstick")?));
            index.push(xr::Binding::new(&undo, h("b/click")?));
            index.push(xr::Binding::new(&redo, h("a/click")?));
            index.push(xr::Binding::new(&grip, h("squeeze/value")?));
            index.push(xr::Binding::new(&reset, h("thumbstick/click")?));
            index.push(xr::Binding::new(&haptic, p(&format!("/user/hand/{side}/output/haptic"))?));
        }
        instance.suggest_interaction_profile_bindings(p("/interaction_profiles/valve/index_controller")?, &index)?;
        let mut simple = Vec::new();
        for side in ["left", "right"] {
            let h = |s: &str| p(&format!("/user/hand/{side}/input/{s}"));
            simple.push(xr::Binding::new(&aim, h("aim/pose")?));
            simple.push(xr::Binding::new(&paint, h("select/click")?));
            simple.push(xr::Binding::new(&undo, h("menu/click")?));
            simple.push(xr::Binding::new(&haptic, p(&format!("/user/hand/{side}/output/haptic"))?));
        }
        if let Err(e) = instance.suggest_interaction_profile_bindings(p("/interaction_profiles/khr/simple_controller")?, &simple) {
            log::warn!("simple controller bindings refused: {e}");
        }
        session.attach_action_sets(&[&set])?;
        let spaces = [
            aim.create_space(session, hands[0], xr::Posef::IDENTITY)?,
            aim.create_space(session, hands[1], xr::Posef::IDENTITY)?,
        ];
        Ok(Self { set, aim, paint, stick, undo, redo, grip, reset, haptic, hands, spaces })
    }
}

/// What the hands do to the painting, frame to frame.
struct Painter {
    painting: Painting,
    /// Segments of the finished strokes (made again only when the strokes change).
    done: Vec<GpuSegment>,
    redo: Vec<Stroke>,
    active: Option<(usize, Stroke)>,
    brush: Brush,
    hue: f32,
}

impl Painter {
    fn new(painting: Painting) -> Self {
        let hue = 0.02;
        let brush = Brush { color: hsv(hue, 0.75, 0.9), ..Default::default() };
        let mut p = Self { painting, done: Vec::new(), redo: Vec::new(), active: None, brush, hue };
        p.rebuild();
        p
    }

    fn rebuild(&mut self) {
        self.painting.segments(None, &mut self.done);
    }

    fn undo(&mut self) {
        if let Some(s) = self.painting.strokes.pop() {
            self.redo.push(s);
            self.rebuild();
        }
    }

    fn redo(&mut self) {
        if let Some(s) = self.redo.pop() {
            self.painting.strokes.push(s);
            self.rebuild();
        }
    }

    /// One hand's trigger at time `t` (seconds), the tip at `tip`.
    fn hand(&mut self, hand: usize, t: f64, tip: Vec3, pull: f32) {
        let painting = pull > TRIGGER_DEAD;
        match &mut self.active {
            Some((h, stroke)) if *h == hand => {
                if painting {
                    stroke.push(Sample { pos: tip, pressure: pull, time: t });
                } else {
                    let (_, stroke) = self.active.take().unwrap();
                    stroke.segments(self.painting.filter, self.painting.strokes.len() as u32, &mut self.done);
                    self.painting.strokes.push(stroke);
                    self.redo.clear();
                }
            }
            None if painting => {
                let mut stroke = Stroke::new(self.brush);
                stroke.push(Sample { pos: tip, pressure: pull, time: t });
                self.active = Some((hand, stroke));
            }
            _ => {}
        }
    }

    /// The brush hand's thumbstick: y scales the brush (logarithmic), x turns the hue; with
    /// `style` (grip held) y sets the opacity and x the hardness. Only the stronger axis acts,
    /// so a push up does not also turn the hue. True when opacity or hardness passed a 10% step
    /// (or an end), for a haptic tick.
    fn stick(&mut self, v: xr::Vector2f, dt: f32, style: bool) -> bool {
        let (x, y) = stick_axis(v);
        let b = &mut self.brush;
        if !style {
            b.radius = (b.radius * (y * dt * 1.5).exp()).clamp(0.001, 0.1);
            self.hue += x * dt * 0.4;
            b.color = hsv(self.hue, 0.75, 0.9);
            return false;
        }
        let step = |old: f32, new: f32| (old * 10.0).floor() != (new * 10.0).floor() || (new != old && (new == 0.0 || new == 1.0));
        let (o, h) = (b.opacity, b.hardness);
        b.opacity = (o + y * dt * 0.5).clamp(0.05, 1.0);
        b.hardness = (h + x * dt * 0.5).clamp(0.0, 1.0);
        step(o, b.opacity) || step(h, b.hardness)
    }

    fn segments(&self, out: &mut Vec<GpuSegment>) {
        out.clear();
        out.extend_from_slice(&self.done);
        if let Some((_, s)) = &self.active {
            s.segments(self.painting.filter, self.painting.strokes.len() as u32, out);
        }
    }
}

pub fn run(painting: Painting) -> Result<()> {
    // Ctrl-C asks the runtime to end the session, so it can leave the headset cleanly.
    let quit = Arc::new(AtomicBool::new(false));
    let q = quit.clone();
    ctrlc::set_handler(move || q.store(true, Ordering::Relaxed))?;

    let entry = load_entry()?;
    let available = entry.enumerate_extensions()?;
    if !available.khr_vulkan_enable2 {
        bail!("the OpenXR runtime has no XR_KHR_vulkan_enable2");
    }
    let mut exts = xr::ExtensionSet::default();
    exts.khr_vulkan_enable2 = true;
    let instance = entry.create_instance(
        &xr::ApplicationInfo { application_name: "vdraw", application_version: 1, engine_name: "vdraw", engine_version: 1, api_version: xr::Version::new(1, 0, 0) },
        &exts,
        &[],
    )?;
    let props = instance.properties()?;
    log::info!("OpenXR runtime: {} {}", props.runtime_name, props.runtime_version);
    let system = instance.system(xr::FormFactor::HEAD_MOUNTED_DISPLAY).context("no headset found (is it on, and is the runtime running?)")?;
    let blend = instance.enumerate_environment_blend_modes(system, VIEW_TYPE)?[0];
    let reqs = instance.graphics_requirements::<xr::Vulkan>(system)?;
    log::info!("runtime wants Vulkan {}..{}", reqs.min_api_version_supported, reqs.max_api_version_supported);

    // Vulkan, created through the runtime.
    let vk_entry = unsafe { ash::Entry::load() }.context("no Vulkan loader")?;
    #[allow(clippy::missing_transmute_annotations)]
    let gipa = unsafe { std::mem::transmute(vk_entry.static_fn().get_instance_proc_addr) };
    let vk_instance = vdraw_render::gpu::create_instance_with(&vk_entry, &[], |info| {
        let raw = unsafe { instance.create_vulkan_instance(system, gipa, info as *const _ as *const _) }?
            .map_err(vk::Result::from_raw)
            .context("vkCreateInstance (through OpenXR)")?;
        Ok(vk::Instance::from_raw(raw as _))
    })?;
    let physical = vk::PhysicalDevice::from_raw(unsafe { instance.vulkan_graphics_device(system, vk_instance.handle().as_raw() as _) }? as _);
    let family = vdraw_render::gpu::pick_queue_family(&vk_instance, physical, &|_| true).context("no graphics and compute queue")?;
    let device = vdraw_render::gpu::create_device_with(&vk_instance, physical, family, &[], |info| {
        let raw = unsafe { instance.create_vulkan_device(system, gipa, physical.as_raw() as _, info as *const _ as *const _) }?
            .map_err(vk::Result::from_raw)
            .context("vkCreateDevice (through OpenXR)")?;
        Ok(vk::Device::from_raw(raw as _))
    })?;
    let gpu = Arc::new(Gpu::from_parts(vk_entry, vk_instance, physical, device, family)?);

    let (session, mut waiter, mut stream) = unsafe {
        instance.create_session::<xr::Vulkan>(
            system,
            &xr::vulkan::SessionCreateInfo {
                instance: gpu.instance.handle().as_raw() as _,
                physical_device: gpu.physical.as_raw() as _,
                device: gpu.device.handle().as_raw() as _,
                queue_family_index: family,
                queue_index: 0,
            },
        )
    }?;
    let input = Input::new(&instance, &session)?;
    let stage = session
        .create_reference_space(xr::ReferenceSpaceType::STAGE, xr::Posef::IDENTITY)
        .or_else(|_| session.create_reference_space(xr::ReferenceSpaceType::LOCAL, xr::Posef::IDENTITY))?;

    let head = session.create_reference_space(xr::ReferenceSpaceType::VIEW, xr::Posef::IDENTITY)?;

    let mut rm = Raymarcher::new(gpu.clone())?;
    let d = &gpu.device;
    let pool = unsafe {
        d.create_command_pool(&vk::CommandPoolCreateInfo::default().queue_family_index(family).flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER), None)
    }?;
    let cmds = unsafe { d.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).command_buffer_count(FRAMES as u32)) }?;
    let fences: Vec<vk::Fence> = (0..FRAMES)
        .map(|_| unsafe { d.create_fence(&vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED), None) })
        .collect::<Result<_, _>>()?;
    // GPU time of the raymarch + blit, two timestamps per frame slot.
    let queries = unsafe { d.create_query_pool(&vk::QueryPoolCreateInfo::default().query_type(vk::QueryType::TIMESTAMP).query_count(2 * FRAMES as u32), None) }?;
    let tick_ns = unsafe { gpu.instance.get_physical_device_properties(physical) }.limits.timestamp_period as f64;
    let mut queried = [false; FRAMES];

    let scale: f32 = std::env::var("VDRAW_SCALE").ok().and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let mut swapchain: Option<Swapchain> = None;
    let mut painter = Painter::new(painting);
    let mut segs = Vec::new();
    let mut events = xr::EventDataBuffer::new();
    let mut running = false;
    let mut frame = 0usize;
    let mut last = Instant::now();
    let mut stats = (Instant::now(), 0u32, 0.0f64); // since, frames, gpu ms sum
    let (mut undo_was, mut redo_was) = ([false; 2], [false; 2]);
    let mut tip_hand = 1usize;
    let mut rig = Rig::default();
    let mut held: Option<Vec3> = None; // the painting point the move hand holds
    let (mut turned, mut reset_was) = (false, false);

    'main: loop {
        if quit.swap(false, Ordering::Relaxed) {
            log::info!("quitting");
            match session.request_exit() {
                Ok(()) => {}
                Err(xr::sys::Result::ERROR_SESSION_NOT_RUNNING) => break,
                Err(e) => return Err(e.into()),
            }
        }
        while let Some(event) = instance.poll_event(&mut events)? {
            match event {
                xr::Event::SessionStateChanged(e) => {
                    log::info!("session: {:?}", e.state());
                    match e.state() {
                        xr::SessionState::READY => {
                            session.begin(VIEW_TYPE)?;
                            running = true;
                        }
                        xr::SessionState::STOPPING => {
                            session.end()?;
                            running = false;
                        }
                        xr::SessionState::EXITING | xr::SessionState::LOSS_PENDING => break 'main,
                        _ => {}
                    }
                }
                xr::Event::InstanceLossPending(_) => break 'main,
                _ => {}
            }
        }
        if !running {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }

        let state = waiter.wait()?;
        stream.begin()?;
        if !state.should_render {
            stream.end(state.predicted_display_time, blend, &[])?;
            continue;
        }
        let now = Instant::now();
        let dt = (now - last).as_secs_f32().min(0.1);
        last = now;
        let t = state.predicted_display_time.as_nanos() as f64 * 1e-9;

        // Input. Poses come in stage space; the rig places them in the painting.
        session.sync_actions(&[(&input.set).into()])?;
        let time = state.predicted_display_time;
        let mut aims: [Option<Mat4>; 2] = [None; 2];
        for (h, aim) in aims.iter_mut().enumerate() {
            let loc = input.spaces[h].locate(&stage, time)?;
            let tracked = loc.location_flags.contains(xr::SpaceLocationFlags::POSITION_VALID | xr::SpaceLocationFlags::ORIENTATION_VALID);
            if tracked && input.aim.is_active(&session, input.hands[h])? {
                *aim = Some(pose_mat(loc.pose));
            }
        }
        // Aim pose: -z is forward; the tip is a little in front.
        let tip_of = |aim: Mat4| aim.transform_point3(Vec3::new(0.0, 0.0, -TIP_OFFSET));
        let tick = |h: usize| {
            let pulse = xr::HapticVibration::new().amplitude(0.5).frequency(xr::FREQUENCY_UNSPECIFIED).duration(xr::Duration::from_nanos(12_000_000));
            input.haptic.apply_feedback(&session, input.hands[h], &pulse)
        };

        // Paint, undo, redo (either hand). Painting makes that hand the brush hand.
        for h in 0..2 {
            let Some(aim) = aims[h] else { continue };
            let pull = input.paint.state(&session, input.hands[h])?.current_state;
            if pull > TRIGGER_DEAD {
                tip_hand = h;
            }
            painter.hand(h, t, rig.point(tip_of(aim)), pull);
            let undo = input.undo.state(&session, input.hands[h])?.current_state;
            let redo = input.redo.state(&session, input.hands[h])?.current_state;
            if undo && !undo_was[h] {
                painter.undo();
            }
            if redo && !redo_was[h] {
                painter.redo();
            }
            (undo_was[h], redo_was[h]) = (undo, redo);
        }

        // The brush hand: size and hue, or with the grip held opacity and hardness.
        let brush = tip_hand;
        if aims[brush].is_some() {
            let stick = input.stick.state(&session, input.hands[brush])?;
            let style = input.grip.state(&session, input.hands[brush])?.current_state > GRIP_HELD;
            if stick.is_active && painter.stick(stick.current_state, dt, style) {
                tick(brush)?;
            }
        }

        // The move hand: hold on to the painting, fly, turn, go back to the start.
        let mover = 1 - brush;
        if let Some(aim) = aims[mover] {
            let hand = aim.w_axis.truncate();
            if input.grip.state(&session, input.hands[mover])?.current_state > GRIP_HELD {
                let at = *held.get_or_insert(rig.point(hand));
                rig.hold(at, hand);
            } else {
                held = None;
                let stick = input.stick.state(&session, input.hands[mover])?;
                let (x, y) = if stick.is_active { stick_axis(stick.current_state) } else { (0.0, 0.0) };
                // Squared, for fine control near the center.
                let forward = aim.transform_vector3(Vec3::NEG_Z);
                rig.pos += rig.dir(forward) * (y * y.abs()) * FLY_SPEED * dt;
                if !turned && x.abs() > 0.7 {
                    let head_at = head.locate(&stage, time)?.pose.position;
                    rig.turn(-x.signum() * TURN_STEP, rig.point(vec3(head_at)));
                    turned = true;
                } else if x.abs() < 0.3 {
                    turned = false;
                }
            }
            let reset = input.reset.state(&session, input.hands[mover])?.current_state;
            if reset && !reset_was {
                rig = Rig::default();
                held = None;
            }
            reset_was = reset;
        } else {
            held = None;
        }

        let tip = aims[brush].or(aims[mover]).map(|aim| BrushTip {
            pos: rig.point(tip_of(aim)),
            radius: painter.brush.radius,
            color: painter.brush.color,
            opacity: painter.brush.opacity,
            hardness: painter.brush.hardness,
        });
        painter.segments(&mut segs);

        let sc = match &mut swapchain {
            Some(s) => s,
            None => swapchain.insert(make_swapchain(&instance, system, &session, scale)?),
        };
        let image_index = sc.handle.acquire_image()? as usize;

        // This slot's last submission must be done before its buffers are reused.
        unsafe {
            d.wait_for_fences(&[fences[frame]], true, u64::MAX)?;
            d.reset_fences(&[fences[frame]])?;
            if queried[frame] {
                let mut ts = [0u64; 2];
                if d.get_query_pool_results(queries, 2 * frame as u32, &mut ts, vk::QueryResultFlags::TYPE_64).is_ok() {
                    stats.1 += 1;
                    stats.2 += (ts[1].wrapping_sub(ts[0])) as f64 * tick_ns * 1e-6;
                }
            }
        }
        if stats.0.elapsed() > Duration::from_secs(3) && stats.1 > 0 {
            log::info!("{} segments, GPU {:.2} ms/frame at {}x{} per eye", segs.len(), stats.2 / stats.1 as f64, sc.width, sc.height);
            stats = (Instant::now(), 0, 0.0);
        }

        // Views as late as possible, for the least latency.
        let (_, views) = session.locate_views(VIEW_TYPE, state.predicted_display_time, &stage)?;
        let eyes: Vec<EyeView> = views
            .iter()
            .map(|v| {
                let f = v.fov;
                let proj = perspective_fov(f.angle_left, f.angle_right, f.angle_up, f.angle_down, NEAR, FAR);
                EyeView { view_proj: proj * (rig.mat() * pose_mat(v.pose)).inverse(), pos: rig.point(vec3(v.pose.position)) }
            })
            .collect();

        let cmd = cmds[frame];
        let (w, h) = (sc.width, sc.height);
        let target = rm.target(w, h, 2)?.image;
        let dst = sc.images[image_index];
        unsafe {
            d.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT))?;
            d.cmd_reset_query_pool(cmd, queries, 2 * frame as u32, 2);
            d.cmd_write_timestamp2(cmd, vk::PipelineStageFlags2::TOP_OF_PIPE, queries, 2 * frame as u32);
            rm.record(cmd, frame, &segs, &eyes, tip)?;
            barrier(d, cmd, dst, 2, vk::ImageLayout::UNDEFINED, vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                vk::PipelineStageFlags2::NONE, vk::AccessFlags2::NONE,
                vk::PipelineStageFlags2::BLIT, vk::AccessFlags2::TRANSFER_WRITE);
            let layers = vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).layer_count(2);
            let corner = vk::Offset3D { x: w as i32, y: h as i32, z: 1 };
            let blit = vk::ImageBlit::default()
                .src_subresource(layers)
                .src_offsets([vk::Offset3D::default(), corner])
                .dst_subresource(layers)
                .dst_offsets([vk::Offset3D::default(), corner]);
            d.cmd_blit_image(cmd, target, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, dst, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[blit], vk::Filter::NEAREST);
            // The runtime takes the image back in COLOR_ATTACHMENT_OPTIMAL.
            barrier(d, cmd, dst, 2, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL,
                vk::PipelineStageFlags2::BLIT, vk::AccessFlags2::TRANSFER_WRITE,
                vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT, vk::AccessFlags2::COLOR_ATTACHMENT_WRITE);
            d.cmd_write_timestamp2(cmd, vk::PipelineStageFlags2::BOTTOM_OF_PIPE, queries, 2 * frame as u32 + 1);
            d.end_command_buffer(cmd)?;
        }
        sc.handle.wait_image(xr::Duration::INFINITE)?;
        unsafe { d.queue_submit(gpu.queue, &[vk::SubmitInfo::default().command_buffers(&[cmd])], fences[frame]) }?;
        queried[frame] = true;
        sc.handle.release_image()?;

        let rect = xr::Rect2Di { offset: xr::Offset2Di { x: 0, y: 0 }, extent: xr::Extent2Di { width: w as i32, height: h as i32 } };
        let proj_views: Vec<_> = (0..2)
            .map(|i| {
                xr::CompositionLayerProjectionView::new()
                    .pose(views[i].pose)
                    .fov(views[i].fov)
                    .sub_image(xr::SwapchainSubImage::new().swapchain(&sc.handle).image_array_index(i as u32).image_rect(rect))
            })
            .collect();
        stream.end(state.predicted_display_time, blend, &[&xr::CompositionLayerProjection::new().space(&stage).views(&proj_views)])?;
        frame = (frame + 1) % FRAMES;
    }

    // OpenXR lets go of the swapchain images before Vulkan objects go away.
    unsafe { d.device_wait_idle() }?;
    drop(swapchain);
    drop((input, head, stage, stream, waiter, session));
    unsafe {
        for f in fences {
            d.destroy_fence(f, None);
        }
        d.destroy_query_pool(queries, None);
        d.destroy_command_pool(pool, None);
    }
    drop(rm);
    Ok(())
}

fn make_swapchain(instance: &xr::Instance, system: xr::SystemId, session: &xr::Session<xr::Vulkan>, scale: f32) -> Result<Swapchain> {
    let views = instance.enumerate_view_configuration_views(system, VIEW_TYPE)?;
    if views.len() != 2 {
        bail!("expected 2 views, the runtime has {}", views.len());
    }
    let width = ((views[0].recommended_image_rect_width as f32 * scale) as u32).clamp(64, views[0].max_image_rect_width);
    let height = ((views[0].recommended_image_rect_height as f32 * scale) as u32).clamp(64, views[0].max_image_rect_height);
    let formats = session.enumerate_swapchain_formats()?;
    let format = [vk::Format::R8G8B8A8_SRGB, vk::Format::B8G8R8A8_SRGB]
        .into_iter()
        .find(|f| formats.contains(&(f.as_raw() as u32)))
        .context("the runtime offers no 8-bit sRGB swapchain format")?;
    log::info!("swapchain {width}x{height} per eye ({}x{} recommended), {format:?}", views[0].recommended_image_rect_width, views[0].recommended_image_rect_height);
    let handle = session.create_swapchain(&xr::SwapchainCreateInfo {
        create_flags: xr::SwapchainCreateFlags::EMPTY,
        usage_flags: xr::SwapchainUsageFlags::COLOR_ATTACHMENT | xr::SwapchainUsageFlags::TRANSFER_DST,
        format: format.as_raw() as u32,
        sample_count: 1,
        width,
        height,
        face_count: 1,
        array_size: 2,
        mip_count: 1,
    })?;
    let images = handle.enumerate_images()?.into_iter().map(vk::Image::from_raw).collect();
    Ok(Swapchain { handle, images, width, height })
}
