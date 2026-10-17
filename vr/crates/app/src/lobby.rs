//! The start screen's side of things, as the 2D app's landing page: who you are (the name and
//! color peers see; signed in to an account by a code approved in a browser, or not), the
//! canvases you can open (your own, shared with you, those opened on this device), and the ways
//! in: a new canvas, a code, name or link, or a .bdraw file. The server is asked on threads of
//! their own; what they find comes back in `poll`.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Instant;
use vdraw_net::identity::Identity;
use vdraw_net::{Canvases, DevicePoll, DeviceStart, Server, User};

/// A canvas to open: its key, and a link's token if it came by one.
#[derive(Clone, Debug, PartialEq)]
pub struct Open {
    pub key: String,
    pub link: Option<String>,
}

enum Msg {
    Me(Option<User>),
    Canvases(Canvases),
    SignIn(DeviceStart),
    Polled(DevicePoll),
    Open(Open),
    NotFound(String),
    Failed(String),
}

/// A sign-in under way: the code to approve in a browser, at the address.
pub struct SignIn {
    pub start: DeviceStart,
    pub began: Instant,
    asked: Instant,
    asking: bool,
}

pub struct Lobby {
    pub identity: Identity,
    pub server: Server,
    pub user: Option<User>,
    pub canvases: Canvases,
    pub sign_in: Option<SignIn>,
    /// What is being asked of the server (shown as busy), and the last thing that went wrong.
    pub busy: Option<&'static str>,
    pub error: Option<String>,
    /// .bdraw files found where downloads and documents go.
    pub files: Vec<PathBuf>,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
}

impl Lobby {
    pub fn new(identity: Identity) -> Self {
        let server = Server::new(&identity.server, identity.token.clone());
        let (tx, rx) = channel();
        let mut lobby = Self { identity, server, user: None, canvases: Canvases::default(), sign_in: None, busy: None, error: None, files: Vec::new(), tx, rx };
        lobby.refresh();
        lobby
    }

    fn spawn(&mut self, what: &'static str, f: impl FnOnce(Server) -> Msg + Send + 'static) {
        let (tx, server) = (self.tx.clone(), self.server.clone());
        self.busy = Some(what);
        self.error = None;
        std::thread::spawn(move || {
            let _ = tx.send(f(server));
        });
    }

    /// Asks again who is signed in and for the canvases; looks for .bdraw files again.
    pub fn refresh(&mut self) {
        self.files = find_bdraw_files();
        if self.server.token.is_some() {
            self.spawn("Loading", |s| match s.me() {
                Ok(user) => Msg::Me(user),
                Err(e) => Msg::Failed(format!("{e:#}")),
            });
        }
    }

    /// Takes in what the server said. Returns a canvas to open, when one is ready.
    pub fn poll(&mut self) -> Option<Open> {
        // A sign-in asks again every few seconds until it is approved or runs out.
        if let Some(si) = &mut self.sign_in {
            if !si.asking && si.asked.elapsed().as_secs_f64() >= si.start.interval.max(1.0) {
                si.asking = true;
                si.asked = Instant::now();
                let device = si.start.device.clone();
                let tx = self.tx.clone();
                let server = self.server.clone();
                std::thread::spawn(move || {
                    let _ = tx.send(match server.device_poll(&device) {
                        Ok(p) => Msg::Polled(p),
                        Err(e) => Msg::Failed(format!("{e:#}")),
                    });
                });
            }
        }
        let mut open = None;
        while let Ok(msg) = self.rx.try_recv() {
            self.busy = None;
            match msg {
                Msg::Me(user) => {
                    self.user = user;
                    if self.user.is_none() {
                        // The token is no longer good.
                        self.set_token(None, None);
                    } else {
                        self.spawn("Loading", |s| match s.canvases() {
                            Ok(c) => Msg::Canvases(c),
                            Err(e) => Msg::Failed(format!("{e:#}")),
                        });
                    }
                }
                Msg::Canvases(c) => self.canvases = c,
                Msg::SignIn(start) => self.sign_in = Some(SignIn { start, began: Instant::now(), asked: Instant::now(), asking: false }),
                Msg::Polled(p) => {
                    if let Some(si) = &mut self.sign_in {
                        si.asking = false;
                    }
                    match p {
                        DevicePoll::Pending => {
                            if self.sign_in.as_ref().is_some_and(|si| si.began.elapsed().as_secs_f64() > si.start.expires_in) {
                                self.sign_in = None;
                                self.error = Some("The sign-in code ran out. Try again.".into());
                            }
                        }
                        DevicePoll::Expired => {
                            self.sign_in = None;
                            self.error = Some("The sign-in code ran out. Try again.".into());
                        }
                        DevicePoll::Approved { token, user } => {
                            self.sign_in = None;
                            self.set_token(Some(token), Some(user.name.clone()));
                            self.user = Some(user);
                            self.refresh();
                        }
                    }
                }
                Msg::Open(o) => {
                    self.identity.opened(&o.key, o.link.clone());
                    open = Some(o);
                }
                Msg::NotFound(input) => self.error = Some(format!("No canvas \"{input}\".")),
                Msg::Failed(e) => {
                    if let Some(si) = &mut self.sign_in {
                        si.asking = false;
                    }
                    log::warn!("{e}");
                    self.error = Some(e);
                }
            }
        }
        open
    }

    fn set_token(&mut self, token: Option<String>, account: Option<String>) {
        self.identity.token = token.clone();
        self.identity.account = account;
        self.identity.save();
        self.server.token = token;
        if self.server.token.is_none() {
            self.user = None;
            self.canvases = Canvases::default();
        }
    }

    pub fn start_sign_in(&mut self) {
        self.spawn("Signing in", |s| match s.device_start() {
            Ok(d) => Msg::SignIn(d),
            Err(e) => Msg::Failed(format!("{e:#}")),
        });
    }

    pub fn sign_out(&mut self) {
        let server = self.server.clone();
        std::thread::spawn(move || {
            let _ = server.logout();
        });
        self.set_token(None, None);
    }

    /// A new canvas: temporary (no account), or named, private or public (signed in).
    pub fn create(&mut self, name: Option<String>, public: bool) {
        let anon = self.identity.anon.clone();
        let signed_in = self.user.is_some();
        self.spawn("Making a canvas", move |s| {
            let access = signed_in.then_some(if public { "public" } else { "private" });
            match s.create(&anon, name.as_deref(), access) {
                Ok(key) => Msg::Open(Open { key, link: None }),
                Err(e) => Msg::Failed(format!("{e:#}")),
            }
        });
    }

    /// A code, a name or a link.
    pub fn join(&mut self, input: String) {
        self.spawn("Finding the canvas", move |s| match s.resolve(&input) {
            Ok(Some((key, link))) => Msg::Open(Open { key, link }),
            Ok(None) => Msg::NotFound(input),
            Err(e) => Msg::Failed(format!("{e:#}")),
        });
    }

    /// A canvas from the lists (its key known).
    pub fn open(&mut self, key: &str) {
        let link = self.identity.recent.iter().find(|r| r.key == key && r.server == self.identity.server).and_then(|r| r.link.clone());
        let _ = self.tx.send(Msg::Open(Open { key: key.into(), link }));
    }

    /// A canvas by its key, and a link's token if it came by one (opened from the 2D app).
    pub fn open_link(&mut self, key: &str, link: Option<String>) {
        let _ = self.tx.send(Msg::Open(Open { key: key.into(), link }));
    }

    /// A .bdraw file, brought in as a new canvas.
    pub fn import(&mut self, path: PathBuf) {
        let anon = self.identity.anon.clone();
        self.spawn("Opening the file", move |s| match std::fs::read(&path).map_err(anyhow::Error::from).and_then(|b| s.import(&b, &anon)) {
            Ok(key) => Msg::Open(Open { key, link: None }),
            Err(e) => Msg::Failed(format!("{}: {e:#}", path.display())),
        });
    }

    /// Your name and color, as peers see them.
    pub fn set_name(&mut self, name: &str) {
        let name: String = name.trim().chars().take(32).collect();
        if !name.is_empty() {
            self.identity.name = name;
            self.identity.save();
        }
    }

    pub fn set_color(&mut self, color: &str) {
        self.identity.color = color.into();
        self.identity.save();
    }
}

/// .bdraw files in the usual places (Downloads, Desktop, Documents), newest first.
fn find_bdraw_files() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return Vec::new() };
    let mut out: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for dir in ["Downloads", "Desktop", "Documents"] {
        let Ok(rd) = std::fs::read_dir(home.join(dir)) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("bdraw")) {
                let t = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                out.push((t, p));
            }
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, p)| p).take(30).collect()
}
