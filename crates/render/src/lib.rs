//! vdraw-render: the Vulkan renderer. It raymarches the painting's round cones (exact, no
//! voxels) in one compute pass into an RGBA16F image array, one layer per eye.

pub mod gpu;
pub mod raymarch;

pub use gpu::Gpu;
pub use raymarch::{BrushTip, EyeView, Raymarcher, Target, barrier, color_range};
