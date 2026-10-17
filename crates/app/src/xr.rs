//! `vdraw --xr`: paint in VR through OpenXR (SteamVR, Monado, WiVRn).
//!
//! The runtime creates the Vulkan instance and device (XR_KHR_vulkan_enable2), so it can add
//! what its compositor needs and pick the GPU the headset is on. Each frame the raymarcher
//! writes both eyes into a two-layer RGBA16F target, and a blit copies it into the swapchain
//! (an sRGB array image, one layer per eye; the blit encodes sRGB).
//!
//! Controls (Valve Index; other controllers through the simple profile). Either hand paints;
//! the hand that painted last is the painting hand, and the tool panel floats above the
//! other one. The tip is held like a pen: a tip that is not round is flat along the
//! controller's up side (turned by the tool's angle), so rolling the wrist turns it.
//!   trigger                  use the tool: paint or erase (the pull is the pressure); sweep
//!                            the stroke eraser's ball; pick a color (eyedropper); hold the
//!                            active layer (move layer). Pointed at the panel: click
//!   B / A                    undo / redo (simple profile: menu = undo)
//!   left stick               fly where the head faces (up and down too), strafe
//!   right stick              turn in 30 degree steps (left, right), rise and sink (up, down)
//!   painting hand's stick    pointed at the panel: scroll; holding a layer: scale it
//!   panel hand: stick click  hide or show the panel
//!   grip                     on a shared canvas: hold it (drag); both grips: move, turn and
//!                            zoom it
//!
//! It starts at the start screen (the 2D app's): a shared canvas, or this device's painting.

use crate::camera::perspective_fov;
use crate::debug;
use crate::canvas::Canvas;
use crate::lobby::Lobby;
use crate::panel::home::Opening;
use crate::panel::{Action, CanvasInfo, Model, Panel, Placement, Pointer, Screen};
use crate::rig::{Locomotion, Rig};
use crate::painter::Painter;
use crate::tools::Tool;
use anyhow::{Context, Result, anyhow, bail};
use ash::vk::{self, Handle};
use glam::{Mat4, Quat, Vec2, Vec3};
use openxr as xr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use vdraw_core::Painting;
use vdraw_render::raymarch::{Buffer, FRAMES};
use vdraw_net::identity::Identity;
use vdraw_net::session::{Session, State};
use vdraw_render::{BrushTip, EyeView, Gpu, Overlays, PanelDraw, Raymarcher, UiRenderer, barrier};

/// Where `run` starts.
pub enum Start {
    /// The start screen.
    Home,
    /// This device's painting (saved to the path, if there is one).
    Local(Painting, Option<PathBuf>),
    /// A shared canvas, by its code, name or link.
    Canvas(String),
}

/// What is open.
enum Mode {
    Home,
    Local,
    Canvas(Box<Canvas>),
}

/// A grip's pull that holds the canvas, and lets go below the next.
const GRIP_DOWN: f32 = 0.6;
const GRIP_UP: f32 = 0.35;

const VIEW_TYPE: xr::ViewConfigurationType = xr::ViewConfigurationType::PRIMARY_STEREO;
const NEAR: f32 = 0.02;
const FAR: f32 = 100.0;
/// How far in front of the controller's aim point the brush tip sits (meters).
const TIP_OFFSET: f32 = 0.03;
/// Trigger pull below this is not painting (a resting finger).
const TRIGGER_DEAD: f32 = 0.05;
/// A trigger click on the panel: down past this pull, up again below the next one.
const CLICK_DOWN: f32 = 0.6;
const CLICK_UP: f32 = 0.25;

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

struct Swapchain {
    handle: xr::Swapchain<xr::Vulkan>,
    images: Vec<vk::Image>,
    format: vk::Format,
    width: u32,
    height: u32,
}

/// Where a hand's trigger press went: the panel or the painting.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Press {
    Off,
    Panel,
    Paint,
}

/// GPU time and late frames, logged every few seconds.
struct Stats {
    since: Instant,
    frames: u32,
    late: u32,
    gpu_frames: u32,
    gpu_ms: f64,
    /// The last logged: GPU ms per frame, frames per second, late frames.
    last: (f64, f32, u32),
}

impl Stats {
    fn new() -> Self {
        Self { since: Instant::now(), frames: 0, late: 0, gpu_frames: 0, gpu_ms: 0.0, last: (0.0, 0.0, 0) }
    }

    fn gpu(&mut self, ms: f64) {
        self.gpu_frames += 1;
        self.gpu_ms += ms;
    }

    /// One frame `dt` after the last; late when it took over 1.5 display periods.
    fn frame(&mut self, dt: f32, period: f32) {
        self.frames += 1;
        if period > 0.0 && dt > period * 1.5 {
            self.late += 1;
        }
    }

    fn log(&mut self, segments: usize, width: u32, height: u32) {
        if self.since.elapsed() < Duration::from_secs(3) || self.gpu_frames == 0 {
            return;
        }
        let secs = self.since.elapsed().as_secs_f32();
        let last = (self.gpu_ms / self.gpu_frames as f64, self.frames as f32 / secs, self.late);
        log::info!("{segments} segments, GPU {:.2} ms/frame at {width}x{height} per eye, {:.0} fps, {} late frames", last.0, last.1, last.2);
        *self = Self { last, ..Self::new() };
    }
}

/// The controller actions, one subaction path per hand.
struct Input {
    set: xr::ActionSet,
    aim: xr::Action<xr::Posef>,
    paint: xr::Action<f32>,
    stick: xr::Action<xr::Vector2f>,
    undo: xr::Action<bool>,
    redo: xr::Action<bool>,
    toggle: xr::Action<bool>,
    grip: xr::Action<f32>,
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
        let stick = set.create_action::<xr::Vector2f>("move", "Fly, turn", &hands)?;
        let undo = set.create_action::<bool>("undo", "Undo", &hands)?;
        let redo = set.create_action::<bool>("redo", "Redo", &hands)?;
        let toggle = set.create_action::<bool>("panel", "Hide or show the panel", &hands)?;
        let grip = set.create_action::<f32>("grip", "Hold the canvas", &hands)?;
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
            index.push(xr::Binding::new(&toggle, h("thumbstick/click")?));
            index.push(xr::Binding::new(&grip, h("squeeze/value")?));
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
        Ok(Self { set, aim, paint, stick, undo, redo, toggle, grip, haptic, hands, spaces })
    }
}

/// Paints in VR, from `start`. This device's painting is saved where it came from, after
/// changes (every half minute, in the background), on leaving it, and on the way out.
/// `server`: the 2D app's server for shared canvases (else the one used last).
pub fn run(start: Start, server: Option<String>) -> Result<()> {
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
    let mut identity = Identity::load(Identity::default_path());
    if let Some(s) = server {
        identity.server = s.trim_end_matches('/').to_string();
        identity.save();
    }
    let mut lobby = Lobby::new(identity);
    let (mut mode, painting, mut save_to) = match start {
        Start::Home => (Mode::Home, Painting::default(), None),
        Start::Local(p, path) => (Mode::Local, p, path),
        Start::Canvas(input) => {
            lobby.join(input);
            (Mode::Home, Painting::default(), None)
        }
    };
    let mut painter = Painter::new(painting);
    let mut saving: Option<std::thread::JoinHandle<()>> = None;
    let mut saved_at = Instant::now();
    let mut events = xr::EventDataBuffer::new();
    let mut running = false;
    let mut frame = 0usize;
    let mut last = Instant::now();
    let mut stats = Stats::new();
    let (mut undo_was, mut redo_was, mut toggle_was) = ([false; 2], [false; 2], [false; 2]);
    let mut painting_hand = 1usize;
    let mut rig = Rig::default();
    let mut loco = Locomotion::default();
    let mut press = [Press::Off; 2];
    let mut click = false; // the trigger is clicked down on the panel
    let mut panel = Panel::new(&painter.tools.brush);
    panel.screen = if matches!(mode, Mode::Local) { Screen::Paint } else { Screen::Home };
    let mut grip_was = [false; 2];
    // Your palettes, beside the painting (or the default place, for a demo).
    let mut palettes = crate::palettes::Palettes::load(crate::palettes::path_beside(save_to.as_deref()).unwrap_or_else(|| crate::painting_path().with_file_name("palettes.json")));
    let mut presets = crate::presets::Presets::load(crate::painting_path().with_file_name("presets.json"));
    let mut panel_shown = true;
    let mut ui: Option<UiRenderer> = None;
    // A debug snapshot this frame (the panel's button), and the buffer it is copied into.
    let mut capture = false;
    let mut shot_buffer: Option<Buffer> = None;
    // The eyedropper: per frame slot, the picked pixel copied out, and whether it waits there.
    let mut pick_buffers = (0..FRAMES)
        .map(|_| Buffer::new(&gpu, 256, vk::BufferUsageFlags::TRANSFER_DST, gpu_allocator::MemoryLocation::GpuToCpu, "eyedropper"))
        .collect::<Result<Vec<_>>>()?;
    let mut pick_pending = [false; FRAMES];
    let mut picking_was = false;

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
        let head_pose = pose_mat(head.locate(&stage, time)?.pose);
        // Aim pose: -z is forward; the tip is a little in front. The pen's up side (+y), turned
        // by the tool's angle about the pen.
        let tip_of = |aim: Mat4| aim.transform_point3(Vec3::new(0.0, 0.0, -TIP_OFFSET));
        let turn = painter.tools.clone();
        let up_of = |aim: Mat4| turn.tip_up(aim.y_axis.truncate(), -aim.z_axis.truncate());
        let tick = |h: usize, amplitude: f32, ms: i64| {
            let pulse = xr::HapticVibration::new().amplitude(amplitude).frequency(xr::FREQUENCY_UNSPECIFIED).duration(xr::Duration::from_nanos(ms * 1_000_000));
            input.haptic.apply_feedback(&session, input.hands[h], &pulse)
        };

        // A shared canvas: what came from the server, into the painting; how it opens.
        let world_head = rig.mat() * head_pose;
        if let Some(open) = lobby.poll() {
            if let Mode::Canvas(c) = &mode {
                c.session.close();
            }
            painter.reopen(Painting::default());
            let id = &lobby.identity;
            let session = Session::open(&lobby.server, &open.key, &id.name, &id.color, &id.anon, open.link.as_deref());
            mode = Mode::Canvas(Box::new(Canvas::new(session)));
            // Edits go to the canvas from the first frame (none are kept locally).
            painter.shared = true;
            panel.screen = Screen::Home;
            panel.opening = Some(Opening::Connecting(open.key.clone()));
            log::info!("opening canvas {} on {}", open.key, lobby.server.base);
        }
        if let Mode::Canvas(c) = &mut mode {
            c.update(&mut painter, world_head);
            let key = c.session.key.clone();
            match &c.session.state {
                State::Open if panel.opening.is_some() => {
                    panel.opening = None;
                    panel.screen = Screen::Paint;
                }
                State::Password { wrong } => panel.opening = Some(Opening::Password { key, wrong: *wrong }),
                State::Denied(reason) => panel.opening = Some(Opening::Denied { key, reason: reason.clone() }),
                _ => {}
            }
        }
        // The scene (the strokes' space) in the room: a shared canvas's view, or the room.
        let (world_from_scene, scene_from_world) = match &mode {
            Mode::Canvas(c) => (c.view, c.view.inverse()),
            _ => (Mat4::IDENTITY, Mat4::IDENTITY),
        };
        // Scene units per meter: a brush's size is what it looks like, at any zoom.
        painter.scale = 1.0 / world_from_scene.x_axis.truncate().length();
        let to_scene = |p: Vec3| scene_from_world.transform_point3(p);
        let dir_to_scene = |d: Vec3| scene_from_world.transform_vector3(d).normalize_or(Vec3::Y);
        // On a shared canvas the flat layers are painted with a laser onto the paper: the tip is
        // where the controller's ray meets it, turned by the tool's angle as the 2D app turns
        // its tip (in the paper's plane).
        // (A VR layer is painted in 3D, with the pen's tip.)
        let laser_mode = matches!(mode, Mode::Canvas(_)) && painter.painting.layers.get(painter.active_index()).is_some_and(|l| l.ordered);
        let laser_at = |rig: &Rig, aim: Mat4| -> Option<Vec3> {
            let o = to_scene(rig.point(aim.w_axis.truncate()));
            let d = scene_from_world.transform_vector3(rig.dir(aim.transform_vector3(Vec3::NEG_Z)));
            let t = -o.z / d.z;
            (d.z.abs() > 1e-9 && t > 0.0).then(|| o + d * t)
        };
        let flat_up = {
            let rot = painter.tools.angle[if painter.tools.tool == Tool::Eraser { 1 } else { 0 }].to_radians();
            Vec3::new(-rot.sin(), -rot.cos(), 0.0)
        };
        // Where the tool is (the scene), the pen's up side, and whether it is there at all.
        let tool_at = |rig: &Rig, aim: Mat4| -> Option<(Vec3, Vec3)> {
            if laser_mode { laser_at(rig, aim).map(|p| (p, flat_up)) } else { Some((to_scene(rig.point(tip_of(aim))), dir_to_scene(rig.dir(up_of(aim))))) }
        };

        // The panel floats above the hand that is not painting.
        let panel_hand = 1 - painting_hand;
        let placement = match aims[panel_hand] {
            Some(aim) if panel_shown => Some(Placement::above_hand(aim.w_axis.truncate(), head_pose.w_axis.truncate())),
            _ => None,
        };
        let toggle = input.toggle.state(&session, input.hands[panel_hand])?.current_state;
        if toggle && !toggle_was[panel_hand] {
            panel_shown = !panel_shown;
        }
        toggle_was = [false; 2];
        toggle_was[panel_hand] = toggle;

        // Triggers. A press that begins on the panel stays with the panel until it is let go;
        // one that begins anywhere else paints, also when it sweeps across the panel.
        let mut pointer = Pointer::default();
        let mut laser = None;
        for h in 0..2 {
            let Some(aim) = aims[h] else {
                press[h] = Press::Off;
                continue;
            };
            let pull = input.paint.state(&session, input.hands[h])?.current_state;
            let (from, dir) = (aim.w_axis.truncate(), aim.transform_vector3(Vec3::NEG_Z));
            let on_panel = if h == painting_hand { placement.and_then(|p| p.hit(from, dir)) } else { None };
            press[h] = match press[h] {
                Press::Off if pull > TRIGGER_DEAD => {
                    if on_panel.is_some() {
                        Press::Panel
                    } else {
                        painting_hand = h;
                        Press::Paint
                    }
                }
                Press::Panel | Press::Paint if pull <= TRIGGER_DEAD => Press::Off,
                p => p,
            };
            let pull = if press[h] == Press::Paint { pull } else { 0.0 };
            match tool_at(&rig, aim) {
                Some((at, up)) => painter.hand(h, t, at, up, pull),
                // The laser is off the paper: the stroke ends.
                None => painter.hand(h, t, Vec3::ZERO, Vec3::Y, 0.0),
            }
            if h == painting_hand {
                if press[h] == Press::Panel {
                    let was = click;
                    click = if click { pull > CLICK_UP } else { pull > CLICK_DOWN };
                    if click && !was {
                        tick(h, 0.3, 15)?;
                    }
                    pointer = Pointer { at: placement.and_then(|p| p.project(from, dir)), pressed: click, scroll: 0.0 };
                } else {
                    click = false;
                    if press[h] == Press::Off {
                        pointer = Pointer { at: on_panel.map(|(_, at)| at), pressed: false, scroll: 0.0 };
                    }
                }
                if let (Some(p), Some(at)) = (placement, pointer.at) {
                    laser = Some((rig.point(from), rig.point(p.to_stage(at))));
                }
            }
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

        // Moving: VRChat's sticks, without gravity.
        let stick = |h: usize| -> Result<Vec2> {
            let s = input.stick.state(&session, input.hands[h])?;
            Ok(if s.is_active { Vec2::new(s.current_state.x, s.current_state.y) } else { Vec2::ZERO })
        };
        // While the painting hand points at the panel, its stick scrolls the panel instead.
        let mut sticks = [stick(0)?, stick(1)?];
        if pointer.at.is_some() {
            pointer.scroll = sticks[painting_hand].y;
            sticks[painting_hand] = Vec2::ZERO;
        }
        // The Move layer tool: the trigger holds the active layer, which follows the hand; its
        // stick scales it (and does not move you meanwhile).
        let grabbing = painter.tools.tool == Tool::Transform && press[painting_hand] == Press::Paint;
        if grabbing || painter.grab.is_some() {
            if let Some(aim) = aims[painting_hand] {
                painter.grab(painting_hand, scene_from_world * rig.mat() * aim, grabbing, sticks[painting_hand].y, dt);
            }
            sticks[painting_hand] = Vec2::ZERO;
        }
        loco.update(&mut rig, head_pose, sticks[0], sticks[1], dt);

        // The grips hold a shared canvas: one drags it, two move, turn and zoom it. The
        // painting hand's ray tells the others where it points on the paper.
        let mut grips = [false; 2];
        for (h, g) in grips.iter_mut().enumerate() {
            let pull = input.grip.state(&session, input.hands[h])?.current_state;
            *g = if grip_was[h] { pull > GRIP_UP } else { pull > GRIP_DOWN };
        }
        grip_was = grips;
        if let Mode::Canvas(c) = &mut mode {
            let poses = aims.map(|a| a.map(|a| rig.mat() * a));
            c.navigate(&mut painter, poses, grips);
            let at = aims[painting_hand].filter(|_| pointer.at.is_none()).and_then(|aim| c.paper_point(rig.point(aim.w_axis.truncate()), rig.dir(aim.transform_vector3(Vec3::NEG_Z))));
            let layer = c.doc_layer(painter.active_index()).map(str::to_string);
            c.send_cursor(at, layer.as_deref());
        }

        // The panel: laid out with this frame's pointer.
        let canvas_info = match &mode {
            Mode::Canvas(c) => Some(CanvasInfo {
                key: c.session.key.clone(),
                role: c.session.role.clone(),
                state: match &c.session.state {
                    State::Open => "connected".into(),
                    State::Connecting => "connecting".into(),
                    State::Reconnecting(why) => format!("reconnecting ({why})"),
                    other => format!("{other:?}"),
                },
                peers: c.session.peers.values().map(|p| (p.name.clone(), p.color.clone())).collect(),
                not_drawn: c.session.not_drawn().into_iter().map(str::to_string).collect(),
            }),
            _ => None,
        };
        let panel_frame = placement.map(|_| panel.run(pointer, Model { painter: &mut painter, palettes: &mut palettes, presets: &mut presets, lobby: &mut lobby, canvas: canvas_info }));
        if let Some(f) = &panel_frame {
            for action in &f.actions {
                match action {
                    Action::Recenter => rig = Rig::default(),
                    Action::DebugSnapshot => capture = true,
                    Action::PaintLocal => {
                        // This device's painting: the one saved, or the demo shapes at first.
                        let path = crate::painting_path();
                        let painting = if path.exists() { vdraw_core::file::load(&path).unwrap_or_else(|e| {
                            log::error!("{}: {e:#}", path.display());
                            Painting::default()
                        }) } else { crate::demo::painting() };
                        log::info!("painting: {}", path.display());
                        painter.reopen(painting);
                        save_to = Some(path);
                        mode = Mode::Local;
                        panel.screen = Screen::Paint;
                    }
                    Action::Leave => {
                        match &mode {
                            Mode::Canvas(c) => c.session.close(),
                            Mode::Local => {
                                if let (Some(path), true) = (&save_to, painter.changed) {
                                    if let Err(e) = vdraw_core::file::save(path, &painter.painting) {
                                        log::error!("saving {}: {e:#}", path.display());
                                    }
                                }
                                save_to = None;
                            }
                            Mode::Home => {}
                        }
                        painter.reopen(Painting::default());
                        mode = Mode::Home;
                        panel.screen = Screen::Home;
                        panel.opening = None;
                        lobby.refresh();
                    }
                    Action::Password(p) => {
                        if let Mode::Canvas(c) = &mut mode {
                            c.session.password(p);
                        }
                    }
                }
            }
        }

        // The tip, on the painting hand, unless it points at the panel: the brush's (a preview
        // of the next stroke), the eraser's and the stroke eraser's (rings), and the stroke
        // eraser's overlay.
        let mut lines = Vec::new();
        // The eyedropper: no tip, a laser along what it points at.
        if let (Tool::Eyedropper, None, Some(aim)) = (painter.tools.tool, pointer.at, aims[painting_hand]) {
            let from = aim.w_axis.truncate();
            laser = Some((rig.point(from), rig.point(from + aim.transform_vector3(Vec3::NEG_Z) * 4.0)));
        }
        // The overlays are drawn in the scene.
        let laser = laser.map(|(a, b)| (to_scene(a), to_scene(b)));
        let tool_pos = aims[painting_hand].filter(|_| pointer.at.is_none() && !matches!(painter.tools.tool, Tool::Eyedropper | Tool::Transform)).and_then(|aim| tool_at(&rig, aim).map(|t| (aim, t)));
        // The laser to the paper.
        let laser = match (laser, tool_pos) {
            (None, Some((aim, (pos, _)))) if laser_mode => Some((to_scene(rig.point(aim.w_axis.truncate())), pos)),
            (l, _) => l,
        };
        let tip = tool_pos.map(|(_, (pos, up))| {
            match painter.tools.paint() {
                Some(b) => BrushTip {
                    pos,
                    radius: b.radius * painter.scale,
                    color: if b.erase { [1.0; 3] } else { b.color },
                    opacity: if b.erase { 0.0 } else { b.opacity },
                    hardness: b.hardness,
                    up,
                    roundness: b.roundness,
                },
                None => {
                    painter.eraser_lines(pos, &mut lines);
                    BrushTip { pos, radius: painter.tools.sweep_size * 0.5 * painter.scale, color: [1.0; 3], opacity: 0.0, hardness: 1.0, up, roundness: 1.0 }
                }
            }
        });
        painter.update_drawing();
        if let Mode::Canvas(c) = &mut mode {
            // What this user did, out as ops; their stroke being drawn, out for the others.
            c.commit(&mut painter);
            c.send_live(&painter);
            painter.update_drawing();
            c.draw_live(&mut painter);
            c.cursor_lines(&mut lines);
        }
        let steps = painter.scene_steps();

        let sc = match &mut swapchain {
            Some(s) => s,
            None => swapchain.insert(make_swapchain(&instance, system, &session, scale)?),
        };
        let ui = match &mut ui {
            Some(u) => u,
            None => ui.insert(UiRenderer::new(gpu.clone(), sc.format)?),
        };
        if let Some(f) = &panel_frame {
            ui.update_textures(&f.textures)?;
        }
        let image_index = sc.handle.acquire_image()? as usize;

        // This slot's last submission must be done before its buffers are reused.
        unsafe {
            d.wait_for_fences(&[fences[frame]], true, u64::MAX)?;
            d.reset_fences(&[fences[frame]])?;
            if pick_pending[frame] {
                // The eyedropper's pixel (RGBA16F: linear color, and how much paint): where
                // there is paint, it is the color.
                pick_pending[frame] = false;
                let px: [u16; 4] = bytemuck::pod_read_unaligned(&pick_buffers[frame].bytes()[..8]);
                let [r, g, b, a] = px.map(half_to_f32);
                if a > 0.01 {
                    painter.tools.brush.color = [r, g, b].map(|c| c.clamp(0.0, 1.0));
                }
            }
            if queried[frame] {
                let mut ts = [0u64; 2];
                if d.get_query_pool_results(queries, 2 * frame as u32, &mut ts, vk::QueryResultFlags::TYPE_64).is_ok() {
                    stats.gpu((ts[1].wrapping_sub(ts[0])) as f64 * tick_ns * 1e-6);
                }
            }
        }
        stats.frame(dt, state.predicted_display_period.as_nanos() as f32 * 1e-9);
        stats.log(painter.done.len() + painter.drawing.len(), sc.width, sc.height);

        // Views as late as possible, for the least latency.
        let (_, views) = session.locate_views(VIEW_TYPE, state.predicted_display_time, &stage)?;
        // The eyes in the room (the panel), and in the scene (the raymarch).
        let world_eyes: Vec<EyeView> = views
            .iter()
            .map(|v| {
                let f = v.fov;
                let proj = perspective_fov(f.angle_left, f.angle_right, f.angle_up, f.angle_down, NEAR, FAR);
                EyeView { view_proj: proj * (rig.mat() * pose_mat(v.pose)).inverse(), pos: rig.point(vec3(v.pose.position)) }
            })
            .collect();
        let eyes: Vec<EyeView> = world_eyes.iter().map(|e| EyeView { view_proj: e.view_proj * world_from_scene, pos: to_scene(e.pos) }).collect();

        let cmd = cmds[frame];
        let (w, h) = (sc.width, sc.height);
        // The eyes, and a layer for the eyedropper's view.
        let target = rm.target(w, h, 3)?.image;
        // The eyedropper, while its trigger is held: a view along the controller's ray, whose
        // first pixel is what it points at. Let go: the color goes to the recent ones.
        let picking = painter.tools.tool == Tool::Eyedropper && press[painting_hand] == Press::Paint;
        let pick = aims[painting_hand].filter(|_| picking).map(|aim| {
            let world = rig.mat() * aim;
            EyeView { view_proj: crate::camera::pick_projection(w, h, NEAR, FAR) * world.inverse() * world_from_scene, pos: to_scene(world.w_axis.truncate()) }
        });
        if picking_was && !picking {
            painter.add_recent(crate::panel::to_srgb(painter.tools.brush.color));
        }
        picking_was = picking;
        let dst = sc.images[image_index];
        unsafe {
            d.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT))?;
            d.cmd_reset_query_pool(cmd, queries, 2 * frame as u32, 2);
            d.cmd_write_timestamp2(cmd, vk::PipelineStageFlags2::TOP_OF_PIPE, queries, 2 * frame as u32);
            let (paper, paper_grid) = match &mode {
                Mode::Canvas(c) if c.placed => (c.paper, if c.paper[3] < 1.0 { c.grid() } else { 0.0 }),
                _ => ([0.0; 4], 0.0),
            };
            let scene = vdraw_render::Scene { world_from_scene, paper, paper_grid, ..painter.scene(&steps) };
            rm.record(cmd, frame, &scene, &eyes, &Overlays { tip, laser, lines: &lines, pick })?;
            if pick.is_some() {
                let region = vk::BufferImageCopy::default()
                    .image_subresource(vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).base_array_layer(2).layer_count(1))
                    .image_extent(vk::Extent3D { width: 1, height: 1, depth: 1 });
                d.cmd_copy_image_to_buffer(cmd, target, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, pick_buffers[frame].buffer, &[region]);
                pick_pending[frame] = true;
            }
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
            // The panel over the painting. The runtime takes the image back in
            // COLOR_ATTACHMENT_OPTIMAL.
            barrier(d, cmd, dst, 2, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL,
                vk::PipelineStageFlags2::BLIT, vk::AccessFlags2::TRANSFER_WRITE,
                vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT, vk::AccessFlags2::COLOR_ATTACHMENT_READ | vk::AccessFlags2::COLOR_ATTACHMENT_WRITE);
            if let (Some(p), Some(f)) = (placement, &panel_frame) {
                let model = rig.mat() * p.model();
                let draw = PanelDraw { clip_from_point: [world_eyes[0].view_proj * model, world_eyes[1].view_proj * model], primitives: &f.primitives };
                ui.record(cmd, frame, dst, w, h, 2, &[draw])?;
            }
            // A debug snapshot: both eyes as shown, copied out.
            if capture {
                let size = (2 * w * h * 4) as u64;
                if shot_buffer.as_ref().is_none_or(|b: &Buffer| b.size < size) {
                    if let Some(mut b) = shot_buffer.take() {
                        b.destroy(&gpu);
                    }
                    shot_buffer = Some(Buffer::new(&gpu, size, vk::BufferUsageFlags::TRANSFER_DST, gpu_allocator::MemoryLocation::GpuToCpu, "debug snapshot")?);
                }
                let buf = shot_buffer.as_ref().unwrap().buffer;
                barrier(d, cmd, dst, 2, vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                    vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT, vk::AccessFlags2::COLOR_ATTACHMENT_WRITE,
                    vk::PipelineStageFlags2::ALL_TRANSFER, vk::AccessFlags2::TRANSFER_READ);
                let regions: Vec<_> = (0..2u32)
                    .map(|i| {
                        vk::BufferImageCopy::default()
                            .buffer_offset((i * w * h * 4) as u64)
                            .image_subresource(vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).base_array_layer(i).layer_count(1))
                            .image_extent(vk::Extent3D { width: w, height: h, depth: 1 })
                    })
                    .collect();
                d.cmd_copy_image_to_buffer(cmd, dst, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, buf, &regions);
                barrier(d, cmd, dst, 2, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL,
                    vk::PipelineStageFlags2::ALL_TRANSFER, vk::AccessFlags2::TRANSFER_READ,
                    vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT, vk::AccessFlags2::COLOR_ATTACHMENT_READ | vk::AccessFlags2::COLOR_ATTACHMENT_WRITE);
            }
            d.cmd_write_timestamp2(cmd, vk::PipelineStageFlags2::BOTTOM_OF_PIPE, queries, 2 * frame as u32 + 1);
            d.end_command_buffer(cmd)?;
        }
        sc.handle.wait_image(xr::Duration::INFINITE)?;
        unsafe { d.queue_submit(gpu.queue, &[vk::SubmitInfo::default().command_buffers(&[cmd])], fences[frame]) }?;
        queried[frame] = true;
        if capture {
            // Wait for the copy (a short hitch), then write the files in the background.
            capture = false;
            unsafe { d.wait_for_fences(&[fences[frame]], true, u64::MAX) }?;
            let pixels = shot_buffer.as_mut().unwrap().bytes()[..(2 * w * h * 4) as usize].to_vec();
            let info = debug::Info {
                time: debug::now(),
                runtime: format!("{} {}", props.runtime_name, props.runtime_version),
                size: [w, h],
                eyes: views
                    .iter()
                    .zip(&eyes)
                    .map(|(v, e)| debug::Eye {
                        stage: debug::Pose::of(pose_mat(v.pose)),
                        world: debug::Pose::of(rig.mat() * pose_mat(v.pose)),
                        fov: [v.fov.angle_left, v.fov.angle_right, v.fov.angle_up, v.fov.angle_down],
                        view_proj: e.view_proj,
                    })
                    .collect(),
                head: debug::Pose::of(head_pose),
                hands: aims.map(|a| a.map(debug::Pose::of)),
                painting_hand,
                rig_pos: rig.pos,
                rig_yaw: rig.yaw,
                tools: format!("{:#?}", painter.tools),
                panel_shown,
                gpu_ms: stats.last.0,
                fps: stats.last.1,
                late: stats.last.2,
                segments: painter.done.len() + painter.drawing.len(),
                layers: painter
                    .painting
                    .layers
                    .iter()
                    .map(|l| debug::LayerInfo { name: l.name.clone(), blend: l.blend, opacity: l.opacity, visible: l.visible, ordered: l.ordered, strokes: l.strokes.len() })
                    .collect(),
                active_layer: painter.active_index(),
                mix: painter.painting.mix,
                undo: painter.undo.len(),
                redo: painter.redo.len(),
            };
            let (dir, painting) = (debug::folder(save_to.as_deref()), painter.painting.clone());
            let bgra = sc.format == vk::Format::B8G8R8A8_SRGB;
            std::thread::spawn(move || match debug::write(&dir, &info, &pixels, bgra, &painting) {
                Ok(()) => log::info!("debug snapshot: {}", dir.display()),
                Err(e) => log::error!("debug snapshot {}: {e:#}", dir.display()),
            });
        }
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

        // Save in the background, at most every half minute, when something changed.
        if let (Some(path), Mode::Local) = (&save_to, &mode) {
            if painter.changed && saved_at.elapsed() > Duration::from_secs(30) && saving.as_ref().is_none_or(|t| t.is_finished()) {
                let (painting, path) = (painter.painting.clone(), path.clone());
                saving = Some(std::thread::spawn(move || match vdraw_core::file::save(&path, &painting) {
                    Ok(()) => log::info!("saved {}", path.display()),
                    Err(e) => log::error!("saving {}: {e:#}", path.display()),
                }));
                painter.changed = false;
                saved_at = Instant::now();
            }
        }
    }
    if let Some(t) = saving {
        let _ = t.join();
    }
    match (&save_to, &mode) {
        (Some(path), Mode::Local) => {
            vdraw_core::file::save(path, &painter.painting)?;
            log::info!("saved {}", path.display());
        }
        (_, Mode::Canvas(c)) => c.session.close(),
        _ => {}
    }

    // OpenXR lets go of the swapchain images before Vulkan objects go away.
    unsafe { d.device_wait_idle() }?;
    if let Some(mut b) = shot_buffer.take() {
        b.destroy(&gpu);
    }
    for b in &mut pick_buffers {
        b.destroy(&gpu);
    }
    drop(ui);
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
        // Transfer source too: a debug snapshot copies what was shown.
        usage_flags: xr::SwapchainUsageFlags::COLOR_ATTACHMENT | xr::SwapchainUsageFlags::TRANSFER_DST | xr::SwapchainUsageFlags::TRANSFER_SRC,
        format: format.as_raw() as u32,
        sample_count: 1,
        width,
        height,
        face_count: 1,
        array_size: 2,
        mip_count: 1,
    })?;
    let images = handle.enumerate_images()?.into_iter().map(vk::Image::from_raw).collect();
    Ok(Swapchain { handle, images, format, width, height })
}

/// A half float (IEEE 754 binary16) as an f32.
pub fn half_to_f32(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = ((h >> 10) & 0x1f) as i32;
    let mant = (h & 0x3ff) as f32;
    sign * match exp {
        0 => mant * 2f32.powi(-24),
        31 => f32::INFINITY,
        e => (1.0 + mant / 1024.0) * 2f32.powi(e - 15),
    }
}
