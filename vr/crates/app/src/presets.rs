//! Brush presets, as the 2D app's (PresetsPanel.svelte): a brush's or an eraser's settings
//! under a name, kept in a file beside the painting (VR has no server to share them).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use vdraw_core::Brush;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    /// For the eraser (else the brush).
    pub eraser: bool,
    /// The settings (its color is not one of them: the color stays).
    pub brush: Brush,
    /// The tip's turn about the pen (degrees).
    pub angle: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Presets {
    pub list: Vec<Preset>,
    #[serde(skip)]
    pub path: Option<PathBuf>,
}

impl Presets {
    pub fn load(path: PathBuf) -> Self {
        let mut p: Presets = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        p.path = Some(path);
        p
    }

    pub fn save(&self) {
        if let Some(path) = &self.path {
            let write = || -> anyhow::Result<()> {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(path, serde_json::to_vec_pretty(self)?)?;
                Ok(())
            };
            if let Err(e) = write() {
                log::error!("saving {}: {e:#}", path.display());
            }
        }
    }
}
