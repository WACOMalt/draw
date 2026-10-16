//! `vdraw --xr`: paint in VR through OpenXR (SteamVR, Monado, WiVRn).
//!
//! The runtime creates the Vulkan instance and device (XR_KHR_vulkan_enable2), so it can add
//! what its compositor needs and pick the GPU the headset is on. Each frame the raymarcher
//! writes both eyes into a two-layer RGBA16F target, and a blit copies it into the swapchain
//! (an sRGB array image, one layer per eye; the blit encodes sRGB).
//!
//! Controls (Valve Index; other controllers through the simple profile). Either hand paints;
//! the hand that painted last is the painting hand, and the brush panel floats above the
//! other one.
//!   trigger                  paint (the pull is the pressure); pointed at the panel: click
//!   B / A                    undo / redo (simple profile: menu = undo)
//!   left stick               fly where the head faces (up and down too), strafe
//!   right stick              turn in 30 degree steps (left, right), rise and sink (up, down)
//!   panel hand: stick click  hide or show the panel

use crate::camera::perspective_fov;
use crate::panel::{self, Action, Model, Panel, Placement, Pointer};
use crate::rig::{Locomotion, Rig};
use anyhow::{Context, Result, anyhow, bail};
use ash::vk::{self, Handle};
use glam::{Mat4, Quat, Vec2, Vec3};
use openxr as xr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use vdraw_core::{Brush, GpuSegment, LayerRun, Painting, Sample, Stroke};
use vdraw_render::raymarch::FRAMES;
use vdraw_render::{BrushTip, EyeView, Gpu, Overlays, PanelDraw, Raymarcher, Scene, SceneLayer, UiRenderer, barrier};

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
}

impl Stats {
    fn new() -> Self {
        Self { since: Instant::now(), frames: 0, late: 0, gpu_frames: 0, gpu_ms: 0.0 }
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
        log::info!(
            "{segments} segments, GPU {:.2} ms/frame at {width}x{height} per eye, {:.0} fps, {} late frames",
            self.gpu_ms / self.gpu_frames as f64,
            self.frames as f32 / secs,
            self.late
        );
        *self = Self::new();
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
        Ok(Self { set, aim, paint, stick, undo, redo, toggle, haptic, hands, spaces })
    }
}

/// What the hands do to the painting, frame to frame.
struct Painter {
    painting: Painting,
    /// Segments of the finished strokes in layer runs (made again only when the strokes
    /// change), and their version (counts up at each change).
    done: Vec<GpuSegment>,
    runs: Vec<LayerRun>,
    version: u64,
    /// The stroke being drawn, as segments (made every frame).
    drawing: Vec<GpuSegment>,
    redo: Vec<Stroke>,
    active: Option<(usize, Stroke)>,
    brush: Brush,
    /// Colors used, newest first (sRGB), for the panel's swatches.
    recent: Vec<[u8; 3]>,
    /// The strokes changed since the last save.
    changed: bool,
}

impl Painter {
    fn new(painting: Painting) -> Self {
        let mut p = Self {
            painting,
            done: Vec::new(),
            runs: Vec::new(),
            version: 0,
            drawing: Vec::new(),
            redo: Vec::new(),
            active: None,
            brush: Brush::default(),
            recent: Vec::new(),
            changed: false,
        };
        p.rebuild();
        p
    }

    fn rebuild(&mut self) {
        self.runs = self.painting.segments(&mut self.done);
        self.version += 1;
    }

    fn undo(&mut self) {
        if let Some(s) = self.painting.active().pop() {
            self.redo.push(s);
            self.rebuild();
            self.changed = true;
        }
    }

    fn redo(&mut self) {
        if let Some(s) = self.redo.pop() {
            self.painting.active().push(s);
            self.rebuild();
            self.changed = true;
        }
    }

    /// Puts a finished stroke into the active layer. When that layer's run is the last one (the
    /// usual case: VR strokes go to the top layer), its segments are appended; else all are
    /// made again.
    fn finish(&mut self, stroke: Stroke) {
        let layer = self.painting.active_layer();
        let id = self.painting.next_stroke();
        match self.runs.last_mut() {
            Some(run) if run.layer == layer => {
                stroke.segments(self.painting.filter, id, &mut self.done);
                run.count = self.done.len() - run.first;
                self.painting.layers[layer].strokes.push(stroke);
                self.version += 1;
            }
            _ => {
                self.painting.layers[layer].strokes.push(stroke);
                self.rebuild();
            }
        }
        self.changed = true;
        self.redo.clear();
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
                    self.finish(stroke);
                }
            }
            None if painting => {
                let c = panel::to_srgb(self.brush.color).map(|c| (c * 255.0).round() as u8);
                self.recent.retain(|&r| r != c);
                self.recent.insert(0, c);
                self.recent.truncate(panel::RECENT);
                let mut stroke = Stroke::new(self.brush);
                stroke.push(Sample { pos: tip, pressure: pull, time: t });
                self.active = Some((hand, stroke));
            }
            _ => {}
        }
    }

    /// The stroke being drawn, as segments, into `drawing`.
    fn update_drawing(&mut self) {
        self.drawing.clear();
        if let Some((_, s)) = &self.active {
            s.segments(self.painting.filter, self.painting.next_stroke(), &mut self.drawing);
        }
    }

    /// What the renderer draws this frame.
    fn scene<'a>(&'a self, layers: &'a [SceneLayer]) -> Scene<'a> {
        Scene { segments: &self.done, runs: &self.runs, version: self.version, active: &self.drawing, active_layer: self.painting.layers.len().saturating_sub(1), layers }
    }
}

/// The layers as the renderer reads them.
pub fn scene_layers(painting: &Painting) -> Vec<SceneLayer> {
    painting.layers.iter().map(|l| SceneLayer { blend: l.blend as u32, opacity: l.opacity, ordered: l.ordered as u32, pad: 0 }).collect()
}

/// Paints in VR. `save_to`: where the painting is saved, after changes (every half minute, in
/// the background) and on the way out.
pub fn run(painting: Painting, save_to: Option<PathBuf>) -> Result<()> {
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
    let mut panel = Panel::new(&painter.brush);
    let mut panel_shown = true;
    let mut ui: Option<UiRenderer> = None;

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
        // Aim pose: -z is forward; the tip is a little in front.
        let tip_of = |aim: Mat4| aim.transform_point3(Vec3::new(0.0, 0.0, -TIP_OFFSET));
        let tick = |h: usize, amplitude: f32, ms: i64| {
            let pulse = xr::HapticVibration::new().amplitude(amplitude).frequency(xr::FREQUENCY_UNSPECIFIED).duration(xr::Duration::from_nanos(ms * 1_000_000));
            input.haptic.apply_feedback(&session, input.hands[h], &pulse)
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
            painter.hand(h, t, rig.point(tip_of(aim)), if press[h] == Press::Paint { pull } else { 0.0 });
            if h == painting_hand {
                if press[h] == Press::Panel {
                    let was = click;
                    click = if click { pull > CLICK_UP } else { pull > CLICK_DOWN };
                    if click && !was {
                        tick(h, 0.3, 15)?;
                    }
                    pointer = Pointer { at: placement.and_then(|p| p.project(from, dir)), pressed: click };
                } else {
                    click = false;
                    if press[h] == Press::Off {
                        pointer = Pointer { at: on_panel.map(|(_, at)| at), pressed: false };
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
        loco.update(&mut rig, head_pose, stick(0)?, stick(1)?, dt);

        // The panel: laid out with this frame's pointer.
        let panel_frame = placement.map(|_| {
            let (can_undo, can_redo) = (!painter.painting.active().is_empty(), !painter.redo.is_empty());
            panel.run(pointer, Model { brush: &mut painter.brush, recent: &painter.recent, can_undo, can_redo })
        });
        if let Some(f) = &panel_frame {
            for action in &f.actions {
                match action {
                    Action::Undo => painter.undo(),
                    Action::Redo => painter.redo(),
                    Action::Recenter => rig = Rig::default(),
                }
            }
        }

        // The brush tip, on the painting hand, unless it points at the panel.
        let tip = aims[painting_hand].filter(|_| pointer.at.is_none()).map(|aim| BrushTip {
            pos: rig.point(tip_of(aim)),
            radius: painter.brush.radius,
            color: painter.brush.color,
            opacity: painter.brush.opacity,
            hardness: painter.brush.hardness,
        });
        painter.update_drawing();
        let layers = scene_layers(&painter.painting);

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
            rm.record(cmd, frame, &painter.scene(&layers), &eyes, &Overlays { tip, laser })?;
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
                let draw = PanelDraw { clip_from_point: [eyes[0].view_proj * model, eyes[1].view_proj * model], primitives: &f.primitives };
                ui.record(cmd, frame, dst, w, h, 2, &[draw])?;
            }
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

        // Save in the background, at most every half minute, when something changed.
        if let Some(path) = &save_to {
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
    if let Some(path) = &save_to {
        vdraw_core::file::save(path, &painter.painting)?;
        log::info!("saved {}", path.display());
    }

    // OpenXR lets go of the swapchain images before Vulkan objects go away.
    unsafe { d.device_wait_idle() }?;
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
    Ok(Swapchain { handle, images, format, width, height })
}
