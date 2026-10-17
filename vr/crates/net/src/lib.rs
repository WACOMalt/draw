//! vdraw's client of the 2D app's server (multiplayer-canvas): its REST API (canvases, sign in
//! by device code, the server's health) and the live canvas session over a WebSocket (JSON
//! messages: hello, welcome, ops, live strokes, cursors), as the 2D app's web client speaks
//! them (src/client/engine/net.ts, engine.ts; src/server/api.ts, session.ts).

pub mod identity;
pub mod session;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};

/// The 2D app's server.
#[derive(Clone, Debug)]
pub struct Server {
    /// "https://draw.bsums.xyz", or a local one ("http://127.0.0.1:3210").
    pub base: String,
    /// The account's session token (a Bearer token), when signed in.
    pub token: Option<String>,
    agent: ureq::Agent,
}

/// A canvas in a list (api.ts Summary).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub key: String,
    pub role: String,
    #[serde(default)]
    pub created_at: Option<f64>,
    #[serde(default)]
    pub last_active_at: Option<f64>,
    #[serde(default)]
    pub owner: Option<Value>,
}

/// The canvases of the account: its own, and those shared with it.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Canvases {
    #[serde(default)]
    pub owned: Vec<Summary>,
    #[serde(default)]
    pub shared: Vec<Summary>,
}

/// An account.
#[derive(Clone, Debug, Deserialize)]
pub struct User {
    pub id: Value,
    pub email: String,
    pub name: String,
    #[serde(default)]
    pub admin: bool,
}

/// A device-code sign-in under way: the code to approve at `url` (in a browser, signed in),
/// and the handle to ask with.
#[derive(Clone, Debug, Deserialize)]
pub struct DeviceStart {
    pub device: String,
    pub code: String,
    pub url: String,
    /// Seconds between asks, and how long the code lasts.
    pub interval: f64,
    #[serde(rename = "expiresIn")]
    pub expires_in: f64,
}

/// How a device-code sign-in stands.
#[derive(Clone, Debug)]
pub enum DevicePoll {
    Pending,
    Expired,
    Approved { token: String, user: User },
}

impl Server {
    pub fn new(base: &str, token: Option<String>) -> Self {
        // Error statuses come back as answers (their JSON says why), not as errors.
        let agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(std::time::Duration::from_secs(20))).build().into();
        Self { base: base.trim_end_matches('/').to_string(), token, agent }
    }

    /// The WebSocket URL of a canvas: ws(s)://host/ws?code=KEY.
    pub fn ws_url(&self, key: &str) -> String {
        let base = self.base.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
        format!("{base}/ws?code={}", urlencode(key))
    }

    fn get(&self, path: &str) -> Result<(u16, Value)> {
        let mut req = self.agent.get(format!("{}{path}", self.base));
        if let Some(t) = &self.token {
            req = req.header("Authorization", &format!("Bearer {t}"));
        }
        let mut res = req.call().with_context(|| format!("GET {path}"))?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_json::<Value>().unwrap_or(Value::Null);
        Ok((status, body))
    }

    fn post(&self, path: &str, body: &Value) -> Result<(u16, Value)> {
        // No Origin header: the server checks one only when it is sent.
        let mut req = self.agent.post(format!("{}{path}", self.base)).header("Content-Type", "application/json");
        if let Some(t) = &self.token {
            req = req.header("Authorization", &format!("Bearer {t}"));
        }
        let mut res = req.send_json(body).with_context(|| format!("POST {path}"))?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_json::<Value>().unwrap_or(Value::Null);
        Ok((status, body))
    }

    /// The answer, or the server's reason ({error}) as an error.
    fn ok(path: &str, (status, body): (u16, Value)) -> Result<Value> {
        if (200..300).contains(&status) {
            Ok(body)
        } else {
            bail!("{path}: {}", body.get("error").and_then(Value::as_str).map_or(format!("HTTP {status}"), str::to_string))
        }
    }

    /// The server's version (GET /api/health).
    pub fn health(&self) -> Result<String> {
        let v = Self::ok("health", self.get("/api/health")?)?;
        Ok(v.get("version").and_then(Value::as_str).unwrap_or("?").to_string())
    }

    /// The signed-in account (None: the token is not good, or there is none).
    pub fn me(&self) -> Result<Option<User>> {
        let v = Self::ok("me", self.get("/api/auth/me")?)?;
        Ok(v.get("user").filter(|u| !u.is_null()).and_then(|u| serde_json::from_value(u.clone()).ok()))
    }

    /// A new canvas: temporary without an account (`anon` proves it was made here), or named
    /// (`name`) and private or public with one. Returns its key.
    pub fn create(&self, anon: &str, name: Option<&str>, access: Option<&str>) -> Result<String> {
        let mut body = json!({ "anon": anon });
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            body["name"] = n.into();
        }
        if let Some(a) = access {
            body["access"] = a.into();
        }
        let v = Self::ok("new canvas", self.post("/api/sessions", &body)?)?;
        v.get("key").and_then(Value::as_str).map(str::to_string).ok_or_else(|| anyhow!("new canvas: no key"))
    }

    /// A code, a name or a link, to the canvas key (None: no such canvas). A link's edit or view
    /// token (?k=) comes along.
    pub fn resolve(&self, input: &str) -> Result<Option<(String, Option<String>)>> {
        let (key, link) = parse_input(input);
        if key.is_empty() {
            return Ok(None);
        }
        let v = Self::ok("join", self.get(&format!("/api/sessions/{}", urlencode(&key)))?)?;
        if v.get("exists").and_then(Value::as_bool) != Some(true) {
            return Ok(None);
        }
        Ok(Some((v.get("key").and_then(Value::as_str).unwrap_or(&key).to_string(), link)))
    }

    /// The account's canvases (signed in only).
    pub fn canvases(&self) -> Result<Canvases> {
        Ok(serde_json::from_value(Self::ok("canvases", self.get("/api/canvases")?)?)?)
    }

    /// Starts a device-code sign-in.
    pub fn device_start(&self) -> Result<DeviceStart> {
        Ok(serde_json::from_value(Self::ok("sign in", self.post("/api/auth/device/start", &json!({}))?)?)?)
    }

    pub fn device_poll(&self, device: &str) -> Result<DevicePoll> {
        let v = Self::ok("sign in", self.post("/api/auth/device/poll", &json!({ "device": device }))?)?;
        Ok(match v.get("status").and_then(Value::as_str) {
            Some("approved") => DevicePoll::Approved {
                token: v.get("token").and_then(Value::as_str).unwrap_or("").to_string(),
                user: serde_json::from_value(v.get("user").cloned().unwrap_or(Value::Null))?,
            },
            Some("expired") => DevicePoll::Expired,
            _ => DevicePoll::Pending,
        })
    }

    pub fn logout(&self) -> Result<()> {
        Self::ok("log out", self.post("/api/auth/logout", &json!({}))?)?;
        Ok(())
    }

    /// Brings a .bdraw file in as a new canvas (POST /api/import). Returns its key.
    pub fn import(&self, bytes: &[u8], anon: &str) -> Result<String> {
        let options = urlencode(&json!({ "anon": anon }).to_string());
        let mut req = self.agent.post(format!("{}/api/import", self.base)).header("Content-Type", "application/octet-stream").header("X-Draw-Options", &options);
        if let Some(t) = &self.token {
            req = req.header("Authorization", &format!("Bearer {t}"));
        }
        let mut res = req.send(bytes).context("POST /api/import")?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_json::<Value>().unwrap_or(Value::Null);
        let v = Self::ok("open file", (status, body))?;
        v.get("key").and_then(Value::as_str).map(str::to_string).ok_or_else(|| anyhow!("open file: no key"))
    }
}

/// A canvas code ("ABCD-2345", with or without the dash), a name, or a pasted link
/// (".../s/KEY?k=TOKEN"): the key, and the link's token.
pub fn parse_input(input: &str) -> (String, Option<String>) {
    let s = input.trim();
    if let Some(at) = s.find("/s/") {
        let rest = &s[at + 3..];
        let (key, query) = rest.split_once('?').unwrap_or((rest, ""));
        let token = query.split('&').find_map(|kv| kv.strip_prefix("k=")).map(str::to_string);
        return (key.trim_end_matches('/').to_string(), token);
    }
    let compact: String = s.chars().filter(|c| *c != '-').collect();
    if compact.len() == 8 && compact.chars().all(|c| c.is_ascii_alphanumeric()) && compact.chars().any(|c| c.is_ascii_digit()) {
        let up = compact.to_ascii_uppercase();
        return (format!("{}-{}", &up[..4], &up[4..]), None);
    }
    (s.to_string(), None)
}

/// Percent-encodes what is not unreserved (RFC 3986).
pub fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inputs_become_keys() {
        assert_eq!(parse_input(" abcd2345 "), ("ABCD-2345".into(), None));
        assert_eq!(parse_input("ABCD-2345"), ("ABCD-2345".into(), None));
        assert_eq!(parse_input("https://draw.bsums.xyz/s/my-canvas?k=tok123"), ("my-canvas".into(), Some("tok123".into())));
        assert_eq!(parse_input("my-canvas"), ("my-canvas".into(), None));
        assert_eq!(urlencode("a b/é"), "a%20b%2F%C3%A9");
    }
}
