//! The canvas on a wall: its flat layers composited from their strokes into an image with
//! mipmaps (shaders/bake.slang), which the raymarcher samples every frame. The strokes stay
//! the truth: the image is a cache, made again when they change (as the 2D app caches tiles).

use crate::gpu::Gpu;
use crate::raymarch::Buffer;
use anyhow::Result;
use ash::vk;
use bytemuck::{Pod, Zeroable};
use gpu_allocator::MemoryLocation;
use gpu_allocator::vulkan::{Allocation, AllocationCreateDesc, AllocationScheme};
use vdraw_core::{Canvas, FlatData};

const SPIRV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/bake.spv"));
/// sRGB values, premultiplied, kept as they are (not decoded on sampling): the 2D app
/// composites and filters in sRGB.
pub const CANVAS_FORMAT: vk::Format = vk::Format::R8G8B8A8_UNORM;
/// The image's longer side, texels.
const LONG_SIDE: u32 = 4096;

// Must match `Params` in shaders/bake.slang.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct BakeParams {
    lo: [f32; 2],
    hi: [f32; 2],
    size: [u32; 2],
    layers: u32,
    pad: u32,
    paper: [f32; 4],
}

pub struct CanvasImage {
    pub image: vk::Image,
    pub view: vk::ImageView,
    alloc: Option<Allocation>,
}

impl CanvasImage {
    pub fn destroy(&mut self, gpu: &Gpu) {
        if let Some(a) = self.alloc.take() {
            unsafe {
                gpu.device.destroy_image_view(self.view, None);
                gpu.device.destroy_image(self.image, None);
            }
            let _ = gpu.allocator.lock().unwrap().free(a);
        }
    }
}

fn range(base: u32, levels: u32) -> vk::ImageSubresourceRange {
    vk::ImageSubresourceRange::default().aspect_mask(vk::ImageAspectFlags::COLOR).base_mip_level(base).level_count(levels).layer_count(1)
}

fn make_image(gpu: &Gpu, width: u32, height: u32, levels: u32) -> Result<CanvasImage> {
    let d = &gpu.device;
    let image = unsafe {
        d.create_image(
            &vk::ImageCreateInfo::default()
                .image_type(vk::ImageType::TYPE_2D)
                .format(CANVAS_FORMAT)
                .extent(vk::Extent3D { width, height, depth: 1 })
                .mip_levels(levels)
                .array_layers(1)
                .samples(vk::SampleCountFlags::TYPE_1)
                .tiling(vk::ImageTiling::OPTIMAL)
                .usage(vk::ImageUsageFlags::STORAGE | vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_SRC | vk::ImageUsageFlags::TRANSFER_DST),
            None,
        )
    }?;
    let req = unsafe { d.get_image_memory_requirements(image) };
    let alloc = gpu.allocator.lock().unwrap().allocate(&AllocationCreateDesc {
        name: "canvas",
        requirements: req,
        location: MemoryLocation::GpuOnly,
        linear: false,
        allocation_scheme: AllocationScheme::GpuAllocatorManaged,
    })?;
    unsafe { d.bind_image_memory(image, alloc.memory(), alloc.offset()) }?;
    let view = unsafe { d.create_image_view(&vk::ImageViewCreateInfo::default().image(image).view_type(vk::ImageViewType::TYPE_2D).format(CANVAS_FORMAT).subresource_range(range(0, levels)), None) }?;
    Ok(CanvasImage { image, view, alloc: Some(alloc) })
}

/// Records one image barrier (synchronization2) for some mip levels.
#[allow(clippy::too_many_arguments)]
fn barrier(d: &ash::Device, cmd: vk::CommandBuffer, image: vk::Image, r: vk::ImageSubresourceRange, old: vk::ImageLayout, new: vk::ImageLayout, src: (vk::PipelineStageFlags2, vk::AccessFlags2), dst: (vk::PipelineStageFlags2, vk::AccessFlags2)) {
    let b = [vk::ImageMemoryBarrier2::default()
        .image(image)
        .old_layout(old)
        .new_layout(new)
        .src_stage_mask(src.0)
        .src_access_mask(src.1)
        .dst_stage_mask(dst.0)
        .dst_access_mask(dst.1)
        .subresource_range(r)];
    unsafe { d.cmd_pipeline_barrier2(cmd, &vk::DependencyInfo::default().image_memory_barriers(&b)) };
}

/// Runs `record` in a one-time command buffer and waits for it.
fn one_time(gpu: &Gpu, record: impl FnOnce(vk::CommandBuffer)) -> Result<()> {
    let d = &gpu.device;
    unsafe {
        let pool = d.create_command_pool(&vk::CommandPoolCreateInfo::default().queue_family_index(gpu.queue_family), None)?;
        let cmd = d.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).command_buffer_count(1))?[0];
        d.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT))?;
        record(cmd);
        d.end_command_buffer(cmd)?;
        let fence = d.create_fence(&vk::FenceCreateInfo::default(), None)?;
        d.queue_submit(gpu.queue, &[vk::SubmitInfo::default().command_buffers(&[cmd])], fence)?;
        d.wait_for_fences(&[fence], true, u64::MAX)?;
        d.destroy_fence(fence, None);
        d.destroy_command_pool(pool, None);
    }
    Ok(())
}

/// A 1x1 transparent canvas, for when there is none (the binding must hold an image).
pub fn empty(gpu: &Gpu) -> Result<CanvasImage> {
    let img = make_image(gpu, 1, 1, 1)?;
    let d = &gpu.device;
    one_time(gpu, |cmd| unsafe {
        use vk::{AccessFlags2 as A, ImageLayout as L, PipelineStageFlags2 as S};
        barrier(d, cmd, img.image, range(0, 1), L::UNDEFINED, L::TRANSFER_DST_OPTIMAL, (S::NONE, A::NONE), (S::ALL_TRANSFER, A::TRANSFER_WRITE));
        d.cmd_clear_color_image(cmd, img.image, L::TRANSFER_DST_OPTIMAL, &vk::ClearColorValue { float32: [0.0; 4] }, &[range(0, 1)]);
        barrier(d, cmd, img.image, range(0, 1), L::TRANSFER_DST_OPTIMAL, L::SHADER_READ_ONLY_OPTIMAL, (S::ALL_TRANSFER, A::TRANSFER_WRITE), (S::COMPUTE_SHADER, A::SHADER_SAMPLED_READ));
    })?;
    Ok(img)
}

/// Composites the canvas's flat layers into a new image (the longer side LONG_SIDE texels),
/// with its mip chain, ready to sample. Waits for the GPU.
pub fn bake(gpu: &Gpu, canvas: &Canvas, data: &FlatData) -> Result<CanvasImage> {
    let d = &gpu.device;
    let size = canvas.max - canvas.min;
    let (width, height) = if size.x >= size.y {
        (LONG_SIDE, ((LONG_SIDE as f32 * size.y / size.x).round() as u32).max(1))
    } else {
        (((LONG_SIDE as f32 * size.x / size.y).round() as u32).max(1), LONG_SIDE)
    };
    let levels = u32::BITS - width.max(height).leading_zeros();
    let img = make_image(gpu, width, height, levels)?;

    // The flat layers and the parameters.
    let parts: [&[u8]; 5] = [
        bytemuck::cast_slice(&data.segments),
        bytemuck::cast_slice(&data.chunks),
        bytemuck::cast_slice(&data.layers),
        bytemuck::cast_slice(&data.cells),
        bytemuck::cast_slice(&data.items),
    ];
    let mut buffers = Vec::new();
    for bytes in parts {
        let mut b = Buffer::new(gpu, (bytes.len() as u64).max(16), vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "flat")?;
        b.bytes()[..bytes.len()].copy_from_slice(bytes);
        buffers.push(b);
    }
    let paper = canvas.paper.map_or([0.0; 4], |p| [p[0], p[1], p[2], 1.0]);
    let params = BakeParams { lo: canvas.min.into(), hi: canvas.max.into(), size: [width, height], layers: data.layers.len() as u32, pad: 0, paper };
    let mut pbuf = Buffer::new(gpu, size_of::<BakeParams>() as u64, vk::BufferUsageFlags::UNIFORM_BUFFER, MemoryLocation::CpuToGpu, "bake params")?;
    pbuf.bytes()[..size_of::<BakeParams>()].copy_from_slice(bytemuck::bytes_of(&params));

    // The pipeline, for this one bake.
    let storage = |b: u32| vk::DescriptorSetLayoutBinding::default().binding(b).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE);
    let bindings = [
        vk::DescriptorSetLayoutBinding::default().binding(0).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE),
        storage(1),
        storage(2),
        storage(3),
        storage(4),
        storage(5),
        vk::DescriptorSetLayoutBinding::default().binding(6).descriptor_type(vk::DescriptorType::UNIFORM_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE),
    ];
    unsafe {
        let set_layout = d.create_descriptor_set_layout(&vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings), None)?;
        let layout = d.create_pipeline_layout(&vk::PipelineLayoutCreateInfo::default().set_layouts(&[set_layout]), None)?;
        let code = ash::util::read_spv(&mut std::io::Cursor::new(SPIRV))?;
        let module = d.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&code), None)?;
        let stage = vk::PipelineShaderStageCreateInfo::default().stage(vk::ShaderStageFlags::COMPUTE).module(module).name(c"main");
        let pipeline = d.create_compute_pipelines(vk::PipelineCache::null(), &[vk::ComputePipelineCreateInfo::default().stage(stage).layout(layout)], None).map_err(|(_, e)| e)?[0];
        d.destroy_shader_module(module, None);
        let sizes = [
            vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_IMAGE, descriptor_count: 1 },
            vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_BUFFER, descriptor_count: 5 },
            vk::DescriptorPoolSize { ty: vk::DescriptorType::UNIFORM_BUFFER, descriptor_count: 1 },
        ];
        let pool = d.create_descriptor_pool(&vk::DescriptorPoolCreateInfo::default().max_sets(1).pool_sizes(&sizes), None)?;
        let set = d.allocate_descriptor_sets(&vk::DescriptorSetAllocateInfo::default().descriptor_pool(pool).set_layouts(&[set_layout]))?[0];
        let level0 = d.create_image_view(&vk::ImageViewCreateInfo::default().image(img.image).view_type(vk::ImageViewType::TYPE_2D).format(CANVAS_FORMAT).subresource_range(range(0, 1)), None)?;
        let image_info = [vk::DescriptorImageInfo::default().image_view(level0).image_layout(vk::ImageLayout::GENERAL)];
        let infos: Vec<[vk::DescriptorBufferInfo; 1]> = buffers.iter().map(|b| [vk::DescriptorBufferInfo::default().buffer(b.buffer).range(vk::WHOLE_SIZE)]).collect();
        let pinfo = [vk::DescriptorBufferInfo::default().buffer(pbuf.buffer).range(vk::WHOLE_SIZE)];
        let mut writes = vec![vk::WriteDescriptorSet::default().dst_set(set).dst_binding(0).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&image_info)];
        for (i, info) in infos.iter().enumerate() {
            writes.push(vk::WriteDescriptorSet::default().dst_set(set).dst_binding(1 + i as u32).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(info));
        }
        writes.push(vk::WriteDescriptorSet::default().dst_set(set).dst_binding(6).descriptor_type(vk::DescriptorType::UNIFORM_BUFFER).buffer_info(&pinfo));
        d.update_descriptor_sets(&writes, &[]);

        let t0 = std::time::Instant::now();
        let corner = |l: u32| vk::Offset3D { x: (width >> l).max(1) as i32, y: (height >> l).max(1) as i32, z: 1 };
        let layers = |l: u32| vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).mip_level(l).layer_count(1);
        one_time(gpu, |cmd| {
            use vk::{AccessFlags2 as A, ImageLayout as L, PipelineStageFlags2 as S};
            barrier(d, cmd, img.image, range(0, levels), L::UNDEFINED, L::GENERAL, (S::NONE, A::NONE), (S::COMPUTE_SHADER, A::SHADER_STORAGE_WRITE));
            d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, pipeline);
            d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, layout, 0, &[set], &[]);
            d.cmd_dispatch(cmd, width.div_ceil(8), height.div_ceil(8), 1);
            // The mip chain: each level a linear blit of the one above.
            barrier(d, cmd, img.image, range(0, 1), L::GENERAL, L::TRANSFER_SRC_OPTIMAL, (S::COMPUTE_SHADER, A::SHADER_STORAGE_WRITE), (S::ALL_TRANSFER, A::TRANSFER_READ));
            for l in 1..levels {
                barrier(d, cmd, img.image, range(l, 1), L::GENERAL, L::TRANSFER_DST_OPTIMAL, (S::NONE, A::NONE), (S::ALL_TRANSFER, A::TRANSFER_WRITE));
                let blit = vk::ImageBlit::default().src_subresource(layers(l - 1)).src_offsets([vk::Offset3D::default(), corner(l - 1)]).dst_subresource(layers(l)).dst_offsets([vk::Offset3D::default(), corner(l)]);
                d.cmd_blit_image(cmd, img.image, L::TRANSFER_SRC_OPTIMAL, img.image, L::TRANSFER_DST_OPTIMAL, &[blit], vk::Filter::LINEAR);
                barrier(d, cmd, img.image, range(l, 1), L::TRANSFER_DST_OPTIMAL, L::TRANSFER_SRC_OPTIMAL, (S::ALL_TRANSFER, A::TRANSFER_WRITE), (S::ALL_TRANSFER, A::TRANSFER_READ));
            }
            barrier(d, cmd, img.image, range(0, levels), L::TRANSFER_SRC_OPTIMAL, L::SHADER_READ_ONLY_OPTIMAL, (S::ALL_TRANSFER, A::TRANSFER_READ), (S::COMPUTE_SHADER, A::SHADER_SAMPLED_READ));
        })?;
        log::info!("canvas: {} flat segments composited into {width}x{height} in {:.0} ms", data.segments.len(), t0.elapsed().as_secs_f64() * 1000.0);

        d.destroy_image_view(level0, None);
        d.destroy_descriptor_pool(pool, None);
        d.destroy_pipeline(pipeline, None);
        d.destroy_pipeline_layout(layout, None);
        d.destroy_descriptor_set_layout(set_layout, None);
    }
    for mut b in buffers {
        b.destroy(gpu);
    }
    pbuf.destroy(gpu);
    Ok(img)
}
