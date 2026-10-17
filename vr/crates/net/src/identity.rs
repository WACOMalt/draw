//! Who this VR app is to the server, kept between runs (the 2D app keeps the same in its
//! browser storage: draw.anon, draw.prefs, draw.recent): the server, the anonymous secret (it
//! proves this device made a temporary canvas), the account's token when signed in, the name
//! and color peers see, and the canvases opened lately. In ~/.config/vdraw/identity.json, which
//! only its owner can read (it holds the token).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The 2D app's production server.
pub const DEFAULT_SERVER: &str = "https://draw.bsums.xyz";
/// Canvases kept in the recent list.
pub const MAX_RECENT: usize = 20;
/// The 2D app's peer colors (PEER_COLORS).
pub const PEER_COLORS: [&str; 9] = ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#38d9a9", "#4dabf7", "#748ffc", "#da77f2", "#f783ac"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recent {
    pub key: String,
    pub server: String,
    /// Seconds since the epoch.
    pub at: f64,
    /// The link's edit or view token, if it was opened by one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Identity {
    pub server: String,
    /// 32 random bytes, base64url.
    pub anon: String,
    pub token: Option<String>,
    /// The account's name when signed in (shown on the start screen).
    pub account: Option<String>,
    pub name: String,
    pub color: String,
    pub recent: Vec<Recent>,
    #[serde(skip)]
    pub path: Option<PathBuf>,
}

impl Default for Identity {
    fn default() -> Self {
        let mut b = [0u8; 32];
        vdraw_core::doc::getrandom(&mut b);
        let pick = |n: usize, k: usize| b[k] as usize % n;
        // The 2D app's names (state.svelte.ts).
        const ADJ: [&str; 15] = ["Brisk", "Calm", "Dusky", "Eager", "Fuzzy", "Gentle", "Hazy", "Jolly", "Lucky", "Misty", "Nimble", "Quiet", "Rusty", "Sunny", "Witty"];
        const NOUN: [&str; 15] = ["Otter", "Heron", "Lynx", "Moth", "Finch", "Badger", "Koi", "Fox", "Wren", "Newt", "Yak", "Gecko", "Puffin", "Hare", "Owl"];
        Self {
            server: DEFAULT_SERVER.into(),
            anon: base64url(&b),
            token: None,
            account: None,
            name: format!("{} {}", ADJ[pick(15, 0)], NOUN[pick(15, 1)]),
            color: PEER_COLORS[pick(9, 2)].into(),
            recent: Vec::new(),
            path: None,
        }
    }
}

impl Identity {
    /// ~/.config/vdraw/identity.json (or $XDG_CONFIG_HOME; on Windows %APPDATA%).
    pub fn default_path() -> PathBuf {
        config_dir().join("vdraw/identity.json")
    }

    /// The identity at `path`, or a new one (saved there).
    pub fn load(path: PathBuf) -> Self {
        let mut id: Identity = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let fresh = id.path.is_none() && !path.exists();
        id.path = Some(path);
        if fresh {
            id.save();
        }
        id
    }

    pub fn save(&self) {
        let Some(path) = &self.path else { return };
        let write = || -> anyhow::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
            }
            std::fs::rename(&tmp, path)?;
            Ok(())
        };
        if let Err(e) = write() {
            log::error!("saving {}: {e:#}", path.display());
        }
    }

    /// Puts a canvas first in the recent list.
    pub fn opened(&mut self, key: &str, link: Option<String>) {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
        let link = link.or_else(|| self.recent.iter().find(|r| r.key == key && r.server == self.server).and_then(|r| r.link.clone()));
        self.recent.retain(|r| !(r.key == key && r.server == self.server));
        self.recent.insert(0, Recent { key: key.into(), server: self.server.clone(), at, link });
        self.recent.truncate(MAX_RECENT);
        self.save();
    }
}

/// Where settings go: $XDG_CONFIG_HOME, ~/.config, or on Windows %APPDATA%.
pub fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))
        .unwrap_or_else(|| ".".into())
}

/// Where data goes: $XDG_DATA_HOME, ~/.local/share, or on Windows %LOCALAPPDATA%.
pub fn data_dir() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .unwrap_or_else(|| ".".into())
}

/// Base64url without padding (the 2D app's anon secret's form).
pub fn base64url(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        let chars = chunk.len() + 1;
        for k in 0..chars {
            out.push(A[(n >> (18 - 6 * k) & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_save_and_load() {
        assert_eq!(base64url(b"hello"), "aGVsbG8");
        let path = std::env::temp_dir().join(format!("vdraw-identity-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut a = Identity::load(path.clone());
        assert_eq!(a.anon.len(), 43);
        a.opened("ABCD-2345", Some("tok".into()));
        a.opened("other", None);
        a.opened("ABCD-2345", None);
        let b = Identity::load(path.clone());
        assert_eq!((b.anon, b.recent.len(), b.recent[0].link.as_deref()), (a.anon, 2, Some("tok")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_file(&path).unwrap();
    }
}
