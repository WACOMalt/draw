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
use vdraw_core::{Canvas, GpuChunk, GpuCluster, GpuSegment, LayerRun};

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
    chunk_count: u32,
    brush_tip: [f32; 4],
    brush_color: [f32; 4],
    brush_style: [f32; 4],
    laser_a: [f32; 4],
    laser_b: [f32; 4],
    canvas_origin: [f32; 4],
    canvas_right: [f32; 4],
    canvas_up: [f32; 4],
    canvas_max: [f32; 4],
    paper: [f32; 4],
    cluster_count: u32,
    pad2: [u32; 3],
}

/// A layer as the shader reads it: the 2D app's blend mode (its number) and the opacity.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Pod, Zeroable)]
pub struct SceneLayer {
    pub blend: u32,
    pub opacity: f32,
    /// 1: the strokes cover each other in their order, as in the 2D app.
    pub ordered: u32,
    pub pad: u32,
}

/// What to draw: the finished strokes' segments in layer runs (they change rarely: `version`
/// says when, and only then are they uploaded again), the stroke being drawn, and the layers.
pub struct Scene<'a> {
    pub segments: &'a [GpuSegment],
    pub runs: &'a [LayerRun],
    pub version: u64,
    pub active: &'a [GpuSegment],
    /// The layer the stroke being drawn goes to (its place in `layers`).
    pub active_layer: usize,
    /// Every layer of the painting, by its place (`LayerRun::layer`).
    pub layers: &'a [SceneLayer],
}

/// What is drawn over the painting: the brush tip, and the pointer's laser.
#[derive(Clone, Copy, Debug, Default)]
pub struct Overlays {
    pub tip: Option<BrushTip>,
    /// From the controller to where it points on the panel.
    pub laser: Option<(Vec3, Vec3)>,
}

/// The brush tip to draw: where the next stroke starts, and how it will look.
#[derive(Clone, Copy, Debug)]
pub struct BrushTip {
    pub pos: Vec3,
    pub radius: f32,
    pub color: [f32; 3],
    pub opacity: f32,
    pub hardness: f32,
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
        Self::image(gpu, width, height, layers, TARGET_FORMAT, vk::ImageUsageFlags::STORAGE | vk::ImageUsageFlags::TRANSFER_SRC)
    }

    /// Any color image array (with a view of all its layers), such as an sRGB image to present
    /// into. `destroy` frees it.
    pub fn image(gpu: &Gpu, width: u32, height: u32, layers: u32, format: vk::Format, usage: vk::ImageUsageFlags) -> Result<Self> {
        let d = &gpu.device;
        let image = unsafe {
            d.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(format)
                    .extent(vk::Extent3D { width, height, depth: 1 })
                    .mip_levels(1)
                    .array_layers(layers)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(usage),
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
                    .format(format)
                    .subresource_range(color_range(layers)),
                None,
            )
        }?;
        Ok(Self { image, view, alloc: Some(alloc), width, height, layers })
    }

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

pub fn color_range(layers: u32) -> vk::ImageSubresourceRange {
    vk::ImageSubresourceRange::default().aspect_mask(vk::ImageAspectFlags::COLOR).level_count(1).layer_count(layers)
}

struct Frame {
    params: Buffer,
    segments: Buffer,
    chunks: Buffer,
    /// The layers' blend modes and opacities (binding 4).
    layers: Buffer,
    /// The chunks' clusters (binding 5).
    clusters: Buffer,
    /// The version of the finished strokes in these buffers (None: none yet).
    version: Option<u64>,
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
    /// The chunks and clusters of the finished strokes, and the version they are of.
    static_chunks: Vec<GpuChunk>,
    static_clusters: Vec<GpuCluster>,
    static_version: Option<u64>,
    /// The full-chord table (binding 6), the same for every frame.
    chord: Buffer,
    /// The canvas's part of the parameters.
    canvas: [[f32; 4]; 5],
}

impl Raymarcher {
    pub fn new(gpu: Arc<Gpu>) -> Result<Self> {
        let d = &gpu.device;
        let bindings = [
            vk::DescriptorSetLayoutBinding::default().binding(0).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE),
            vk::DescriptorSetLayoutBinding::default().binding(1).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE),
            vk::DescriptorSetLayoutBinding::default().binding(3).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE),
            vk::DescriptorSetLayoutBinding::default().binding(2).descriptor_type(vk::DescriptorType::UNIFORM_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE),
        ];
        let layers_binding = vk::DescriptorSetLayoutBinding::default().binding(4).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE);
        let clusters_binding = vk::DescriptorSetLayoutBinding::default().binding(5).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE);
        let chord_binding = vk::DescriptorSetLayoutBinding::default().binding(6).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE);
        let bindings: Vec<_> = bindings.into_iter().chain([layers_binding, clusters_binding, chord_binding]).collect();
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
            vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_BUFFER, descriptor_count: 5 * FRAMES as u32 },
            vk::DescriptorPoolSize { ty: vk::DescriptorType::UNIFORM_BUFFER, descriptor_count: FRAMES as u32 },
        ];
        let pool = unsafe { d.create_descriptor_pool(&vk::DescriptorPoolCreateInfo::default().max_sets(FRAMES as u32).pool_sizes(&sizes), None) }?;
        let layouts = [set_layout; FRAMES];
        let sets = unsafe { d.allocate_descriptor_sets(&vk::DescriptorSetAllocateInfo::default().descriptor_pool(pool).set_layouts(&layouts)) }?;
        let mut frames = Vec::new();
        for set in sets {
            let params = Buffer::new(&gpu, size_of::<ParamsGpu>() as u64, vk::BufferUsageFlags::UNIFORM_BUFFER, MemoryLocation::CpuToGpu, "params")?;
            let segments = Buffer::new(&gpu, 1024 * size_of::<GpuSegment>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "segments")?;
            let chunks = Buffer::new(&gpu, 256 * size_of::<GpuChunk>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "chunks")?;
            let layers = Buffer::new(&gpu, 64 * size_of::<SceneLayer>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "layers")?;
            let clusters = Buffer::new(&gpu, 64 * size_of::<GpuCluster>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "clusters")?;
            frames.push(Frame { params, segments, chunks, layers, clusters, version: None, set, bound_view: vk::ImageView::null() });
        }
        let table = vdraw_core::chord_table();
        let mut chord = Buffer::new(&gpu, (table.len() * 4) as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "chord table")?;
        chord.bytes()[..table.len() * 4].copy_from_slice(bytemuck::cast_slice(&table));
        let r = Self { gpu, set_layout, layout, pipeline, pool, frames, target: None, static_chunks: Vec::new(), static_clusters: Vec::new(), static_version: None, chord, canvas: [[0.0; 4]; 5] };
        for i in 0..FRAMES {
            r.write_buffers(i);
        }
        Ok(r)
    }

    /// The paper on a wall behind the strokes, if any, until set again.
    pub fn set_canvas(&mut self, canvas: Option<&Canvas>) {
        self.canvas = match canvas {
            Some(c) => {
                let (o, r, u) = (c.plane.origin, c.plane.right, c.plane.up);
                let paper = c.paper.unwrap_or([0.0; 3]);
                [
                    [o.x, o.y, o.z, 1.0],
                    [r.x, r.y, r.z, c.min.x],
                    [u.x, u.y, u.z, c.min.y],
                    [c.max.x, c.max.y, 0.0, c.paper.is_some() as u32 as f32],
                    [paper[0], paper[1], paper[2], 0.0],
                ]
            }
            None => [[0.0; 4]; 5],
        };
    }

    fn write_buffers(&self, i: usize) {
        let f = &self.frames[i];
        let seg = [vk::DescriptorBufferInfo::default().buffer(f.segments.buffer).range(vk::WHOLE_SIZE)];
        let chk = [vk::DescriptorBufferInfo::default().buffer(f.chunks.buffer).range(vk::WHOLE_SIZE)];
        let par = [vk::DescriptorBufferInfo::default().buffer(f.params.buffer).range(vk::WHOLE_SIZE)];
        let lay = [vk::DescriptorBufferInfo::default().buffer(f.layers.buffer).range(vk::WHOLE_SIZE)];
        let clu = [vk::DescriptorBufferInfo::default().buffer(f.clusters.buffer).range(vk::WHOLE_SIZE)];
        let cho = [vk::DescriptorBufferInfo::default().buffer(self.chord.buffer).range(vk::WHOLE_SIZE)];
        let writes = [
            vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(6).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&cho),
            vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(5).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&clu),
            vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(4).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&lay),
            vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(1).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&seg),
            vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(3).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&chk),
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
    pub fn record(&mut self, cmd: vk::CommandBuffer, frame: usize, scene: &Scene, eyes: &[EyeView], overlays: &Overlays) -> Result<()> {
        let target = self.target.as_ref().expect("call target() first");
        let (view, image, w, h, layers) = (target.view, target.image, target.width, target.height, target.layers);
        assert!(eyes.len() as u32 == layers && layers <= 2);

        // The finished strokes' chunks, made again only when they change.
        if self.static_version != Some(scene.version) {
            self.static_chunks.clear();
            let mut run_chunks = Vec::new();
            for run in scene.runs {
                vdraw_core::chunks(&scene.segments[run.first..run.first + run.count], &mut run_chunks);
                self.static_chunks.extend(run_chunks.iter().map(|c| GpuChunk { first: c.first + run.first as u32, layer: run.layer as u32, ..*c }));
            }
            self.static_clusters.clear();
            vdraw_core::clusters(&self.static_chunks, 0, &mut self.static_clusters);
            self.static_version = Some(scene.version);
        }
        let mut active_chunks = Vec::new();
        vdraw_core::chunks(scene.active, &mut active_chunks);
        let (n_static, n_static_chunks) = (scene.segments.len(), self.static_chunks.len());
        for c in &mut active_chunks {
            c.first += n_static as u32;
            c.layer = scene.active_layer as u32;
        }
        let n_segments = n_static + scene.active.len();
        let n_chunks = n_static_chunks + active_chunks.len();
        let mut active_clusters = Vec::new();
        vdraw_core::clusters(&active_chunks, n_static_chunks as u32, &mut active_clusters);
        let n_static_clusters = self.static_clusters.len();
        let n_clusters = n_static_clusters + active_clusters.len();

        // Buffers: grow when needed (and then fill the finished strokes in again).
        let need = (n_segments.max(1) * size_of::<GpuSegment>()) as u64;
        let need_chunks = (n_chunks.max(1) * size_of::<GpuChunk>()) as u64;
        let need_layers = (scene.layers.len().max(1) * size_of::<SceneLayer>()) as u64;
        let need_clusters = (n_clusters.max(1) * size_of::<GpuCluster>()) as u64;
        {
            let gpu = self.gpu.clone();
            let f = &mut self.frames[frame];
            let mut rebind = false;
            for (buffer, need, name) in [(&mut f.segments, need, "segments"), (&mut f.chunks, need_chunks, "chunks"), (&mut f.layers, need_layers, "layers"), (&mut f.clusters, need_clusters, "clusters")] {
                if buffer.size < need {
                    buffer.destroy(&gpu);
                    *buffer = Buffer::new(&gpu, need.next_power_of_two(), vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, name)?;
                    rebind = true;
                }
            }
            if rebind {
                f.version = None;
                self.write_buffers(frame);
            }
        }
        let f = &mut self.frames[frame];
        let seg = size_of::<GpuSegment>();
        let chk = size_of::<GpuChunk>();
        if f.version != Some(scene.version) {
            f.segments.bytes()[..n_static * seg].copy_from_slice(bytemuck::cast_slice(scene.segments));
            f.chunks.bytes()[..n_static_chunks * chk].copy_from_slice(bytemuck::cast_slice(&self.static_chunks));
            f.clusters.bytes()[..n_static_clusters * size_of::<GpuCluster>()].copy_from_slice(bytemuck::cast_slice(&self.static_clusters));
            f.version = Some(scene.version);
        }
        f.segments.bytes()[n_static * seg..n_segments * seg].copy_from_slice(bytemuck::cast_slice(scene.active));
        f.chunks.bytes()[n_static_chunks * chk..n_chunks * chk].copy_from_slice(bytemuck::cast_slice(&active_chunks));
        let clu = size_of::<GpuCluster>();
        f.clusters.bytes()[n_static_clusters * clu..n_clusters * clu].copy_from_slice(bytemuck::cast_slice(&active_clusters));
        f.layers.bytes()[..scene.layers.len() * size_of::<SceneLayer>()].copy_from_slice(bytemuck::cast_slice(scene.layers));
        let (segment_count, chunk_count) = (n_segments as u32, n_chunks as u32);
        let f = &mut self.frames[frame];
        let mut p = ParamsGpu::zeroed();
        for (i, e) in eyes.iter().enumerate() {
            p.eyes[i] = EyeGpu { inv_view_proj: e.view_proj.inverse().to_cols_array(), pos: [e.pos.x, e.pos.y, e.pos.z, 1.0] };
        }
        p.seg_count = segment_count;
        p.chunk_count = chunk_count;
        p.cluster_count = n_clusters as u32;
        [p.canvas_origin, p.canvas_right, p.canvas_up, p.canvas_max, p.paper] = self.canvas;
        p.width = w;
        p.height = h;
        if let Some((a, b)) = overlays.laser {
            p.laser_a = [a.x, a.y, a.z, 0.0012];
            p.laser_b = [b.x, b.y, b.z, 0.0];
        }
        if let Some(b) = overlays.tip {
            p.brush_tip = [b.pos.x, b.pos.y, b.pos.z, b.radius];
            p.brush_color = [b.color[0], b.color[1], b.color[2], 1.0];
            p.brush_style = [b.opacity, b.hardness, 0.0, 0.0];
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
                f.chunks.destroy(&gpu);
                f.layers.destroy(&gpu);
                f.clusters.destroy(&gpu);
            }

            if let Some(mut t) = self.target.take() {
                t.destroy(&gpu);
            }
            self.chord.destroy(&gpu);
            gpu.device.destroy_descriptor_pool(self.pool, None);
            gpu.device.destroy_pipeline(self.pipeline, None);
            gpu.device.destroy_pipeline_layout(self.layout, None);
            gpu.device.destroy_descriptor_set_layout(self.set_layout, None);
        }
    }
}
