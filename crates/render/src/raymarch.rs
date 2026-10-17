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
use vdraw_core::{GpuChunk, GpuCluster, GpuSegment, LayerRun};

/// Frames in flight: each has its own parameter and segment buffers.
pub const FRAMES: usize = 2;
const SPIRV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/raymarch.spv"));
/// The same, mixing paint as paint (pigment).
const SPIRV_PIGMENT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/raymarch_pigment.spv"));
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
    eyes: [EyeGpu; 3],
    seg_count: u32,
    width: u32,
    height: u32,
    chunk_count: u32,
    brush_tip: [f32; 4],
    brush_color: [f32; 4],
    brush_style: [f32; 4],
    brush_up: [f32; 4],
    laser_a: [f32; 4],
    laser_b: [f32; 4],
    cluster_count: u32,
    line_count: u32,
    step_count: u32,
    pick_layer: u32,
    world_from_scene: [f32; 16],
    paper: [f32; 4],
    paper_grid: f32,
    pad: [f32; 3],
}

/// A compositing step as the shader reads it (vdraw_core::Step): what it is (`STEP_*`), the
/// 2D app's blend mode (its number), the opacity, and flags (`STEP_ORDERED`, ...).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Pod, Zeroable)]
pub struct SceneStep {
    pub kind: u32,
    pub blend: u32,
    pub opacity: f32,
    pub flags: u32,
}

pub const STEP_LAYER: u32 = 0;
pub const STEP_MASK: u32 = 1;
pub const STEP_OPEN: u32 = 2;
pub const STEP_CLOSE: u32 = 3;
/// The strokes cover each other in their order, as in the 2D app.
pub const STEP_ORDERED: u32 = 1;
/// Clipped to the layer below in its group.
pub const STEP_CLIP: u32 = 2;
/// A group that is not pass through: its layers make one picture, which blends.
pub const STEP_ISOLATED: u32 = 4;

/// The steps of a painting as the shader reads them.
pub fn scene_steps(painting: &vdraw_core::Painting, steps: &[vdraw_core::Step]) -> Vec<SceneStep> {
    use vdraw_core::{Blend, Step};
    steps
        .iter()
        .map(|&s| {
            let (kind, i) = match s {
                Step::Layer(i) => (STEP_LAYER, i),
                Step::Mask(i) => (STEP_MASK, i),
                Step::Open(i) => (STEP_OPEN, i),
                Step::Close(i) => (STEP_CLOSE, i),
            };
            let l = &painting.layers[i];
            let mut flags = 0;
            if l.ordered {
                flags |= STEP_ORDERED;
            }
            if l.clip && kind == STEP_LAYER {
                flags |= STEP_CLIP;
            }
            if l.group && l.blend != Blend::Pass {
                flags |= STEP_ISOLATED;
            }
            // A mask is drawn plainly (its luminance is what counts).
            let (blend, opacity) = if kind == STEP_MASK { (0, 1.0) } else { (if l.blend == Blend::Pass { 0 } else { l.blend as u32 }, l.opacity) };
            SceneStep { kind, blend, opacity, flags }
        })
        .collect()
}

/// What to draw: the finished strokes' segments in layer runs (they change rarely: `version`
/// says when, and only then are they uploaded again), the stroke being drawn, and the layers.
pub struct Scene<'a> {
    pub segments: &'a [GpuSegment],
    pub runs: &'a [LayerRun],
    pub version: u64,
    /// Strokes being drawn (yours, and others' on a shared canvas), made every frame: their
    /// segments, and the runs of them by step (`first` is a place in `active`).
    pub active: &'a [GpuSegment],
    pub active_runs: &'a [LayerRun],
    /// The compositing steps (`LayerRun::step` is a place here).
    pub steps: &'a [SceneStep],
    /// Paint mixes as paint (vdraw_core::Mix::Pigment), not as light.
    pub pigment: bool,
    /// Where the scene (the strokes, and the eyes given to `record`) is in the room, where the
    /// sky and the floor are: identity for a painting in the room; a shared canvas's view.
    pub world_from_scene: Mat4,
    /// A shared canvas's paper: the plane z = 0 of the scene, under every layer, in sRGB with
    /// its alpha (alpha 0 and no grid: no paper). `paper_grid`: how much a grid on it shows
    /// (where the paper is see-through, it shows the plane while the canvas moves).
    pub paper: [f32; 4],
    pub paper_grid: f32,
}

/// What is drawn over the painting: the brush tip, the pointer's laser, and lines.
#[derive(Clone, Copy, Debug, Default)]
pub struct Overlays<'a> {
    pub tip: Option<BrushTip>,
    /// From the controller to where it points on the panel.
    pub laser: Option<(Vec3, Vec3)>,
    /// Lines over everything (the stroke eraser's marks). At most `MAX_LINES` show per tile.
    pub lines: &'a [OverlayLine],
    /// The eyedropper's view: drawn into the target's layer after the eyes', only its first
    /// tile (see `Raymarcher::pick_layer`; the ray through its top-left pixel is the pick).
    pub pick: Option<EyeView>,
}

/// A line drawn over the painting, as the 2D app draws stroke paths: from `a` to `b` (xyz), a
/// line `a[3]` pixels wide in `color` over a dark halo `b[3]` pixels wide in `halo` (linear
/// rgb, and how much each covers).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct OverlayLine {
    pub a: [f32; 4],
    pub b: [f32; 4],
    pub color: [f32; 4],
    pub halo: [f32; 4],
}

/// Overlay lines a tile keeps (`MAX_LINES` in shaders/raymarch.slang).
pub const MAX_LINES: usize = 256;

/// The brush tip to draw: where the next stroke starts, and how it will look.
#[derive(Clone, Copy, Debug)]
pub struct BrushTip {
    pub pos: Vec3,
    pub radius: f32,
    pub color: [f32; 3],
    pub opacity: f32,
    pub hardness: f32,
    /// The pen's up direction, and the tip's roundness (it is flattened along `up`).
    pub up: Vec3,
    pub roundness: f32,
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
    /// The compositing steps (binding 4).
    layers: Buffer,
    /// The chunks' clusters (binding 5).
    clusters: Buffer,
    /// The overlay lines (binding 8).
    lines: Buffer,
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
    /// The raymarcher that mixes paint as paint.
    pigment: vk::Pipeline,
    pool: vk::DescriptorPool,
    frames: Vec<Frame>,
    target: Option<Target>,
    /// The chunks and clusters of the finished strokes, and the version they are of.
    static_chunks: Vec<GpuChunk>,
    static_clusters: Vec<GpuCluster>,
    static_version: Option<u64>,
    /// The full-chord table (binding 6), the same for every frame.
    chord: Buffer,
    /// The trail table as a 3D texture (binding 7), filtered by the sampler.
    trail: TrailTexture,
}

/// vdraw_core::trail_table in a 3D texture (x: length, y: distance, z: hardness), so a lookup
/// is one filtered sample.
struct TrailTexture {
    image: vk::Image,
    view: vk::ImageView,
    sampler: vk::Sampler,
    alloc: Option<Allocation>,
}

/// To half floats (the table's values are small and positive).
fn half(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mant = bits & 0x7f_ffff;
    if exp <= 0 {
        if exp < -10 { sign } else { sign | (((mant | 0x80_0000) >> (14 - exp)) as u16) }
    } else if exp >= 31 {
        sign | 0x7c00
    } else {
        sign | (((exp as u32) << 10 | mant >> 13) + ((mant >> 12) & 1)) as u16
    }
}

impl TrailTexture {
    fn new(gpu: &Gpu) -> Result<Self> {
        use vdraw_core::{KH, KQ, KV};
        let d = &gpu.device;
        let format = vk::Format::R16_SFLOAT;
        let extent = vk::Extent3D { width: KV as u32, height: KQ as u32, depth: KH as u32 };
        let image = unsafe {
            d.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_3D)
                    .format(format)
                    .extent(extent)
                    .mip_levels(1)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST),
                None,
            )
        }?;
        let req = unsafe { d.get_image_memory_requirements(image) };
        let alloc = gpu.allocator.lock().unwrap().allocate(&AllocationCreateDesc {
            name: "trail table",
            requirements: req,
            location: MemoryLocation::GpuOnly,
            linear: false,
            allocation_scheme: AllocationScheme::GpuAllocatorManaged,
        })?;
        unsafe { d.bind_image_memory(image, alloc.memory(), alloc.offset()) }?;
        let range = vk::ImageSubresourceRange::default().aspect_mask(vk::ImageAspectFlags::COLOR).level_count(1).layer_count(1);
        let view = unsafe { d.create_image_view(&vk::ImageViewCreateInfo::default().image(image).view_type(vk::ImageViewType::TYPE_3D).format(format).subresource_range(range), None) }?;
        let sampler = unsafe {
            d.create_sampler(
                &vk::SamplerCreateInfo::default()
                    .mag_filter(vk::Filter::LINEAR)
                    .min_filter(vk::Filter::LINEAR)
                    .address_mode_u(vk::SamplerAddressMode::CLAMP_TO_EDGE)
                    .address_mode_v(vk::SamplerAddressMode::CLAMP_TO_EDGE)
                    .address_mode_w(vk::SamplerAddressMode::CLAMP_TO_EDGE),
                None,
            )
        }?;
        // Upload through a staging buffer, and wait.
        let data: Vec<u16> = vdraw_core::trail_table().into_iter().map(half).collect();
        let mut staging = Buffer::new(gpu, (data.len() * 2) as u64, vk::BufferUsageFlags::TRANSFER_SRC, MemoryLocation::CpuToGpu, "trail staging")?;
        staging.bytes()[..data.len() * 2].copy_from_slice(bytemuck::cast_slice(&data));
        unsafe {
            let pool = d.create_command_pool(&vk::CommandPoolCreateInfo::default().queue_family_index(gpu.queue_family).flags(vk::CommandPoolCreateFlags::TRANSIENT), None)?;
            let cmd = d.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).command_buffer_count(1))?[0];
            d.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT))?;
            use vk::{AccessFlags2 as A, ImageLayout as L, PipelineStageFlags2 as S};
            let barrier = |old, new, src_stage, src_access, dst_stage, dst_access| {
                let b = [vk::ImageMemoryBarrier2::default()
                    .image(image)
                    .old_layout(old)
                    .new_layout(new)
                    .src_stage_mask(src_stage)
                    .src_access_mask(src_access)
                    .dst_stage_mask(dst_stage)
                    .dst_access_mask(dst_access)
                    .subresource_range(range)];
                d.cmd_pipeline_barrier2(cmd, &vk::DependencyInfo::default().image_memory_barriers(&b));
            };
            barrier(L::UNDEFINED, L::TRANSFER_DST_OPTIMAL, S::NONE, A::NONE, S::ALL_TRANSFER, A::TRANSFER_WRITE);
            let layers = vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).layer_count(1);
            d.cmd_copy_buffer_to_image(cmd, staging.buffer, image, L::TRANSFER_DST_OPTIMAL, &[vk::BufferImageCopy::default().image_subresource(layers).image_extent(extent)]);
            barrier(L::TRANSFER_DST_OPTIMAL, L::SHADER_READ_ONLY_OPTIMAL, S::ALL_TRANSFER, A::TRANSFER_WRITE, S::COMPUTE_SHADER, A::SHADER_SAMPLED_READ);
            d.end_command_buffer(cmd)?;
            d.queue_submit(gpu.queue, &[vk::SubmitInfo::default().command_buffers(&[cmd])], vk::Fence::null())?;
            d.queue_wait_idle(gpu.queue)?;
            d.destroy_command_pool(pool, None);
        }
        staging.destroy(gpu);
        Ok(Self { image, view, sampler, alloc: Some(alloc) })
    }

    fn destroy(&mut self, gpu: &Gpu) {
        if let Some(a) = self.alloc.take() {
            unsafe {
                gpu.device.destroy_sampler(self.sampler, None);
                gpu.device.destroy_image_view(self.view, None);
                gpu.device.destroy_image(self.image, None);
            }
            let _ = gpu.allocator.lock().unwrap().free(a);
        }
    }
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
        let trail_binding = vk::DescriptorSetLayoutBinding::default().binding(7).descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE);
        let lines_binding = vk::DescriptorSetLayoutBinding::default().binding(8).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).descriptor_count(1).stage_flags(vk::ShaderStageFlags::COMPUTE);
        let bindings: Vec<_> = bindings.into_iter().chain([layers_binding, clusters_binding, chord_binding, trail_binding, lines_binding]).collect();
        let set_layout = unsafe { d.create_descriptor_set_layout(&vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings), None) }?;
        let layout = unsafe { d.create_pipeline_layout(&vk::PipelineLayoutCreateInfo::default().set_layouts(&[set_layout]), None) }?;
        let compile = |spirv: &[u8]| -> Result<vk::Pipeline> {
            let code = ash::util::read_spv(&mut std::io::Cursor::new(spirv))?;
            let module = unsafe { d.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&code), None) }?;
            let stage = vk::PipelineShaderStageCreateInfo::default().stage(vk::ShaderStageFlags::COMPUTE).module(module).name(c"main");
            // Dispatch base: the eyedropper's view is one workgroup at a layer of its own.
            let info = vk::ComputePipelineCreateInfo::default().stage(stage).layout(layout).flags(vk::PipelineCreateFlags::DISPATCH_BASE);
            let pipeline = unsafe { d.create_compute_pipelines(vk::PipelineCache::null(), &[info], None) }
                .map_err(|(_, e)| e)?[0];
            unsafe { d.destroy_shader_module(module, None) };
            Ok(pipeline)
        };
        let pipeline = compile(SPIRV)?;
        let pigment = compile(SPIRV_PIGMENT)?;

        let sizes = [
            vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_IMAGE, descriptor_count: FRAMES as u32 },
            vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_BUFFER, descriptor_count: 6 * FRAMES as u32 },
            vk::DescriptorPoolSize { ty: vk::DescriptorType::UNIFORM_BUFFER, descriptor_count: FRAMES as u32 },
            vk::DescriptorPoolSize { ty: vk::DescriptorType::COMBINED_IMAGE_SAMPLER, descriptor_count: FRAMES as u32 },
        ];
        let pool = unsafe { d.create_descriptor_pool(&vk::DescriptorPoolCreateInfo::default().max_sets(FRAMES as u32).pool_sizes(&sizes), None) }?;
        let layouts = [set_layout; FRAMES];
        let sets = unsafe { d.allocate_descriptor_sets(&vk::DescriptorSetAllocateInfo::default().descriptor_pool(pool).set_layouts(&layouts)) }?;
        let mut frames = Vec::new();
        for set in sets {
            let params = Buffer::new(&gpu, size_of::<ParamsGpu>() as u64, vk::BufferUsageFlags::UNIFORM_BUFFER, MemoryLocation::CpuToGpu, "params")?;
            let segments = Buffer::new(&gpu, 1024 * size_of::<GpuSegment>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "segments")?;
            let chunks = Buffer::new(&gpu, 256 * size_of::<GpuChunk>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "chunks")?;
            let layers = Buffer::new(&gpu, 64 * size_of::<SceneStep>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "steps")?;
            let clusters = Buffer::new(&gpu, 64 * size_of::<GpuCluster>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "clusters")?;
            let lines = Buffer::new(&gpu, 64 * size_of::<OverlayLine>() as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "overlay lines")?;
            frames.push(Frame { params, segments, chunks, layers, clusters, lines, version: None, set, bound_view: vk::ImageView::null() });
        }
        let table = vdraw_core::chord_table();
        let mut chord = Buffer::new(&gpu, (table.len() * 4) as u64, vk::BufferUsageFlags::STORAGE_BUFFER, MemoryLocation::CpuToGpu, "chord table")?;
        chord.bytes()[..table.len() * 4].copy_from_slice(bytemuck::cast_slice(&table));
        let trail = TrailTexture::new(&gpu)?;
        let r = Self { gpu, set_layout, layout, pipeline, pigment, pool, frames, target: None, static_chunks: Vec::new(), static_clusters: Vec::new(), static_version: None, chord, trail };
        for i in 0..FRAMES {
            r.write_buffers(i);
        }
        Ok(r)
    }

    fn write_buffers(&self, i: usize) {
        let f = &self.frames[i];
        let seg = [vk::DescriptorBufferInfo::default().buffer(f.segments.buffer).range(vk::WHOLE_SIZE)];
        let chk = [vk::DescriptorBufferInfo::default().buffer(f.chunks.buffer).range(vk::WHOLE_SIZE)];
        let par = [vk::DescriptorBufferInfo::default().buffer(f.params.buffer).range(vk::WHOLE_SIZE)];
        let lay = [vk::DescriptorBufferInfo::default().buffer(f.layers.buffer).range(vk::WHOLE_SIZE)];
        let clu = [vk::DescriptorBufferInfo::default().buffer(f.clusters.buffer).range(vk::WHOLE_SIZE)];
        let cho = [vk::DescriptorBufferInfo::default().buffer(self.chord.buffer).range(vk::WHOLE_SIZE)];
        let lin = [vk::DescriptorBufferInfo::default().buffer(f.lines.buffer).range(vk::WHOLE_SIZE)];
        let tra = [vk::DescriptorImageInfo::default().sampler(self.trail.sampler).image_view(self.trail.view).image_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)];
        let writes = [
            vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(7).descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER).image_info(&tra),
            vk::WriteDescriptorSet::default().dst_set(f.set).dst_binding(8).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&lin),
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
        // The eyes, one per layer; with an eyedropper's view, a layer more.
        let pick = overlays.pick.filter(|_| layers as usize == eyes.len() + 1);
        assert!((eyes.len() as u32 == layers || eyes.len() as u32 + 1 == layers) && eyes.len() <= 2);

        // The finished strokes' chunks, made again only when they change.
        if self.static_version != Some(scene.version) {
            self.static_chunks.clear();
            let mut run_chunks = Vec::new();
            for run in scene.runs {
                vdraw_core::chunks(&scene.segments[run.first..run.first + run.count], &mut run_chunks);
                self.static_chunks.extend(run_chunks.iter().map(|c| GpuChunk { first: c.first + run.first as u32, layer: run.step as u32, ..*c }));
            }
            self.static_clusters.clear();
            vdraw_core::clusters(&self.static_chunks, 0, &mut self.static_clusters);
            self.static_version = Some(scene.version);
        }
        let n_static = scene.segments.len();
        let mut active_chunks = Vec::new();
        let mut run_chunks = Vec::new();
        for run in scene.active_runs {
            vdraw_core::chunks(&scene.active[run.first..run.first + run.count], &mut run_chunks);
            active_chunks.extend(run_chunks.iter().map(|c| GpuChunk { first: c.first + (n_static + run.first) as u32, layer: run.step as u32, ..*c }));
        }
        let n_static_chunks = self.static_chunks.len();
        let n_segments = n_static + scene.active.len();
        let n_chunks = n_static_chunks + active_chunks.len();
        let mut active_clusters = Vec::new();
        vdraw_core::clusters(&active_chunks, n_static_chunks as u32, &mut active_clusters);
        let n_static_clusters = self.static_clusters.len();
        let n_clusters = n_static_clusters + active_clusters.len();

        // Buffers: grow when needed (and then fill the finished strokes in again).
        let need = (n_segments.max(1) * size_of::<GpuSegment>()) as u64;
        let need_chunks = (n_chunks.max(1) * size_of::<GpuChunk>()) as u64;
        let need_layers = (scene.steps.len().max(1) * size_of::<SceneStep>()) as u64;
        let need_clusters = (n_clusters.max(1) * size_of::<GpuCluster>()) as u64;
        let need_lines = (overlays.lines.len().max(1) * size_of::<OverlayLine>()) as u64;
        {
            let gpu = self.gpu.clone();
            let f = &mut self.frames[frame];
            let mut rebind = false;
            for (buffer, need, name) in [(&mut f.segments, need, "segments"), (&mut f.chunks, need_chunks, "chunks"), (&mut f.layers, need_layers, "steps"), (&mut f.clusters, need_clusters, "clusters"), (&mut f.lines, need_lines, "overlay lines")] {
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
        f.layers.bytes()[..scene.steps.len() * size_of::<SceneStep>()].copy_from_slice(bytemuck::cast_slice(scene.steps));
        f.lines.bytes()[..overlays.lines.len() * size_of::<OverlayLine>()].copy_from_slice(bytemuck::cast_slice(overlays.lines));
        let (segment_count, chunk_count) = (n_segments as u32, n_chunks as u32);
        let f = &mut self.frames[frame];
        let mut p = ParamsGpu::zeroed();
        p.pick_layer = u32::MAX;
        if let Some(e) = pick {
            p.pick_layer = eyes.len() as u32;
            p.eyes[eyes.len()] = EyeGpu { inv_view_proj: e.view_proj.inverse().to_cols_array(), pos: [e.pos.x, e.pos.y, e.pos.z, 1.0] };
        }
        for (i, e) in eyes.iter().enumerate() {
            p.eyes[i] = EyeGpu { inv_view_proj: e.view_proj.inverse().to_cols_array(), pos: [e.pos.x, e.pos.y, e.pos.z, 1.0] };
        }
        p.seg_count = segment_count;
        p.chunk_count = chunk_count;
        p.cluster_count = n_clusters as u32;
        p.line_count = overlays.lines.len() as u32;
        p.step_count = scene.steps.len() as u32;
        p.world_from_scene = scene.world_from_scene.to_cols_array();
        p.paper = scene.paper;
        p.paper_grid = scene.paper_grid;
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
            p.brush_up = [b.up.x, b.up.y, b.up.z, b.roundness];
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
            d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, if scene.pigment { self.pigment } else { self.pipeline });
            d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.layout, 0, &[self.frames[frame].set], &[]);
            d.cmd_dispatch(cmd, w.div_ceil(TILE), h.div_ceil(TILE), eyes.len() as u32);
            if pick.is_some() {
                // Only the eyedropper view's first tile.
                d.cmd_dispatch_base(cmd, 0, 0, eyes.len() as u32, 1, 1, 1);
            }
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
                f.lines.destroy(&gpu);
            }

            if let Some(mut t) = self.target.take() {
                t.destroy(&gpu);
            }
            self.chord.destroy(&gpu);
            self.trail.destroy(&gpu);
            gpu.device.destroy_descriptor_pool(self.pool, None);
            gpu.device.destroy_pipeline(self.pipeline, None);
            gpu.device.destroy_pipeline(self.pigment, None);
            gpu.device.destroy_pipeline_layout(self.layout, None);
            gpu.device.destroy_descriptor_set_layout(self.set_layout, None);
        }
    }
}
