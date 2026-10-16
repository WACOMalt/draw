//! vdraw-core: the painting model, with no GPU code.
//!
//! Strokes are the truth: raw, timestamped samples of the brush tip. Everything the renderer
//! draws is derived from them: the samples are filtered (One Euro), resampled by arc length,
//! and turned into round cones (`GpuSegment`). The renderer raymarches the round cones exactly
//! (no voxels). World units are meters.
//!
//! Portability: a segment is four `[f32; 4]`, so a port can keep segments in a float texture
//! (a VRChat world has no structured buffers), and `sdf` mirrors `shaders/sdf.slang` one to one.

pub mod file;
pub mod filter;
pub mod painting;
pub mod sdf;
pub mod segments;
pub mod stroke;

pub use filter::OneEuro3;
pub use painting::{Blend, Canvas, Layer, LayerRun, Painting, Plane};
pub use segments::{CHORD_H, CHORD_Q, GpuChunk, GpuCluster, GpuSegment, chord_table, chunks, clusters};
pub use stroke::{Brush, Dabs, Sample, Stroke};
