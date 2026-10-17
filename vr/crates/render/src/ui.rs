//! Draws egui panels in the room, over the painting. Adapted from bs-humany's xr-viewer.
//!
//! egui's meshes are flat, in points. Each panel has a matrix per eye from its points to clip
//! space, and the meshes are drawn with it into each layer (eye) of the target image: the sRGB
//! swapchain image in VR, an sRGB image for a snapshot. Dynamic rendering, no depth: the panels
//! go over everything. egui's textures (the font atlas) are uploaded with a mip chain and
//! sampled trilinearly, so small text at arm's length does not shimmer.

use crate::gpu::Gpu;
use crate::raymarch::{Buffer, FRAMES};
use anyhow::Result;
use ash::vk;
use bytemuck::{Pod, Zeroable};
use glam::Mat4;
use gpu_allocator::MemoryLocation;
use gpu_allocator::vulkan::{Allocation, AllocationCreateDesc, AllocationScheme};
use std::collections::HashMap;
use std::sync::Arc;

const VERT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ui.vert.spv"));
const FRAG: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ui.frag.spv"));
const TEXTURE_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

/// One panel to draw: its meshes, and the matrix from its points to clip space for each eye.
pub struct PanelDraw<'a> {
    pub clip_from_point: [Mat4; 2],
    pub primitives: &'a [egui::ClippedPrimitive],
}

// Must match `Push` in shaders/ui.slang.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Push {
    clip_from_point: [f32; 16],
    clip: [f32; 4],
}

struct Texture {
    image: vk::Image,
    view: vk::ImageView,
    alloc: Option<Allocation>,
    set: vk::DescriptorSet,
    size: [usize; 2],
    levels: u32,
    /// The pixels, kept so that egui's partial updates can be patched in.
    pixels: Vec<u8>,
}

pub struct UiRenderer {
    gpu: Arc<Gpu>,
    format: vk::Format,
    set_layout: vk::DescriptorSetLayout,
    layout: vk::PipelineLayout,
    pipeline: vk::Pipeline,
    pool: vk::DescriptorPool,
    sampler: vk::Sampler,
    cmd_pool: vk::CommandPool,
    mipmapped: bool,
    textures: HashMap<egui::TextureId, Texture>,
    /// Vertex and index buffers per frame in flight.
    buffers: Vec<(Buffer, Buffer)>,
    /// A 2D view of one layer of a target image, made on first use.
    views: HashMap<(vk::Image, u32), vk::ImageView>,
}

fn range(base_level: u32, levels: u32) -> vk::ImageSubresourceRange {
    vk::ImageSubresourceRange::default().aspect_mask(vk::ImageAspectFlags::COLOR).base_mip_level(base_level).level_count(levels).layer_count(1)
}

impl UiRenderer {
    /// `format`: the target images' format (sRGB).
    pub fn new(gpu: Arc<Gpu>, format: vk::Format) -> Result<Self> {
        let d = &gpu.device;
        let features = unsafe { gpu.instance.get_physical_device_format_properties(gpu.physical, TEXTURE_FORMAT) }.optimal_tiling_features;
        let mipmapped = features.contains(vk::FormatFeatureFlags::BLIT_SRC | vk::FormatFeatureFlags::BLIT_DST | vk::FormatFeatureFlags::SAMPLED_IMAGE_FILTER_LINEAR);
        let sampler = unsafe {
            d.create_sampler(
                &vk::SamplerCreateInfo::default()
                    .mag_filter(vk::Filter::LINEAR)
                    .min_filter(vk::Filter::LINEAR)
                    .mipmap_mode(vk::SamplerMipmapMode::LINEAR)
                    .max_lod(vk::LOD_CLAMP_NONE)
                    .address_mode_u(vk::SamplerAddressMode::CLAMP_TO_EDGE)
                    .address_mode_v(vk::SamplerAddressMode::CLAMP_TO_EDGE)
                    .address_mode_w(vk::SamplerAddressMode::CLAMP_TO_EDGE),
                None,
            )
        }?;
        let binding = [vk::DescriptorSetLayoutBinding::default()
            .binding(0)
            .descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
            .descriptor_count(1)
            .stage_flags(vk::ShaderStageFlags::FRAGMENT)];
        let set_layout = unsafe { d.create_descriptor_set_layout(&vk::DescriptorSetLayoutCreateInfo::default().bindings(&binding), None) }?;
        let pool = unsafe {
            d.create_descriptor_pool(
                &vk::DescriptorPoolCreateInfo::default()
                    .flags(vk::DescriptorPoolCreateFlags::FREE_DESCRIPTOR_SET)
                    .max_sets(16)
                    .pool_sizes(&[vk::DescriptorPoolSize { ty: vk::DescriptorType::COMBINED_IMAGE_SAMPLER, descriptor_count: 16 }]),
                None,
            )
        }?;
        let push = [vk::PushConstantRange::default().stage_flags(vk::ShaderStageFlags::VERTEX | vk::ShaderStageFlags::FRAGMENT).size(size_of::<Push>() as u32)];
        let layout = unsafe { d.create_pipeline_layout(&vk::PipelineLayoutCreateInfo::default().set_layouts(&[set_layout]).push_constant_ranges(&push), None) }?;
        let pipeline = build_pipeline(d, layout, format)?;
        let cmd_pool = unsafe { d.create_command_pool(&vk::CommandPoolCreateInfo::default().queue_family_index(gpu.queue_family), None) }?;
        let mut buffers = Vec::new();
        for _ in 0..FRAMES {
            buffers.push((
                Buffer::new(&gpu, 4096 * 20, vk::BufferUsageFlags::VERTEX_BUFFER, MemoryLocation::CpuToGpu, "ui vertices")?,
                Buffer::new(&gpu, 8192 * 4, vk::BufferUsageFlags::INDEX_BUFFER, MemoryLocation::CpuToGpu, "ui indices")?,
            ));
        }
        Ok(Self { gpu, format, set_layout, layout, pipeline, pool, sampler, cmd_pool, mipmapped, textures: HashMap::new(), buffers, views: HashMap::new() })
    }

    /// Applies egui's texture changes. Uploads wait for the GPU (the font atlas changes a few
    /// times at the start, then hardly ever). Call before `record` in a frame.
    pub fn update_textures(&mut self, delta: &egui::TexturesDelta) -> Result<()> {
        for (id, change) in &delta.set {
            let (size, pixels): ([usize; 2], Vec<u8>) = match &change.image {
                egui::ImageData::Color(image) => (image.size, image.pixels.iter().flat_map(|c| c.to_array()).collect()),
                egui::ImageData::Font(image) => (image.size, image.srgba_pixels(None).flat_map(|c| c.to_array()).collect()),
            };
            match (change.pos, self.textures.get_mut(id)) {
                (Some([x, y]), Some(t)) => {
                    // A patch: into the kept pixels, then the whole texture up again.
                    for row in 0..size[1] {
                        let dst = ((y + row) * t.size[0] + x) * 4;
                        let src = row * size[0] * 4;
                        t.pixels[dst..dst + size[0] * 4].copy_from_slice(&pixels[src..src + size[0] * 4]);
                    }
                    let (image, size, levels, pixels) = (t.image, t.size, t.levels, t.pixels.clone());
                    self.upload(image, size, levels, &pixels)?;
                }
                _ => {
                    self.free(*id)?;
                    let t = self.create_texture(size, pixels)?;
                    self.upload(t.image, t.size, t.levels, &t.pixels)?;
                    self.textures.insert(*id, t);
                }
            }
        }
        for id in &delta.free {
            self.free(*id)?;
        }
        Ok(())
    }

    fn free(&mut self, id: egui::TextureId) -> Result<()> {
        if let Some(mut t) = self.textures.remove(&id) {
            unsafe { self.gpu.device.queue_wait_idle(self.gpu.queue) }?;
            self.destroy_texture(&mut t);
        }
        Ok(())
    }

    fn destroy_texture(&self, t: &mut Texture) {
        let d = &self.gpu.device;
        unsafe {
            let _ = d.free_descriptor_sets(self.pool, &[t.set]);
            d.destroy_image_view(t.view, None);
            d.destroy_image(t.image, None);
        }
        if let Some(a) = t.alloc.take() {
            let _ = self.gpu.allocator.lock().unwrap().free(a);
        }
    }

    fn create_texture(&self, size: [usize; 2], pixels: Vec<u8>) -> Result<Texture> {
        let d = &self.gpu.device;
        let largest = size[0].max(size[1]).max(1);
        let levels = if self.mipmapped { usize::BITS - largest.leading_zeros() } else { 1 };
        let image = unsafe {
            d.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(TEXTURE_FORMAT)
                    .extent(vk::Extent3D { width: size[0] as u32, height: size[1] as u32, depth: 1 })
                    .mip_levels(levels)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST | vk::ImageUsageFlags::TRANSFER_SRC),
                None,
            )
        }?;
        let req = unsafe { d.get_image_memory_requirements(image) };
        let alloc = self.gpu.allocator.lock().unwrap().allocate(&AllocationCreateDesc {
            name: "ui texture",
            requirements: req,
            location: MemoryLocation::GpuOnly,
            linear: false,
            allocation_scheme: AllocationScheme::GpuAllocatorManaged,
        })?;
        unsafe { d.bind_image_memory(image, alloc.memory(), alloc.offset()) }?;
        let view = unsafe {
            d.create_image_view(
                &vk::ImageViewCreateInfo::default().image(image).view_type(vk::ImageViewType::TYPE_2D).format(TEXTURE_FORMAT).subresource_range(range(0, levels)),
                None,
            )
        }?;
        let set = unsafe { d.allocate_descriptor_sets(&vk::DescriptorSetAllocateInfo::default().descriptor_pool(self.pool).set_layouts(&[self.set_layout])) }?[0];
        let info = [vk::DescriptorImageInfo::default().sampler(self.sampler).image_view(view).image_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)];
        unsafe {
            d.update_descriptor_sets(&[vk::WriteDescriptorSet::default().dst_set(set).descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER).image_info(&info)], &[]);
        }
        Ok(Texture { image, view, alloc: Some(alloc), set, size, levels, pixels })
    }

    /// Copies the pixels into level 0, builds the rest of the mip chain by blits, and leaves
    /// every level ready for the fragment shader. Waits for the GPU.
    fn upload(&self, image: vk::Image, size: [usize; 2], levels: u32, pixels: &[u8]) -> Result<()> {
        let gpu = &self.gpu;
        let d = &gpu.device;
        let mut staging = Buffer::new(gpu, pixels.len() as u64, vk::BufferUsageFlags::TRANSFER_SRC, MemoryLocation::CpuToGpu, "ui staging")?;
        staging.bytes()[..pixels.len()].copy_from_slice(pixels);
        let cmd = unsafe { d.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(self.cmd_pool).command_buffer_count(1)) }?[0];
        let layers = |level: u32| vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).mip_level(level).layer_count(1);
        let corner = |level: u32| vk::Offset3D { x: ((size[0] as u32) >> level).max(1) as i32, y: ((size[1] as u32) >> level).max(1) as i32, z: 1 };
        let barrier = |range: vk::ImageSubresourceRange, old, new, src_stage, src_access, dst_stage, dst_access| {
            let b = [vk::ImageMemoryBarrier2::default()
                .image(image)
                .old_layout(old)
                .new_layout(new)
                .src_stage_mask(src_stage)
                .src_access_mask(src_access)
                .dst_stage_mask(dst_stage)
                .dst_access_mask(dst_access)
                .subresource_range(range)];
            unsafe { d.cmd_pipeline_barrier2(cmd, &vk::DependencyInfo::default().image_memory_barriers(&b)) };
        };
        use vk::{AccessFlags2 as A, ImageLayout as L, PipelineStageFlags2 as S};
        unsafe {
            d.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT))?;
            barrier(range(0, levels), L::UNDEFINED, L::TRANSFER_DST_OPTIMAL, S::FRAGMENT_SHADER, A::SHADER_SAMPLED_READ, S::ALL_TRANSFER, A::TRANSFER_WRITE);
            let copy = vk::BufferImageCopy::default().image_subresource(layers(0)).image_extent(vk::Extent3D { width: size[0] as u32, height: size[1] as u32, depth: 1 });
            d.cmd_copy_buffer_to_image(cmd, staging.buffer, image, L::TRANSFER_DST_OPTIMAL, &[copy]);
            for level in 1..levels {
                let src = level - 1;
                barrier(range(src, 1), L::TRANSFER_DST_OPTIMAL, L::TRANSFER_SRC_OPTIMAL, S::ALL_TRANSFER, A::TRANSFER_WRITE, S::ALL_TRANSFER, A::TRANSFER_READ);
                let blit = vk::ImageBlit::default()
                    .src_subresource(layers(src))
                    .src_offsets([vk::Offset3D::default(), corner(src)])
                    .dst_subresource(layers(level))
                    .dst_offsets([vk::Offset3D::default(), corner(level)]);
                d.cmd_blit_image(cmd, image, L::TRANSFER_SRC_OPTIMAL, image, L::TRANSFER_DST_OPTIMAL, &[blit], vk::Filter::LINEAR);
                barrier(range(src, 1), L::TRANSFER_SRC_OPTIMAL, L::SHADER_READ_ONLY_OPTIMAL, S::ALL_TRANSFER, A::TRANSFER_READ, S::FRAGMENT_SHADER, A::SHADER_SAMPLED_READ);
            }
            barrier(range(levels - 1, 1), L::TRANSFER_DST_OPTIMAL, L::SHADER_READ_ONLY_OPTIMAL, S::ALL_TRANSFER, A::TRANSFER_WRITE, S::FRAGMENT_SHADER, A::SHADER_SAMPLED_READ);
            d.end_command_buffer(cmd)?;
            d.queue_submit(gpu.queue, &[vk::SubmitInfo::default().command_buffers(&[cmd])], vk::Fence::null())?;
            d.queue_wait_idle(gpu.queue)?;
            d.free_command_buffers(self.cmd_pool, &[cmd]);
        }
        staging.destroy(gpu);
        Ok(())
    }

    fn view(&mut self, image: vk::Image, layer: u32) -> Result<vk::ImageView> {
        if let Some(&v) = self.views.get(&(image, layer)) {
            return Ok(v);
        }
        let v = unsafe {
            self.gpu.device.create_image_view(
                &vk::ImageViewCreateInfo::default()
                    .image(image)
                    .view_type(vk::ImageViewType::TYPE_2D)
                    .format(self.format)
                    .subresource_range(range(0, 1).base_array_layer(layer)),
                None,
            )
        }?;
        self.views.insert((image, layer), v);
        Ok(v)
    }

    /// Records the panels into every layer (eye) of `image` (`width` x `height`), which must be
    /// in COLOR_ATTACHMENT_OPTIMAL. Frame slot `frame`: its previous use must be finished.
    pub fn record(&mut self, cmd: vk::CommandBuffer, frame: usize, image: vk::Image, width: u32, height: u32, eyes: u32, panels: &[PanelDraw]) -> Result<()> {
        // All meshes into this frame's buffers, growing them when needed.
        let mut verts: Vec<egui::epaint::Vertex> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let mut draws = Vec::new(); // (panel, texture, clip, first index, index count, vertex offset)
        for (p, panel) in panels.iter().enumerate() {
            for prim in panel.primitives {
                let egui::epaint::Primitive::Mesh(mesh) = &prim.primitive else { continue };
                if mesh.indices.is_empty() || !self.textures.contains_key(&mesh.texture_id) {
                    continue;
                }
                let c = prim.clip_rect;
                draws.push((p, mesh.texture_id, [c.min.x, c.min.y, c.max.x, c.max.y], indices.len() as u32, mesh.indices.len() as u32, verts.len() as i32));
                verts.extend_from_slice(&mesh.vertices);
                indices.extend_from_slice(&mesh.indices);
            }
        }
        if draws.is_empty() {
            return Ok(());
        }
        let gpu = self.gpu.clone();
        let vbytes: &[u8] = bytemuck::cast_slice(&verts);
        let ibytes: &[u8] = bytemuck::cast_slice(&indices);
        let (vb, ib) = &mut self.buffers[frame];
        if vb.size < vbytes.len() as u64 {
            vb.destroy(&gpu);
            *vb = Buffer::new(&gpu, (vbytes.len() as u64).next_power_of_two(), vk::BufferUsageFlags::VERTEX_BUFFER, MemoryLocation::CpuToGpu, "ui vertices")?;
        }
        if ib.size < ibytes.len() as u64 {
            ib.destroy(&gpu);
            *ib = Buffer::new(&gpu, (ibytes.len() as u64).next_power_of_two(), vk::BufferUsageFlags::INDEX_BUFFER, MemoryLocation::CpuToGpu, "ui indices")?;
        }
        vb.bytes()[..vbytes.len()].copy_from_slice(vbytes);
        ib.bytes()[..ibytes.len()].copy_from_slice(ibytes);
        let (vbuf, ibuf) = (vb.buffer, ib.buffer);

        let d = &gpu.device;
        for eye in 0..eyes {
            let view = self.view(image, eye)?;
            let attachment = [vk::RenderingAttachmentInfo::default()
                .image_view(view)
                .image_layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL)
                .load_op(vk::AttachmentLoadOp::LOAD)
                .store_op(vk::AttachmentStoreOp::STORE)];
            let area = vk::Rect2D { offset: vk::Offset2D::default(), extent: vk::Extent2D { width, height } };
            unsafe {
                d.cmd_begin_rendering(cmd, &vk::RenderingInfo::default().render_area(area).layer_count(1).color_attachments(&attachment));
                d.cmd_set_viewport(cmd, 0, &[vk::Viewport { x: 0.0, y: 0.0, width: width as f32, height: height as f32, min_depth: 0.0, max_depth: 1.0 }]);
                d.cmd_set_scissor(cmd, 0, &[area]);
                d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::GRAPHICS, self.pipeline);
                d.cmd_bind_vertex_buffers(cmd, 0, &[vbuf], &[0]);
                d.cmd_bind_index_buffer(cmd, ibuf, 0, vk::IndexType::UINT32);
                for &(p, tex, clip, first, count, offset) in &draws {
                    let push = Push { clip_from_point: panels[p].clip_from_point[eye as usize].to_cols_array(), clip };
                    d.cmd_push_constants(cmd, self.layout, vk::ShaderStageFlags::VERTEX | vk::ShaderStageFlags::FRAGMENT, 0, bytemuck::bytes_of(&push));
                    d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::GRAPHICS, self.layout, 0, &[self.textures[&tex].set], &[]);
                    d.cmd_draw_indexed(cmd, count, 1, first, offset, 0);
                }
                d.cmd_end_rendering(cmd);
            }
        }
        Ok(())
    }
}

impl Drop for UiRenderer {
    fn drop(&mut self) {
        let gpu = self.gpu.clone();
        let d = &gpu.device;
        unsafe {
            let _ = d.device_wait_idle();
        }
        let ids: Vec<_> = self.textures.keys().copied().collect();
        for id in ids {
            let mut t = self.textures.remove(&id).unwrap();
            self.destroy_texture(&mut t);
        }
        for (v, i) in &mut self.buffers {
            v.destroy(&gpu);
            i.destroy(&gpu);
        }
        unsafe {
            for (_, v) in self.views.drain() {
                d.destroy_image_view(v, None);
            }
            d.destroy_command_pool(self.cmd_pool, None);
            d.destroy_pipeline(self.pipeline, None);
            d.destroy_pipeline_layout(self.layout, None);
            d.destroy_descriptor_pool(self.pool, None);
            d.destroy_descriptor_set_layout(self.set_layout, None);
            d.destroy_sampler(self.sampler, None);
        }
    }
}

/// egui's vertex layout (position, uv, sRGB color as 4 bytes), premultiplied blending, no depth,
/// for dynamic rendering into `format`.
fn build_pipeline(d: &ash::Device, layout: vk::PipelineLayout, format: vk::Format) -> Result<vk::Pipeline> {
    let module = |spv: &[u8]| -> Result<vk::ShaderModule> {
        let code = ash::util::read_spv(&mut std::io::Cursor::new(spv))?;
        Ok(unsafe { d.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&code), None) }?)
    };
    let (vert, frag) = (module(VERT)?, module(FRAG)?);
    let stages = [
        vk::PipelineShaderStageCreateInfo::default().stage(vk::ShaderStageFlags::VERTEX).module(vert).name(c"main"),
        vk::PipelineShaderStageCreateInfo::default().stage(vk::ShaderStageFlags::FRAGMENT).module(frag).name(c"main"),
    ];
    let bindings = [vk::VertexInputBindingDescription::default().stride(20).input_rate(vk::VertexInputRate::VERTEX)];
    let attributes = [
        vk::VertexInputAttributeDescription::default().location(0).format(vk::Format::R32G32_SFLOAT).offset(0),
        vk::VertexInputAttributeDescription::default().location(1).format(vk::Format::R32G32_SFLOAT).offset(8),
        vk::VertexInputAttributeDescription::default().location(2).format(vk::Format::R8G8B8A8_UNORM).offset(16),
    ];
    let vertex_input = vk::PipelineVertexInputStateCreateInfo::default().vertex_binding_descriptions(&bindings).vertex_attribute_descriptions(&attributes);
    let assembly = vk::PipelineInputAssemblyStateCreateInfo::default().topology(vk::PrimitiveTopology::TRIANGLE_LIST);
    let viewport = vk::PipelineViewportStateCreateInfo::default().viewport_count(1).scissor_count(1);
    let raster = vk::PipelineRasterizationStateCreateInfo::default().polygon_mode(vk::PolygonMode::FILL).cull_mode(vk::CullModeFlags::NONE).line_width(1.0);
    let multisample = vk::PipelineMultisampleStateCreateInfo::default().rasterization_samples(vk::SampleCountFlags::TYPE_1);
    let blend_attachments = [vk::PipelineColorBlendAttachmentState::default()
        .blend_enable(true)
        .src_color_blend_factor(vk::BlendFactor::ONE)
        .dst_color_blend_factor(vk::BlendFactor::ONE_MINUS_SRC_ALPHA)
        .color_blend_op(vk::BlendOp::ADD)
        .src_alpha_blend_factor(vk::BlendFactor::ONE)
        .dst_alpha_blend_factor(vk::BlendFactor::ONE_MINUS_SRC_ALPHA)
        .alpha_blend_op(vk::BlendOp::ADD)
        .color_write_mask(vk::ColorComponentFlags::RGBA)];
    let blend = vk::PipelineColorBlendStateCreateInfo::default().attachments(&blend_attachments);
    let dynamic = vk::PipelineDynamicStateCreateInfo::default().dynamic_states(&[vk::DynamicState::VIEWPORT, vk::DynamicState::SCISSOR]);
    let formats = [format];
    let mut rendering = vk::PipelineRenderingCreateInfo::default().color_attachment_formats(&formats);
    let create = vk::GraphicsPipelineCreateInfo::default()
        .stages(&stages)
        .vertex_input_state(&vertex_input)
        .input_assembly_state(&assembly)
        .viewport_state(&viewport)
        .rasterization_state(&raster)
        .multisample_state(&multisample)
        .color_blend_state(&blend)
        .dynamic_state(&dynamic)
        .layout(layout)
        .push_next(&mut rendering);
    let pipeline = unsafe { d.create_graphics_pipelines(vk::PipelineCache::null(), &[create], None) }.map_err(|(_, e)| e)?[0];
    unsafe {
        d.destroy_shader_module(vert, None);
        d.destroy_shader_module(frag, None);
    }
    Ok(pipeline)
}
