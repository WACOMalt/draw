//! `vdraw --snapshot out.png`: renders one frame of the demo painting without a window or a
//! headset (headless Vulkan) and writes it as a PNG. For checks and comparisons.

use crate::camera::{Orbit, perspective};
use anyhow::{Context, Result};
use ash::vk;
use gpu_allocator::MemoryLocation;
use std::sync::Arc;
use vdraw_render::raymarch::Buffer;
use vdraw_render::{EyeView, Gpu, Raymarcher};

fn f16_to_f32(h: u16) -> f32 {
    let s = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = ((h >> 10) & 0x1f) as i32;
    let m = (h & 0x3ff) as f32;
    match e {
        0 => s * m * 2f32.powi(-24),
        31 => s * f32::INFINITY,
        _ => s * (1.0 + m / 1024.0) * 2f32.powi(e - 15),
    }
}

fn srgb(x: f32) -> u8 {
    let x = x.clamp(0.0, 1.0);
    let y = if x <= 0.003_130_8 { x * 12.92 } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 };
    (y * 255.0 + 0.5) as u8
}

pub fn run(path: &str, width: u32, height: u32, painting: vdraw_core::Painting, cam: Orbit) -> Result<()> {
    let entry = unsafe { ash::Entry::load() }.context("no Vulkan loader")?;
    let instance = Gpu::create_instance(&entry, &[])?;
    let gpu = Arc::new(Gpu::new(entry, instance, &[], &|_, _| true)?);
    let mut rm = Raymarcher::new(gpu.clone())?;
    let image = rm.target(width, height, 1)?.image;

    let mut segs = Vec::new();
    painting.segments(None, &mut segs);
    let eye = EyeView { view_proj: perspective(0.9, width as f32 / height as f32, 0.02, 100.0) * cam.view(), pos: cam.eye() };

    let d = &gpu.device;
    let mut readback = Buffer::new(&gpu, (width * height * 8) as u64, vk::BufferUsageFlags::TRANSFER_DST, MemoryLocation::GpuToCpu, "readback")?;
    let pool = unsafe { d.create_command_pool(&vk::CommandPoolCreateInfo::default().queue_family_index(gpu.queue_family), None) }?;
    let cmd = unsafe { d.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).command_buffer_count(1)) }?[0];
    let t0 = std::time::Instant::now();
    unsafe {
        d.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default())?;
        rm.record(cmd, 0, &segs, &[eye], None)?;
        let region = vk::BufferImageCopy::default()
            .image_subresource(vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).layer_count(1))
            .image_extent(vk::Extent3D { width, height, depth: 1 });
        d.cmd_copy_image_to_buffer(cmd, image, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, readback.buffer, &[region]);
        d.end_command_buffer(cmd)?;
        let fence = d.create_fence(&vk::FenceCreateInfo::default(), None)?;
        d.queue_submit(gpu.queue, &[vk::SubmitInfo::default().command_buffers(&[cmd])], fence)?;
        d.wait_for_fences(&[fence], true, u64::MAX)?;
        d.destroy_fence(fence, None);
    }
    log::info!("{} segments, rendered in {:.1} ms (with the upload)", segs.len(), t0.elapsed().as_secs_f64() * 1000.0);

    let halfs: &[u16] = bytemuck::cast_slice(&readback.bytes()[..(width * height * 8) as usize]);
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for px in halfs.chunks_exact(4) {
        rgba.extend([srgb(f16_to_f32(px[0])), srgb(f16_to_f32(px[1])), srgb(f16_to_f32(px[2])), 255]);
    }
    let file = std::fs::File::create(path)?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()?.write_image_data(&rgba)?;

    readback.destroy(&gpu);
    unsafe { d.destroy_command_pool(pool, None) };
    drop(rm);
    Ok(())
}
