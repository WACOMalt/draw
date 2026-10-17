//! A live canvas: the WebSocket to the server (on a thread of its own, reconnecting as the 2D
//! app's web client does), and the document as this client knows it: the state the server
//! confirmed, the ops sent and not yet confirmed (shown over it), the peers and their cursors,
//! and the strokes others are drawing (net.ts, engine.ts, doc.ts).

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::time::{Duration, Instant};
use vdraw_core::doc::{Doc, DocLayer, DocStroke, OpError, Paper, StrokeVr, new_id};

/// What the socket thread says.
enum Event {
    /// Connected (again): the hello went out.
    Open,
    Message(Value),
    /// The socket closed; it tries again unless `final`.
    Closed { reason: String, fin: bool },
}

enum Out {
    Send(Value),
    /// A new hello on the open socket (a password; the server keeps the socket open until one
    /// is right).
    Hello(Value),
    /// Drop the connection and connect again at once (to load the document again).
    Reconnect,
    Close,
}

/// The socket, on its own thread: connects, says hello, passes messages both ways, pings, and
/// connects again after a drop (500 ms, doubling to 8 s), until closed or turned away.
struct Socket {
    tx: Sender<Out>,
    rx: Receiver<Event>,
}

impl Socket {
    fn open(url: String, hello: Value) -> Self {
        let (tx, out_rx) = channel::<Out>();
        let (ev_tx, rx) = channel::<Event>();
        std::thread::Builder::new().name("vdraw-net".into()).spawn(move || run_socket(url, hello, out_rx, ev_tx)).expect("socket thread");
        Self { tx, rx }
    }
}

fn run_socket(url: String, mut hello: Value, out: Receiver<Out>, events: Sender<Event>) {
    use tungstenite::{Message, stream::MaybeTlsStream};
    let mut retry = 0u32;
    loop {
        let (mut ws, _) = match tungstenite::connect(&url) {
            Ok(c) => c,
            Err(e) => {
                // A missing canvas: the upgrade is answered 404; that is final.
                let fin = matches!(&e, tungstenite::Error::Http(r) if r.status() == 404);
                if events.send(Event::Closed { reason: if fin { "no such canvas".into() } else { e.to_string() }, fin }).is_err() || fin {
                    return;
                }
                if wait_backoff(&out, &mut retry, &mut hello) {
                    return;
                }
                continue;
            }
        };
        // Reads time out now and then, to send what is waiting.
        let timeout = Some(Duration::from_millis(15));
        match ws.get_mut() {
            MaybeTlsStream::Plain(s) => drop(s.set_read_timeout(timeout)),
            MaybeTlsStream::Rustls(s) => drop(s.get_mut().set_read_timeout(timeout)),
            _ => {}
        }
        if ws.send(Message::text(hello.to_string())).is_err() {
            continue;
        }
        retry = 0;
        if events.send(Event::Open).is_err() {
            return;
        }
        let mut last_ping = Instant::now();
        let closed = 'conn: loop {
            loop {
                match out.try_recv() {
                    Ok(Out::Send(v)) => {
                        if ws.send(Message::text(v.to_string())).is_err() {
                            break 'conn ("send failed".to_string(), false);
                        }
                    }
                    Ok(Out::Hello(h)) => {
                        hello = h;
                        if ws.send(Message::text(hello.to_string())).is_err() {
                            break 'conn ("send failed".to_string(), false);
                        }
                    }
                    Ok(Out::Reconnect) => {
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        retry = 0;
                        break 'conn ("reloading".to_string(), false);
                    }
                    Ok(Out::Close) | Err(TryRecvError::Disconnected) => {
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        return;
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }
            if last_ping.elapsed() > Duration::from_secs(25) {
                last_ping = Instant::now();
                let _ = ws.send(Message::text(r#"{"t":"ping"}"#));
            }
            match ws.read() {
                Ok(Message::Text(t)) => {
                    if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) {
                        if events.send(Event::Message(v)).is_err() {
                            return;
                        }
                    }
                }
                Ok(Message::Close(frame)) => {
                    // 4003: turned away (the reason came as `denied` first).
                    let fin = frame.as_ref().is_some_and(|f| u16::from(f.code) == 4003);
                    break ("closed".to_string(), fin);
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(e) => break (e.to_string(), false),
            }
        };
        let reloading = closed.0 == "reloading";
        if events.send(Event::Closed { reason: closed.0, fin: closed.1 }).is_err() || closed.1 {
            return;
        }
        if reloading {
            continue;
        }
        if wait_backoff(&out, &mut retry, &mut hello) {
            return;
        }
    }
}

/// Waits before connecting again (500 ms doubling to 8 s); true when told to close meanwhile.
fn wait_backoff(out: &Receiver<Out>, retry: &mut u32, hello: &mut Value) -> bool {
    let wait = Duration::from_millis((500u64 << (*retry).min(4)).min(8000));
    *retry += 1;
    let until = Instant::now() + wait;
    while Instant::now() < until {
        match out.recv_timeout(Duration::from_millis(50)) {
            Ok(Out::Close) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return true,
            Ok(Out::Hello(h)) => {
                *hello = h;
                return false;
            }
            Ok(Out::Reconnect) => return false,
            // Ops wait for the connection (the session sends its pending ones again).
            Ok(Out::Send(_)) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    false
}

/// A peer on the canvas, and where its pointer is (canvas units; None: off the canvas).
#[derive(Clone, Debug)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub color: String,
    pub cursor: Option<(f64, f64)>,
    pub layer: Option<String>,
}

/// A stroke someone is drawing: its layer (and mask), brush and points so far.
#[derive(Clone, Debug)]
pub struct LiveStroke {
    pub by: String,
    pub id: String,
    pub layer_id: String,
    pub mask: Option<String>,
    pub brush: Value,
    pub pts: Vec<f64>,
    /// A 3D stroke's depth and up sides so far (see `StrokeVr`).
    pub vr: Option<StrokeVr>,
}

/// What changed in a session since it was last asked.
#[derive(Clone, Debug, Default)]
pub struct Changes {
    /// The document (layers, strokes, paper, mix): draw it again.
    pub doc: bool,
    /// Peers came, went, or moved their pointers.
    pub peers: bool,
    /// Others' strokes in progress.
    pub live: bool,
    /// Ops the server refused (opId, why).
    pub rejected: Vec<(String, String)>,
}

/// How the session stands.
#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Connecting,
    Open,
    /// Waiting for the canvas's password (`wrong`: the last one was not it).
    Password { wrong: bool },
    /// Turned away, or the canvas is gone: no_access, login_required, expired, deleted, ...
    Denied(String),
    /// Connection lost; trying again.
    Reconnecting(String),
}

/// A live canvas.
pub struct Session {
    socket: Socket,
    hello: Value,
    pub key: String,
    pub state: State,
    /// This connection's id (ops by it are its own echoes).
    pub client_id: String,
    /// "owner", "editor" or "viewer".
    pub role: String,
    pub canvas: Value,
    /// The document as the server confirmed it, and the last seq.
    pub doc: Doc,
    pub seq: u64,
    /// Ops sent and not yet confirmed (shown over the confirmed document), in order.
    pub pending: Vec<(String, Value)>,
    pub peers: HashMap<String, Peer>,
    pub lives: HashMap<(String, String), LiveStroke>,
    /// Features the document uses, and those the server can take.
    pub features: Vec<String>,
    pub supports: Vec<String>,
    /// The view (confirmed + pending), made again when either changes.
    view: Option<Doc>,
}

/// The document features (src/shared/types.ts DOC_FEATURES) this client draws. A canvas
/// using another one is drawn without it (the panel says which).
pub const DRAWN_FEATURES: &[&str] = &["clip", "mask", "tips", "groups", "paper", "pigment", "vr"];

impl Session {
    /// Opens the canvas `key` on `server` as `name` (`color`), with the anonymous secret, the
    /// account's token, and a link's token if there is one.
    pub fn open(server: &crate::Server, key: &str, name: &str, color: &str, anon: &str, link: Option<&str>) -> Self {
        let mut hello = json!({ "t": "hello", "name": name, "color": color, "anon": anon });
        if let Some(t) = &server.token {
            hello["token"] = t.as_str().into();
        }
        if let Some(l) = link {
            hello["link"] = l.into();
        }
        let socket = Socket::open(server.ws_url(key), hello.clone());
        Self {
            socket,
            hello,
            key: key.into(),
            state: State::Connecting,
            client_id: String::new(),
            role: String::new(),
            canvas: Value::Null,
            doc: Doc::default(),
            seq: 0,
            pending: Vec::new(),
            peers: HashMap::new(),
            lives: HashMap::new(),
            features: Vec::new(),
            supports: Vec::new(),
            view: None,
        }
    }

    /// Tries a password (after `State::Password`).
    pub fn password(&mut self, password: &str) {
        let mut hello = self.hello.clone();
        hello["password"] = password.into();
        let _ = self.socket.tx.send(Out::Hello(hello));
        self.state = State::Connecting;
    }

    pub fn close(&self) {
        let _ = self.socket.tx.send(Out::Close);
    }

    /// Takes in what came; returns what changed.
    pub fn poll(&mut self) -> Changes {
        let mut ch = Changes::default();
        while let Ok(ev) = self.socket.rx.try_recv() {
            match ev {
                Event::Open => self.state = State::Connecting,
                Event::Closed { reason, fin } => {
                    if !matches!(self.state, State::Denied(_)) {
                        self.state = if fin { State::Denied(reason) } else { State::Reconnecting(reason) };
                    }
                    // Others' pointers and strokes in progress end with the connection.
                    self.peers.clear();
                    self.lives.clear();
                    ch.peers = true;
                    ch.live = true;
                }
                Event::Message(m) => self.message(m, &mut ch),
            }
        }
        if ch.doc {
            self.view = None;
        }
        ch
    }

    fn message(&mut self, m: Value, ch: &mut Changes) {
        let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match m.get("t").and_then(Value::as_str).unwrap_or("") {
            "welcome" => {
                let parts = (|| -> Option<Doc> {
                    let layers: Vec<DocLayer> = serde_json::from_value(m.get("layers")?.clone()).ok()?;
                    let strokes: Vec<DocStroke> = serde_json::from_value(m.get("strokes")?.clone()).ok()?;
                    let shapes: Vec<Value> = m.get("shapes").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                    let paper: Option<Paper> = m.get("paper").and_then(|v| serde_json::from_value(v.clone()).ok());
                    let mix = m.get("mix").and_then(Value::as_str).map(str::to_string);
                    Some(Doc::from_parts(layers, strokes, shapes, paper, mix))
                })();
                let Some(doc) = parts else {
                    log::error!("welcome: could not read the document");
                    self.state = State::Denied("unreadable".into());
                    return;
                };
                self.doc = doc;
                self.client_id = s("clientId");
                self.key = m.get("code").and_then(Value::as_str).unwrap_or(&self.key).to_string();
                self.seq = m.get("seq").and_then(Value::as_u64).unwrap_or(0);
                self.role = s("role");
                self.canvas = m.get("canvas").cloned().unwrap_or(Value::Null);
                let list = |k: &str| m.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
                self.features = list("features");
                self.supports = list("supports");
                self.peers = m
                    .get("peers")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|p| Some((p.get("id")?.as_str()?.to_string(), peer(p)?))).collect())
                    .unwrap_or_default();
                // A password grant: kept for next time.
                if let Some(g) = m.get("grant").and_then(Value::as_str) {
                    self.hello["grant"] = g.into();
                }
                self.state = State::Open;
                // Ops sent before (the connection dropped): again, with the same ids.
                for (id, op) in &self.pending {
                    let _ = self.socket.tx.send(Out::Send(json!({ "t": "op", "opId": id, "op": op })));
                }
                ch.doc = true;
                ch.peers = true;
            }
            "denied" => {
                let reason = s("reason");
                self.state = match reason.as_str() {
                    "password_required" => State::Password { wrong: false },
                    "password_wrong" => State::Password { wrong: true },
                    _ => State::Denied(reason),
                };
            }
            "access" => {
                self.role = s("role");
                self.canvas = m.get("canvas").cloned().unwrap_or(Value::Null);
            }
            "op" => {
                let seq = m.get("seq").and_then(Value::as_u64).unwrap_or(self.seq + 1);
                let by = s("by");
                let op = m.get("op").cloned().unwrap_or(Value::Null);
                if by == self.client_id {
                    let id = s("opId");
                    self.pending.retain(|(p, _)| *p != id);
                }
                match self.doc.apply(&op, &by, seq) {
                    Ok(()) => {}
                    Err(OpError::Reload) => {
                        // An op this client does not apply: the document again, from the server.
                        log::info!("{}: loading the canvas again", op.get("type").and_then(Value::as_str).unwrap_or("op"));
                        let _ = self.socket.tx.send(Out::Reconnect);
                    }
                    Err(OpError::Refused(why)) => log::warn!("an op from the server did not apply here: {why}"),
                }
                self.seq = seq;
                // A committed stroke ends its live version.
                if op.get("type").and_then(Value::as_str) == Some("stroke.add") {
                    if let Some(id) = op.pointer("/stroke/id").and_then(Value::as_str) {
                        self.lives.remove(&(by.clone(), id.to_string()));
                        ch.live = true;
                    }
                }
                ch.doc = true;
            }
            "reject" => {
                let id = s("opId");
                self.pending.retain(|(p, _)| *p != id);
                ch.rejected.push((id, s("reason")));
                ch.doc = true;
            }
            "live" => {
                let key = (s("by"), s("id"));
                let pts: Vec<f64> = m.get("pts").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                let vr: Option<StrokeVr> = m.get("vr").and_then(|v| serde_json::from_value(v.clone()).ok());
                if m.get("start").and_then(Value::as_bool) == Some(true) || !self.lives.contains_key(&key) {
                    self.lives.insert(
                        key.clone(),
                        LiveStroke { by: key.0.clone(), id: key.1.clone(), layer_id: s("layerId"), mask: m.get("mask").and_then(Value::as_str).map(str::to_string), brush: m.get("brush").cloned().unwrap_or(Value::Null), pts, vr },
                    );
                } else if let Some(l) = self.lives.get_mut(&key) {
                    l.pts.extend(pts);
                    if let (Some(have), Some(more)) = (&mut l.vr, vr) {
                        have.z.extend(more.z);
                        if let (Some(u), Some(mu)) = (&mut have.up, more.up) {
                            u.extend(mu);
                        }
                    }
                }
                ch.live = true;
            }
            "live.end" => {
                self.lives.remove(&(s("by"), s("id")));
                ch.live = true;
            }
            "cursor" => {
                if let Some(p) = self.peers.get_mut(&s("by")) {
                    p.cursor = m.get("x").and_then(Value::as_f64).zip(m.get("y").and_then(Value::as_f64));
                    p.layer = m.get("layerId").and_then(Value::as_str).map(str::to_string);
                    ch.peers = true;
                }
            }
            "peer.join" => {
                if let Some(p) = m.get("peer").and_then(peer) {
                    self.peers.insert(p.id.clone(), p);
                    ch.peers = true;
                }
            }
            "peer.leave" => {
                let id = s("id");
                self.peers.remove(&id);
                self.lives.retain(|(by, _), _| *by != id);
                ch.peers = true;
                ch.live = true;
            }
            _ => {}
        }
    }

    /// Sends an op (shown at once over the confirmed document). Returns its id.
    pub fn send_op(&mut self, op: Value) -> String {
        let id = new_id();
        self.pending.push((id.clone(), op.clone()));
        if self.state == State::Open {
            let _ = self.socket.tx.send(Out::Send(json!({ "t": "op", "opId": id, "op": op })));
        }
        self.view = None;
        id
    }

    /// A stroke's points while it is drawn (the first with `start`), for the others to see.
    /// `vr`: a 3D stroke's depth and up sides for these points.
    pub fn send_live(&self, id: &str, layer_id: &str, mask: Option<&str>, brush: &Value, pts: &[f64], vr: Option<&StrokeVr>, start: bool) {
        let mut m = json!({ "t": "live", "id": id, "layerId": layer_id, "brush": brush, "pts": pts, "start": start });
        if let Some(mk) = mask {
            m["mask"] = mk.into();
        }
        if let Some(v) = vr {
            m["vr"] = serde_json::to_value(v).unwrap_or(Value::Null);
        }
        let _ = self.socket.tx.send(Out::Send(m));
    }

    pub fn send_live_end(&self, id: &str) {
        let _ = self.socket.tx.send(Out::Send(json!({ "t": "live.end", "id": id })));
    }

    /// Where this user points on the canvas (None: off it).
    pub fn send_cursor(&self, at: Option<(f64, f64)>, layer: Option<&str>) {
        let (x, y) = at.map_or((Value::Null, Value::Null), |(x, y)| (x.into(), y.into()));
        let _ = self.socket.tx.send(Out::Send(json!({ "t": "cursor", "x": x, "y": y, "layerId": layer })));
    }

    /// The document with the pending ops over it (what this user sees).
    pub fn view(&mut self) -> &Doc {
        if self.pending.is_empty() {
            return &self.doc;
        }
        if self.view.is_none() {
            let mut v = self.doc.clone();
            for (_, op) in &self.pending {
                let _ = v.apply(op, &self.client_id, self.seq + 1);
            }
            self.view = Some(v);
        }
        self.view.as_ref().unwrap()
    }

    /// The canvas's features this client does not draw.
    pub fn not_drawn(&self) -> Vec<&str> {
        self.features.iter().map(String::as_str).filter(|f| !DRAWN_FEATURES.contains(f)).collect()
    }

    /// Edits are allowed (an editor or the owner, connected).
    pub fn can_edit(&self) -> bool {
        self.state == State::Open && self.role != "viewer"
    }
}

fn peer(p: &Value) -> Option<Peer> {
    Some(Peer {
        id: p.get("id")?.as_str()?.to_string(),
        name: p.get("name").and_then(Value::as_str).unwrap_or("Guest").to_string(),
        color: p.get("color").and_then(Value::as_str).unwrap_or("#31a8ff").to_string(),
        cursor: None,
        layer: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Polls until `done`, or fails after a few seconds.
    fn until(s: &mut Session, what: &str, mut done: impl FnMut(&mut Session) -> bool) {
        let t = Instant::now();
        while !done(s) {
            s.poll();
            assert!(t.elapsed() < Duration::from_secs(5), "timed out waiting for {what} (state {:?})", s.state);
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Two clients on a canvas of a test server ($VDRAW_TEST_SERVER, e.g. a local one: the 2D
    /// app's `npm run build && PORT=3299 npm start`). Skipped without one.
    #[test]
    fn two_clients_see_each_others_edits() {
        let Ok(base) = std::env::var("VDRAW_TEST_SERVER") else { return };
        let server = crate::Server::new(&base, None);
        let anon = crate::identity::base64url(&[7u8; 32]);
        let key = server.create(&anon, None, None).unwrap();
        assert_eq!(server.resolve(&key.replace('-', "").to_lowercase()).unwrap().unwrap().0, key);
        let mut a = Session::open(&server, &key, "VR A", "#ff6b6b", &anon, None);
        let mut b = Session::open(&server, &key, "VR B", "#4dabf7", &anon, None);
        until(&mut a, "a's welcome", |s| s.state == State::Open);
        until(&mut b, "b's welcome", |s| s.state == State::Open);
        assert_eq!(a.role, "editor");
        let layer = a.doc.paint_order()[0].id.clone();
        // A stroke from a: pending at once, confirmed by its echo; b sees it.
        let id = new_id();
        let stroke = json!({"id": id, "layerId": layer, "brush": {"tool": "paint", "color": "#112233", "size": 8.0, "opacity": 1.0, "flow": 1.0, "hardness": 0.8, "spacing": 0.1, "pressureSize": true, "pressureFlow": false, "buildup": false}, "pts": [0.0, 0.0, 0.5, 40.0, 10.0, 0.6]});
        a.send_live(&id, &layer, None, &stroke["brush"], &[0.0, 0.0, 0.5], None, true);
        until(&mut b, "b sees the live stroke", |s| !s.lives.is_empty());
        a.send_op(json!({"type": "stroke.add", "stroke": stroke}));
        assert_eq!(a.view().strokes.len(), 1);
        until(&mut a, "the echo", |s| s.pending.is_empty());
        until(&mut b, "b gets the stroke", |s| s.doc.strokes.contains_key(&id));
        assert!(b.lives.is_empty(), "the committed stroke ends its live version");
        assert_eq!(b.doc.strokes[&id].author.as_deref(), Some(a.client_id.as_str()));
        // A refused op comes back as rejected.
        a.send_op(json!({"type": "stroke.remove", "id": "nonexistent"}));
        let mut rejected = Vec::new();
        until(&mut a, "the reject", |s| {
            rejected.extend(s.poll().rejected);
            !rejected.is_empty()
        });
        // Peers and cursors.
        assert!(a.peers.values().any(|p| p.name == "VR B"));
        b.send_cursor(Some((12.5, -3.0)), Some(&layer));
        until(&mut a, "b's cursor", |s| s.peers.values().any(|p| p.cursor == Some((12.5, -3.0))));
        a.close();
        b.close();
    }
}
