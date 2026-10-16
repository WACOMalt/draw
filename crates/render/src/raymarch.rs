//! The raymarch pass: uploads the segments and the eye views, then one compute dispatch writes
//! every eye into a layer of an RGBA16F image array (the target). Whoever presents (a window,
//! an OpenXR swapchain, a snapshot) copies from the target afterwards.

use crate::gpu::Gpu;
use anyhow::Result;
use ash::vk;
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use gpu_allocator::MemoryLocation;
use gpu_allocator::vulkan::{Allocation, AllocationCreateDesc, AllocationScheme};
use std::sync::Arc;
use vdraw_core::GpuSegment;

/// Frames in flight: each has its own parameter and segment buffers.
pub const FRAMES: usize = 2;
const SPIRV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/raymarch.spv"));
/// Pixels per side of a workgroup tile (`TILE` in shaders/raymarch.slang).
const TILE: u32 = 16;
pub const TARGET_FORMAT: vk::Format = vk::Format::R16G16B16A16_SFLOAT;

/// One eye: its view-projection (world to Vulkan clip space: y down, depth 0..1) and position.
#[derive(Clone, Copy, Debug)]
pub struct EyeView {
    pub view_proj: Mat4,
    pub pos: Vec3,
}

// Must match `Params` in shaders/raymarch.slang (std140).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct EyeGpu {
    inv_view_proj: [f32; 16],
    pos: [f32; 4],
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ParamsGpu {
    eyes: [EyeGpu; 2],
    seg_count: u32,
    width: u32,
    height: u32,
    pad: u32,
    brush_tip: [f32; 4],
    brush_color: [f32; 4],
}

pub struct Buffer {
    pub buffer: vk::Buffer,
    alloc: Option<Allocation>,
    pub size: u64,
}

impl Buffer {
    pub fn new(gpu: &Gpu, size: u64, usage: vk::BufferUsageFlags, location: MemoryLocation, name: &str) -> Result<Self> {
        let d = &gpu.device;
        let buffer = unsafe { d.create_buffer(&vk::BufferCreateInfo::default().size(size).usage(usage), None) }?;
        let req = unsafe { d.get_buffer_memory_requirements(buffer) };
        let alloc = gpu.allocator.lock().unwrap().allocate(&AllocationCreateDesc {
            name,
            requirements: req,
            location,
            linear: true,
            allocation_scheme: AllocationScheme::GpuAllocatorManaged,
        })?;
        unsafe { d.bind_buffer_memory(buffer, alloc.memory(), alloc.offset()) }?;
        Ok(Self { buffer, alloc: Some(alloc), size })
    }

    /// The mapped bytes (CpuToGpu / GpuToCpu buffers).
    pub fn bytes(&mut self) -> &mut [u8] {
        self.alloc.as_mut().unwrap().mapped_slice_mut().expect("buffer is not mapped")
    }

    pub fn destroy(&mut self, gpu: &Gpu) {
        if let Some(a) = self.alloc.take() {
            let _ = gpu.allocator.lock().unwrap().free(a);
            unsafe { gpu.device.destroy_buffer(self.buffer, None) };
        }
    }
}

/// The image the raymarcher writes: RGBA16F, one layer per eye.
pub struct Target {
    pub image: vk::Image,
    pub view: vk::ImageView,
    alloc: Option<Allocation>,
    pub width: u32,
    pub height: u32,
    pub layers: u32,
}

impl Target {
    fn new(gpu: &Gpu, width: u32, height: u32, layers: u32) -> Result<Self> {
        let d = &gpu.device;
        let image = unsafe {
            d.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(TARGET_FORMAT)
                    .extent(vk::Extent3D { width, height, depth: 1 })
                    .mip_levels(1)
                    .array_layers(layers)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(vk::ImageUsageFlags::STORAGE | vk::ImageUsageFlags::TRANSFER_SRC),
                None,
            )
        }?;
        let req = unsafe { d.get_image_memory_requirements(image) };
        let alloc = gpu.allocator.lock().unwrap().allocate(&AllocationCreateDesc {
            name: "raymarch target",
            requirements: req,
            location: MemoryLocation::GpuOnly,
            linear: false,
            allocation_scheme: AllocationScheme::GpuAllocatorManaged,
        })?;
        unsafe { d.bind_image_memory(image, alloc.memory(), alloc.offset()) }?;
        let view = unsafe {
            d.create_image_view(
                &vk::ImageViewCreateInfo::default()
                    .image(image)
                    .view_type(vk::ImageViewType::TYPE_2D_ARRAY)
                    .format(TARGET_FORMAT)
                    .subresource_range(color_range(layers)),
                None,
            )
        }?;
        Ok(Self { image, view, alloc: Some(alloc), width, height, layers })
    }

    fn destroy(&mut self, gpu: &Gpu) {
        if let Some(a) = self.alloc.take() {
            unsafe {
                gpu.device.destroy_image_view(self.view, None);
                gpu.device.destroy_image(self.image, None);
            }
            let _ = gpu.allocator.lock().unwrap().free(a);
        }
    }
}

pub fn color_range(layers: u32) -> vk::ImageSubresourceRange {
    vk::ImageSubresourceRange::default().aspect_mask(vk::ImageAspectFlags::COLOR).level_count(1).layer_count(layers)
}

struct Frame {
    params: Buffer,
    segments: Buffer,
    set: vk::DescriptorSet,
    /// The target view the set points at (rewritten when the target changes).
    bound_view: vk::ImageView,
}

pub struct Raymarcher {
    gpu: Arc<Gpu>,
    set_layout: vk::DescriptorSetLayout,
    layout: vk::PipelineLayout,
    pipeline: vk::Pipeline,
    pool: vk::DescriptorPool,
    frames: Vec<Frame>,
    target: Option<Target>,
}

impl Raymarcher {
    pub fn new(gpu: Arc<Gpu>) -> Result<Self> {
        let d = &gpu.device;
        let bindings = [
            vk::DescriptorSetLayoutBinding::default().binding(0).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE),
            vk::DescriptorSetLayoutBinding::default().binding(1).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE),
            vk::DescriptorSetLayoutBinding::default().binding(2).descriptor_type(vk::DescriptorType::UNIFORM_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE),
        ];
        let set_layout = unsafe { d.create_descriptor_set_layout(&vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings), None) }?;
        let layout = unsafe { d.create_pipeline_layout(&vk::PipelineLayoutCreateInfo::default().set_layouts(&[set_layout]), None) }?;
        let code = ash::util::read_spv(&mut std::io::Cursor::new(SPIRV))?;
        let module = unsafe { d.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&code), None) }?;
        let stage = vk::PipelineShaderStageCreateInfo::default().stage(vk::ShaderStageFlags::COMPUTE).module(module).name(c"main");
        let pipeline = unsafe { d.create_compute_pipelines(vk::PipelineCache::null(), &[vk::ComputePipelineCreateInfo::default().stage(stage).layout(layout)], None) }
            .map_err(|(_, e)| e)?[0];
        unsafe { d.destroy_shader_module(module, None) };

        let sizes = [
            vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_IMAGE, descriptor_count: FRAMES as u32 },
            vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_BUFFER, descriptor_count: FRAMES as u32 },
            vk::DescriptorPoolSize { ty: vk::DescriptorType::UNIFORM_BUFFER, descriptor_count: FRAMES as u32 },
        ];
        let pool = unsafe { d.create_descriptor_pool(&vk::DescriptorPoolCreateInfo::default().max_sets(FRAMES as u32).pool_sizes(&sizes), None) }?;
        let layouts = [set_layout; FRAMES];
        let sets = unsafe { d.allocate_descriptor_sets(&vk::DescriptorSetAllocateInfo::default().descriptor_pool(pool).set_layouts(&layouts)) }?;
        let mut frames = Vec::new();
        for set in sets {
            let params = Buffer::new(&gpu, size_of::<ParamsGpu>() as u64, vk::BufferUsageFlags::UNIFORM_BUFFER, MemoryLocation::CpuToGpu, "params")?;
            let segments = Buffer::new(&gpu, 1024 * size_of::<GpuSegment>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "segments")?;
            frames.push(Frame { params, segments, set, bound_view: vk::ImageView::null() });
        }
        let r = Self { gpu, set_layout, layout, pipeline, pool, frames, target: None };
        for i in 0..FRAMES {
            r.write_buffers(i);
        }
        Ok(r)
    }

    fn write_buffers(&self, i: usize) {
        let f = &self.frames[i];
        let seg = [vk::DescriptorBufferInfo::default().buffer(f.segments.buffer).range(vk::WHOLE_SIZE)];
        let par = [vk::DescriptorBufferInfo::default().buffer(f.params.buffer).range(vk::WHOLE_SIZE)];
        let writes = [
            vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(1).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&seg),
            vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(2).descriptor_type(vk::DescriptorType::UNIFORM_BUFFER).buffer_info(&par),
        ];
        unsafe { self.gpu.device.update_descriptor_sets(&writes, &[]) };
    }

    /// The target, made again when its size or layer count changes.
    pub fn target(&mut self, width: u32, height: u32, layers: u32) -> Result<&Target> {
        let same = self.target.as_ref().is_some_and(|t| t.width == width && t.height == height && t.layers == layers);
        if !same {
            unsafe { self.gpu.device.device_wait_idle() }?;
            if let Some(mut t) = self.target.take() {
                t.destroy(&self.gpu);
            }
            self.target = Some(Target::new(&self.gpu, width, height, layers)?);
        }
        Ok(self.target.as_ref().unwrap())
    }

    /// Records the raymarch of `eyes` (one per target layer) into `cmd`, for frame slot `frame`
    /// (its previous use must be finished). Leaves the target in TRANSFER_SRC_OPTIMAL.
    pub fn record(&mut self, cmd: vk::CommandBuffer, frame: usize, segments: &[GpuSegment], eyes: &[EyeView], brush_tip: Option<(Vec3, f32, [f32; 3])>) -> Result<()> {
        let target = self.target.as_ref().expect("call target() first");
        let (view, image, w, h, layers) = (target.view, target.image, target.width, target.height, target.layers);
        assert!(eyes.len() as u32 == layers && layers <= 2);

        // Segments: grow the buffer when needed.
        let need = (segments.len().max(1) * size_of::<GpuSegment>()) as u64;
        if self.frames[frame].segments.size < need {
            let gpu = self.gpu.clone();
            self.frames[frame].segments.destroy(&gpu);
            self.frames[frame].segments = Buffer::new(&gpu, need.next_power_of_two(), vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "segments")?;
            self.write_buffers(frame);
        }
        let f = &mut self.frames[frame];
        f.segments.bytes()[..segments.len() * size_of::<GpuSegment>()].copy_from_slice(bytemuck::cast_slice(segments));
        let mut p = ParamsGpu::zeroed();
        for (i, e) in eyes.iter().enumerate() {
            p.eyes[i] = EyeGpu { inv_view_proj: e.view_proj.inverse().to_cols_array(), pos: [e.pos.x, e.pos.y, e.pos.z, 1.0] };
        }
        p.seg_count = segments.len() as u32;
        p.width = w;
        p.height = h;
        if let Some((tip, r, c)) = brush_tip {
            p.brush_tip = [tip.x, tip.y, tip.z, r];
            p.brush_color = [c[0], c[1], c[2], 1.0];
        }
        f.params.bytes()[..size_of::<ParamsGpu>()].copy_from_slice(bytemuck::bytes_of(&p));
        if f.bound_view != view {
            let img = [vk::DescriptorImageInfo::default().image_view(view).image_layout(vk::ImageLayout::GENERAL)];
            let write = vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(0).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&img);
            unsafe { self.gpu.device.update_descriptor_sets(&[write], &[]) };
            f.bound_view = view;
        }

        let d = &self.gpu.device;
        unsafe {
            // Last frame's copy out of the target must finish before this frame writes it.
            barrier(d, cmd, image, layers, vk::ImageLayout::UNDEFINED, vk::ImageLayout::GENERAL,
                vk::PipelineStageFlags2::ALL_TRANSFER, vk::AccessFlags2::TRANSFER_READ,
                vk::PipelineStageFlags2::COMPUTE_SHADER, vk::AccessFlags2::SHADER_STORAGE_WRITE);
            d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.pipeline);
            d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.layout, 0, &[self.frames[frame].set], &[]);
            d.cmd_dispatch(cmd, w.div_ceil(TILE), h.div_ceil(TILE), layers);
            barrier(d, cmd, image, layers, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                vk::PipelineStageFlags2::COMPUTE_SHADER, vk::AccessFlags2::SHADER_STORAGE_WRITE,
                vk::PipelineStageFlags2::ALL_TRANSFER, vk::AccessFlags2::TRANSFER_READ);
        }
        Ok(())
    }
}

/// One image layout transition (synchronization2).
#[allow(clippy::too_many_arguments)]
pub unsafe fn barrier(
    d: &ash::Device,
    cmd: vk::CommandBuffer,
    image: vk::Image,
    layers: u32,
    old: vk::ImageLayout,
    new: vk::ImageLayout,
    src_stage: vk::PipelineStageFlags2,
    src_access: vk::AccessFlags2,
    dst_stage: vk::PipelineStageFlags2,
    dst_access: vk::AccessFlags2,
) {
    let b = [vk::ImageMemoryBarrier2::default()
        .image(image)
        .old_layout(old)
        .new_layout(new)
        .src_stage_mask(src_stage)
        .src_access_mask(src_access)
        .dst_stage_mask(dst_stage)
        .dst_access_mask(dst_access)
        .subresource_range(color_range(layers))];
    unsafe { d.cmd_pipeline_barrier2(cmd, &vk::DependencyInfo::default().image_memory_barriers(&b)) };
}

impl Drop for Raymarcher {
    fn drop(&mut self) {
        let gpu = self.gpu.clone();
        unsafe {
            let _ = gpu.device.device_wait_idle();
            for f in &mut self.frames {
                f.params.destroy(&gpu);
                f.segments.destroy(&gpu);
            }
            if let Some(mut t) = self.target.take() {
                t.destroy(&gpu);
            }
            gpu.device.destroy_descriptor_pool(self.pool, None);
            gpu.device.destroy_pipeline(self.pipeline, None);
            gpu.device.destroy_pipeline_layout(self.layout, None);
            gpu.device.destroy_descriptor_set_layout(self.set_layout, None);
        }
    }
}
