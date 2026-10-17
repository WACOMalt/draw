//! The Vulkan instance, device, queue and memory allocator.
//!
//! Two ways in. A window or a headless snapshot creates the instance and device itself. OpenXR
//! (XR_KHR_vulkan_enable2) creates them through the runtime, which adds the extensions it needs
//! and picks the GPU: `create_instance_with` and `create_device_with` take a closure that does
//! the actual creation, so both paths share the same create infos.

use anyhow::{Context, Result, anyhow};
use ash::vk;
use gpu_allocator::vulkan::{Allocator, AllocatorCreateDesc};
use std::ffi::{CStr, c_char};
use std::mem::ManuallyDrop;
use std::sync::Mutex;

pub const API_VERSION: u32 = vk::API_VERSION_1_3;
const VALIDATION: &CStr = c"VK_LAYER_KHRONOS_validation";

pub struct Gpu {
    pub entry: ash::Entry,
    pub instance: ash::Instance,
    pub physical: vk::PhysicalDevice,
    pub device: ash::Device,
    pub queue_family: u32,
    pub queue: vk::Queue,
    pub allocator: ManuallyDrop<Mutex<Allocator>>,
}

/// Validation layers when VDRAW_VALIDATION=1 and the layer is installed.
fn want_validation(entry: &ash::Entry) -> bool {
    if std::env::var("VDRAW_VALIDATION").as_deref() != Ok("1") {
        return false;
    }
    let layers = unsafe { entry.enumerate_instance_layer_properties() }.unwrap_or_default();
    let found = layers.iter().any(|l| l.layer_name_as_c_str() == Ok(VALIDATION));
    if !found {
        log::warn!("VDRAW_VALIDATION=1 but {VALIDATION:?} is not installed");
    }
    found
}

/// Creates the instance through `create` (Vulkan 1.3, the given extensions, validation on
/// request). The window path passes `entry.create_instance`; OpenXR passes the runtime's call.
pub fn create_instance_with(
    entry: &ash::Entry,
    extensions: &[*const c_char],
    create: impl FnOnce(&vk::InstanceCreateInfo) -> Result<vk::Instance>,
) -> Result<ash::Instance> {
    let app = vk::ApplicationInfo::default()
        .application_name(c"vdraw")
        .application_version(1)
        .engine_name(c"vdraw")
        .api_version(API_VERSION);
    let layers = if want_validation(entry) { vec![VALIDATION.as_ptr()] } else { vec![] };
    let info = vk::InstanceCreateInfo::default().application_info(&app).enabled_extension_names(extensions).enabled_layer_names(&layers);
    let raw = create(&info)?;
    Ok(unsafe { ash::Instance::load(entry.static_fn(), raw) })
}

/// Creates the device through `create`, with the features vdraw needs (synchronization2 and
/// dynamic rendering; 16-bit floats and integers for the packed depth slices) and one queue of
/// `queue_family`. No Vulkan 1.2 struct: SteamVR adds its own 1.2-era feature structs to the
/// chain, which a Vulkan 1.2 struct would conflict with.
pub fn create_device_with(
    instance: &ash::Instance,
    _physical: vk::PhysicalDevice,
    queue_family: u32,
    extensions: &[*const c_char],
    create: impl FnOnce(&vk::DeviceCreateInfo) -> Result<vk::Device>,
) -> Result<ash::Device> {
    let prio = [1.0f32];
    let queues = [vk::DeviceQueueCreateInfo::default().queue_family_index(queue_family).queue_priorities(&prio)];
    let mut f13 = vk::PhysicalDeviceVulkan13Features::default().synchronization2(true).dynamic_rendering(true);
    let mut f16 = vk::PhysicalDeviceShaderFloat16Int8Features::default().shader_float16(true);
    let core = vk::PhysicalDeviceFeatures::default().shader_int16(true);
    let info = vk::DeviceCreateInfo::default()
        .queue_create_infos(&queues)
        .enabled_extension_names(extensions)
        .enabled_features(&core)
        .push_next(&mut f13)
        .push_next(&mut f16);
    let raw = create(&info)?;
    Ok(unsafe { ash::Device::load(instance.fp_v1_0(), raw) })
}

/// A queue family with graphics and compute (and `ok` true for it, such as present support).
pub fn pick_queue_family(instance: &ash::Instance, physical: vk::PhysicalDevice, ok: &dyn Fn(u32) -> bool) -> Option<u32> {
    let families = unsafe { instance.get_physical_device_queue_family_properties(physical) };
    families.iter().enumerate().find_map(|(i, f)| {
        let i = i as u32;
        (f.queue_flags.contains(vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE) && ok(i)).then_some(i)
    })
}

impl Gpu {
    /// A Vulkan instance created here (window or headless).
    pub fn create_instance(entry: &ash::Entry, extensions: &[*const c_char]) -> Result<ash::Instance> {
        create_instance_with(entry, extensions, |info| Ok(unsafe { entry.create_instance(info, None) }.context("vkCreateInstance")?.handle()))
    }

    /// The device on the best GPU (a discrete one first) that has a suitable queue family.
    /// `present`: whether a queue family can present (a window), else any.
    pub fn new(entry: ash::Entry, instance: ash::Instance, device_extensions: &[*const c_char], present: &dyn Fn(vk::PhysicalDevice, u32) -> bool) -> Result<Self> {
        let mut devices = unsafe { instance.enumerate_physical_devices() }?;
        devices.sort_by_key(|&d| {
            let p = unsafe { instance.get_physical_device_properties(d) };
            match p.device_type {
                vk::PhysicalDeviceType::DISCRETE_GPU => 0,
                vk::PhysicalDeviceType::INTEGRATED_GPU => 1,
                _ => 2,
            }
        });
        for physical in devices {
            let props = unsafe { instance.get_physical_device_properties(physical) };
            if props.api_version < API_VERSION {
                continue;
            }
            let Some(family) = pick_queue_family(&instance, physical, &|f| present(physical, f)) else { continue };
            let device = create_device_with(&instance, physical, family, device_extensions, |info| {
                Ok(unsafe { instance.create_device(physical, info, None) }.context("vkCreateDevice")?.handle())
            })?;
            return Self::from_parts(entry, instance, physical, device, family);
        }
        Err(anyhow!("no Vulkan 1.3 GPU with a graphics and compute queue"))
    }

    /// From an instance and device created elsewhere (by the OpenXR runtime).
    pub fn from_parts(entry: ash::Entry, instance: ash::Instance, physical: vk::PhysicalDevice, device: ash::Device, queue_family: u32) -> Result<Self> {
        let queue = unsafe { device.get_device_queue(queue_family, 0) };
        let allocator = Allocator::new(&AllocatorCreateDesc {
            instance: instance.clone(),
            device: device.clone(),
            physical_device: physical,
            debug_settings: Default::default(),
            buffer_device_address: false,
            allocation_sizes: Default::default(),
        })?;
        let name = unsafe { instance.get_physical_device_properties(physical) };
        log::info!("GPU: {:?}", name.device_name_as_c_str().unwrap_or(c"?"));
        Ok(Self { entry, instance, physical, device, queue_family, queue, allocator: ManuallyDrop::new(Mutex::new(allocator)) })
    }
}

impl Drop for Gpu {
    fn drop(&mut self) {
        unsafe {
            let _ = self.device.device_wait_idle();
            ManuallyDrop::drop(&mut self.allocator);
            self.device.destroy_device(None);
            self.instance.destroy_instance(None);
        }
    }
}
