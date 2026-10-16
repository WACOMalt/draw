//! vdraw-render: the Vulkan renderer. It raymarches the painting's round cones (exact, no
//! voxels) in one compute pass into an RGBA16F image array, one layer per eye.

pub mod gpu;
pub mod raymarch;
pub mod ui;

pub use gpu::Gpu;
pub use raymarch::{BrushTip, EyeView, Overlays, Raymarcher, Target, barrier, color_range};
pub use ui::{PanelDraw, UiRenderer};
