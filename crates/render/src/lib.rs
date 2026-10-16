//! vdraw-render: the Vulkan renderer. It raymarches the painting's round cones (exact, no
//! voxels) in one compute pass into an RGBA16F image array, one layer per eye.

pub mod gpu;
pub mod raymarch;
pub mod ui;

pub use gpu::Gpu;
pub use raymarch::{BrushTip, EyeView, MAX_LINES, OverlayLine, Overlays, Raymarcher, Scene, SceneStep, Target, barrier, color_range, scene_steps};
pub use ui::{PanelDraw, UiRenderer};
