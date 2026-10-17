//! `vdraw --snapshot out.png`: renders one frame of the demo painting without a window or a
//! headset (headless Vulkan) and writes it as a PNG. For checks and comparisons.

use crate::camera::{Orbit, perspective};
use anyhow::{Context, Result};
use ash::vk;
use gpu_allocator::MemoryLocation;
use std::sync::Arc;
use vdraw_render::raymarch::Buffer;
use crate::panel::{Model, Panel, Placement, Pointer};
use vdraw_render::{BrushTip, EyeView, Gpu, Overlays, PanelDraw, Raymarcher, Scene, Target, UiRenderer, barrier};

const OUT_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

/// Where a snapshot looks from: an orbit camera, or an eye as VR drew it (a debug snapshot's,
/// see debug.rs).
pub enum View {
    Orbit(Orbit),
    Eye(EyeView),
}

/// Renders and writes the PNG. `bench` > 0: first renders that many times and logs the GPU
/// time of the raymarch (median and worst). `panel`: the tool panel in front of the camera, as
/// VR draws it (orbit views only). `sweep`: the stroke eraser's overlay, its ball (that radius)
/// at the orbit target.
/// A shared canvas's place and paper (the painting is in its scene).
#[derive(Clone, Copy, Debug)]
pub struct CanvasView {
    pub world_from_scene: glam::Mat4,
    pub paper: [f32; 4],
    pub grid: f32,
}

#[allow(clippy::too_many_arguments)]
pub fn run(path: &str, width: u32, height: u32, painting: vdraw_core::Painting, view: View, tip: Option<BrushTip>, bench: u32, panel: Option<(crate::tools::Tool, crate::panel::Tab)>, sweep: Option<f32>, canvas: Option<CanvasView>) -> Result<()> {
    let entry = unsafe { ash::Entry::load() }.context("no Vulkan loader")?;
    let instance = Gpu::create_instance(&entry, &[])?;
    let gpu = Arc::new(Gpu::new(entry, instance, &[], &|_, _| true)?);
    let mut rm = Raymarcher::new(gpu.clone())?;
    // VDRAW_PICK: also the eyedropper, along the orbit camera's middle ray (logged).
    let picking = std::env::var("VDRAW_PICK").is_ok() && matches!(view, View::Orbit(_));
    let image = rm.target(width, height, if picking { 2 } else { 1 })?.image;

    let mut segs = Vec::new();
    let built = painting.build(&mut segs);
    let runs = &built.runs;
    let steps = vdraw_render::scene_steps(&painting, &built.steps);
    let cv = canvas.unwrap_or(CanvasView { world_from_scene: glam::Mat4::IDENTITY, paper: [0.0; 4], grid: 0.0 });
    let scene = Scene { segments: &segs, runs, version: 0, active: &[], active_runs: &[], steps: &steps, pigment: painting.mix == vdraw_core::Mix::Pigment, world_from_scene: cv.world_from_scene, paper: cv.paper, paper_grid: cv.grid, lit: canvas.is_none() };
    let (eye, cam) = match view {
        View::Orbit(cam) => (EyeView { view_proj: perspective(0.9, width as f32 / height as f32, 0.02, 100.0) * cam.view(), pos: cam.eye() }, Some(cam)),
        View::Eye(eye) => (eye, None),
    };
    // The eye in the scene.
    let eye = EyeView { view_proj: eye.view_proj * cv.world_from_scene, pos: cv.world_from_scene.inverse().transform_point3(eye.pos) };
    // The stroke eraser's overlay, its ball (radius `sweep`) at the orbit target.
    let mut lines = Vec::new();
    if let (Some(r), Some(cam)) = (sweep, cam) {
        let hot = crate::tools::swept(&segs, runs, None, cam.target, cam.target, r, &[]);
        crate::tools::overlay(&segs, runs, None, cam.target, (r * 4.0).max(0.05), &hot, &[], &mut lines);
        log::info!("stroke eraser: {} strokes under the ball, {} lines", hot.len(), lines.len());
    }

    let d = &gpu.device;
    let mut readback = Buffer::new(&gpu, (width * height * 8) as u64, vk::BufferUsageFlags::TRANSFER_DST, MemoryLocation::GpuToCpu, "readback")?;
    let pool = unsafe { d.create_command_pool(&vk::CommandPoolCreateInfo::default().queue_family_index(gpu.queue_family).flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER), None) }?;
    let cmd = unsafe { d.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).command_buffer_count(1)) }?[0];
    if bench > 0 {
        let queries = unsafe { d.create_query_pool(&vk::QueryPoolCreateInfo::default().query_type(vk::QueryType::TIMESTAMP).query_count(2), None) }?;
        let tick_ns = unsafe { gpu.instance.get_physical_device_properties(gpu.physical) }.limits.timestamp_period as f64;
        let mut ms = Vec::new();
        for _ in 0..bench {
            unsafe {
                d.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default())?;
                d.cmd_reset_query_pool(cmd, queries, 0, 2);
                d.cmd_write_timestamp2(cmd, vk::PipelineStageFlags2::TOP_OF_PIPE, queries, 0);
                rm.record(cmd, 0, &scene, &[eye], &Overlays { tip, ..Default::default() })?;
                d.cmd_write_timestamp2(cmd, vk::PipelineStageFlags2::BOTTOM_OF_PIPE, queries, 1);
                d.end_command_buffer(cmd)?;
                let fence = d.create_fence(&vk::FenceCreateInfo::default(), None)?;
                d.queue_submit(gpu.queue, &[vk::SubmitInfo::default().command_buffers(&[cmd])], fence)?;
                d.wait_for_fences(&[fence], true, u64::MAX)?;
                d.destroy_fence(fence, None);
                let mut ts = [0u64; 2];
                d.get_query_pool_results(queries, 0, &mut ts, vk::QueryResultFlags::TYPE_64 | vk::QueryResultFlags::WAIT)?;
                ms.push((ts[1] - ts[0]) as f64 * tick_ns * 1e-6);
            }
        }
        ms.sort_by(f64::total_cmp);
        log::info!("{} segments at {width}x{height}: GPU median {:.2} ms, worst {:.2} ms ({bench} runs)", segs.len(), ms[ms.len() / 2], ms[ms.len() - 1]);
        unsafe { d.destroy_query_pool(queries, None) };
    }
    // Present as VR does: the target blitted into an sRGB image, then the panel over it.
    let mut out = Target::image(&gpu, width, height, 1, OUT_FORMAT, vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_DST | vk::ImageUsageFlags::TRANSFER_SRC)?;
    let mut ui = UiRenderer::new(gpu.clone(), OUT_FORMAT)?;
    let mut primitives = Vec::new();
    let mut placement = None;
    if let (Some((tool, tab)), Some(cam)) = (panel, cam) {
        let mut painter = crate::painter::Painter::new(painting.clone());
        painter.tools = crate::tools::Tools { tool, ..Default::default() };
        painter.tools.brush.hardness = 0.8;
        painter.tools.brush.roundness = 0.4;
        painter.tools.angle[0] = 30.0;
        let mut presets = crate::presets::Presets::default();
        presets.list.push(crate::presets::Preset { name: "Soft round".into(), eraser: false, brush: vdraw_core::Brush { radius: 0.03, hardness: 0.0, opacity: 0.6, ..Default::default() }, angle: 0.0 });
        presets.list.push(crate::presets::Preset { name: "Ink".into(), eraser: false, brush: vdraw_core::Brush { radius: 0.004, ..Default::default() }, angle: 0.0 });
        let mut palettes = crate::palettes::Palettes::default();
        palettes.create("My colors");
        for hex in ["#e64a2e", "#31a8ff", "#f2c94c", "#5cb85c"] {
            let _ = palettes.add(crate::palettes::PaletteColor { hex: hex.into(), name: None });
        }
        // A full set of recent colors (two rows), as after a while of painting.
        let base = [[0xe6, 0x4a, 0x2e], [0x31, 0xa8, 0xff], [0xf2, 0xc9, 0x4c], [0x5c, 0xb8, 0x5c], [0x9b, 0x59, 0xd0], [0x1e, 0x1e, 0x1e], [0xff, 0xff, 0xff], [0x8a, 0x5a, 0x2b], [0x2b, 0x8a, 0x8a]];
        let recent: Vec<[u8; 3]> = base.iter().chain(base.iter().rev()).copied().collect();
        painter.recent = recent;
        let mut p = Panel::new(&painter.tools.brush);
        p.tab = tab;
        if std::env::var("VDRAW_PALETTES").is_ok() {
            p.show_palettes();
        }
        // VDRAW_SHARED: as on a shared canvas (the panel's rows for one).
        painter.shared = std::env::var("VDRAW_SHARED").is_ok();
        // VDRAW_HOME: the start screen (no server asked: no account).
        p.screen = if std::env::var("VDRAW_HOME").is_ok() { crate::panel::Screen::Home } else { crate::panel::Screen::Paint };
        let mut lobby = crate::lobby::Lobby::new(vdraw_net::identity::Identity::default());
        lobby.identity.recent = vec![vdraw_net::identity::Recent { key: "K7QX-2MPD".into(), server: lobby.identity.server.clone(), at: 0.0, link: None }];
        let (right, up, forward) = cam.axes();
        let place = Placement::centered(cam.eye() + forward * 0.5, right, -up, -forward);
        // Twice: egui lays out sizes it measured in the frame before.
        for _ in 0..2 {
            let frame = p.run(Pointer { at: Some(egui::pos2(300.0, 150.0)), pressed: false, scroll: 0.0 }, Model { painter: &mut painter, palettes: &mut palettes, presets: &mut presets, lobby: &mut lobby, canvas: None });
            ui.update_textures(&frame.textures)?;
            primitives = frame.primitives;
        }
        placement = Some(place);
    }
    let mut readback4 = Buffer::new(&gpu, (width * height * 4) as u64, vk::BufferUsageFlags::TRANSFER_DST, MemoryLocation::GpuToCpu, "readback")?;

    let t0 = std::time::Instant::now();
    unsafe {
        d.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default())?;
        let pick = cam.filter(|_| picking).map(|c| EyeView { view_proj: crate::camera::pick_projection(width, height, 0.02, 100.0) * c.view(), pos: c.eye() });
        rm.record(cmd, 0, &scene, &[eye], &Overlays { tip, lines: &lines, pick, ..Default::default() })?;
        if pick.is_some() {
            let region = vk::BufferImageCopy::default()
                .image_subresource(vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).base_array_layer(1).layer_count(1))
                .image_extent(vk::Extent3D { width: 1, height: 1, depth: 1 });
            d.cmd_copy_image_to_buffer(cmd, image, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, readback.buffer, &[region]);
        }
        barrier(d, cmd, out.image, 1, vk::ImageLayout::UNDEFINED, vk::ImageLayout::TRANSFER_DST_OPTIMAL,
            vk::PipelineStageFlags2::NONE, vk::AccessFlags2::NONE, vk::PipelineStageFlags2::BLIT, vk::AccessFlags2::TRANSFER_WRITE);
        let layers = vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).layer_count(1);
        let corner = vk::Offset3D { x: width as i32, y: height as i32, z: 1 };
        let blit = vk::ImageBlit::default().src_subresource(layers).src_offsets([vk::Offset3D::default(), corner]).dst_subresource(layers).dst_offsets([vk::Offset3D::default(), corner]);
        d.cmd_blit_image(cmd, image, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, out.image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[blit], vk::Filter::NEAREST);
        barrier(d, cmd, out.image, 1, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL,
            vk::PipelineStageFlags2::BLIT, vk::AccessFlags2::TRANSFER_WRITE,
            vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT, vk::AccessFlags2::COLOR_ATTACHMENT_READ | vk::AccessFlags2::COLOR_ATTACHMENT_WRITE);
        if let Some(place) = placement {
            let m = eye.view_proj * place.model();
            ui.record(cmd, 0, out.image, width, height, 1, &[PanelDraw { clip_from_point: [m, m], primitives: &primitives }])?;
        }
        barrier(d, cmd, out.image, 1, vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
            vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT, vk::AccessFlags2::COLOR_ATTACHMENT_WRITE, vk::PipelineStageFlags2::ALL_TRANSFER, vk::AccessFlags2::TRANSFER_READ);
        let region = vk::BufferImageCopy::default().image_subresource(layers).image_extent(vk::Extent3D { width, height, depth: 1 });
        d.cmd_copy_image_to_buffer(cmd, out.image, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, readback4.buffer, &[region]);
        d.end_command_buffer(cmd)?;
        let fence = d.create_fence(&vk::FenceCreateInfo::default(), None)?;
        d.queue_submit(gpu.queue, &[vk::SubmitInfo::default().command_buffers(&[cmd])], fence)?;
        d.wait_for_fences(&[fence], true, u64::MAX)?;
        d.destroy_fence(fence, None);
    }
    log::info!("{} segments, rendered in {:.1} ms (with the upload)", segs.len(), t0.elapsed().as_secs_f64() * 1000.0);
    if picking {
        let px: [u16; 4] = bytemuck::pod_read_unaligned(&readback.bytes()[..8]);
        let [r, g, b, a] = px.map(crate::xr::half_to_f32);
        log::info!("eyedropper: linear {r:.3} {g:.3} {b:.3}, paint {a:.3}; sRGB {}", crate::palettes::to_hex(crate::panel::to_srgb([r, g, b])));
    }

    // The sRGB bytes as they are; alpha opaque.
    let mut rgba = readback4.bytes()[..(width * height * 4) as usize].to_vec();
    for px in rgba.chunks_exact_mut(4) {
        px[3] = 255;
    }
    let file = std::fs::File::create(path)?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()?.write_image_data(&rgba)?;

    readback.destroy(&gpu);
    readback4.destroy(&gpu);
    out.destroy(&gpu);
    unsafe { d.destroy_command_pool(pool, None) };
    drop(ui);
    drop(rm);
    Ok(())
}
