//! `vdraw --snapshot out.png`: renders one frame of the demo painting without a window or a
//! headset (headless Vulkan) and writes it as a PNG. For checks and comparisons.

use crate::camera::{Orbit, perspective};
use anyhow::{Context, Result};
use ash::vk;
use gpu_allocator::MemoryLocation;
use std::sync::Arc;
use vdraw_render::raymarch::Buffer;
use crate::panel::{Model, Panel, Placement, Pointer};
use vdraw_render::{BrushTip, EyeView, Gpu, Overlays, PanelDraw, Raymarcher, Target, UiRenderer, barrier};

const OUT_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

/// Renders and writes the PNG. `bench` > 0: first renders that many times and logs the GPU
/// time of the raymarch (median and worst). `panel`: the brush panel in front of the camera,
/// the pointer on its Size slider, as VR draws it.
#[allow(clippy::too_many_arguments)]
pub fn run(path: &str, width: u32, height: u32, painting: vdraw_core::Painting, cam: Orbit, tip: Option<BrushTip>, bench: u32, panel: bool) -> Result<()> {
    let entry = unsafe { ash::Entry::load() }.context("no Vulkan loader")?;
    let instance = Gpu::create_instance(&entry, &[])?;
    let gpu = Arc::new(Gpu::new(entry, instance, &[], &|_, _| true)?);
    let mut rm = Raymarcher::new(gpu.clone())?;
    let image = rm.target(width, height, 1)?.image;

    let mut segs = Vec::new();
    painting.segments(None, &mut segs);
    let flat = painting.flat();
    rm.set_flat(painting.canvas.as_ref(), &flat)?;
    let eye = EyeView { view_proj: perspective(0.9, width as f32 / height as f32, 0.02, 100.0) * cam.view(), pos: cam.eye() };

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
                rm.record(cmd, 0, &segs, &[eye], &Overlays { tip, laser: None })?;
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
    if panel {
        let mut brush = vdraw_core::Brush { hardness: 0.8, ..Default::default() };
        let recent = [[0xe6, 0x4a, 0x2e], [0x31, 0xa8, 0xff], [0xf2, 0xc9, 0x4c], [0x5c, 0xb8, 0x5c], [0x9b, 0x59, 0xd0], [0x1e, 0x1e, 0x1e], [0xff, 0xff, 0xff]];
        let mut p = Panel::new(&brush);
        let (right, up, forward) = cam.axes();
        let place = Placement::centered(cam.eye() + forward * 0.45 + right * 0.12, right, -up, -forward);
        // Twice: egui lays out sizes it measured in the frame before.
        for _ in 0..2 {
            let frame = p.run(Pointer { at: Some(egui::pos2(250.0, 96.0)), pressed: false }, Model { brush: &mut brush, recent: &recent, can_undo: true, can_redo: false });
            ui.update_textures(&frame.textures)?;
            primitives = frame.primitives;
        }
        placement = Some(place);
    }
    let mut readback4 = Buffer::new(&gpu, (width * height * 4) as u64, vk::BufferUsageFlags::TRANSFER_DST, MemoryLocation::GpuToCpu, "readback")?;

    let t0 = std::time::Instant::now();
    unsafe {
        d.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default())?;
        rm.record(cmd, 0, &segs, &[eye], &Overlays { tip, laser: None })?;
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
