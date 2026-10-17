//! `vdraw --bot`: a pretend VR user on a shared canvas, for trying the canvas with someone
//! else on it. It joins as a VR user would, stands in front of the drawing, and paints: strokes
//! in 3D on a 3D layer of its own (now and then flat ones on the paper, on another layer),
//! each with a brush of random settings, sent while they are drawn and when they end; it
//! looks at what it paints, its right hand at the brush. Now and then it takes its last stroke
//! back. Until Ctrl-C.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use vdraw_core::doc::{self, StrokeThreeD, new_id};
use vdraw_net::session::{Avatar, Pose, Session, State};

/// A small random number source (xorshift), seeded from the clock.
struct Rng(u64);

impl Rng {
    fn new() -> Self {
        let mut b = [0u8; 8];
        doc::getrandom(&mut b);
        Self(u64::from_le_bytes(b) | 1)
    }
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next()
    }
}

fn norm(v: [f64; 3]) -> [f64; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-12);
    v.map(|c| (c / l * 1000.0).round() / 1000.0)
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// A random brush, as the 2D app's (sizes in canvas units: `m` per meter).
fn brush(rng: &mut Rng, m: f64) -> Value {
    let hue = rng.next();
    let (r, g, b) = hsv(hue, rng.range(0.4, 1.0), rng.range(0.5, 1.0));
    let mut v = json!({
        "tool": "paint",
        "color": format!("#{:02x}{:02x}{:02x}", (r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8),
        "size": (rng.range(0.004, 0.04) * m * 1e4).round() / 1e4,
        "opacity": (rng.range(0.4, 1.0) * 100.0).round() / 100.0,
        "flow": (rng.range(0.2, 1.0) * 100.0).round() / 100.0,
        "hardness": (rng.range(0.0, 1.0) * 100.0).round() / 100.0,
        "spacing": (rng.range(0.05, 0.25) * 100.0).round() / 100.0,
        "pressureSize": rng.next() < 0.7,
        "pressureFlow": rng.next() < 0.3,
        "buildup": false,
    });
    if rng.next() < 0.4 {
        v["roundness"] = ((rng.range(0.15, 1.0) * 100.0).round() / 100.0).into();
        v["angle"] = (rng.range(0.0, 360.0).round()).into();
    }
    if rng.next() < 0.2 {
        v["sizeJitter"] = ((rng.range(0.0, 0.6) * 100.0).round() / 100.0).into();
    }
    v
}

fn hsv(h: f64, s: f64, v: f64) -> (f64, f64, f64) {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - f * s), v * (1.0 - (1.0 - f) * s));
    match i as i32 % 6 {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    }
}

/// A stroke being drawn: its id, layer, brush, points so far (and their depth and up sides),
/// those sent, and its path: a wandering curve about a middle point.
struct Drawing {
    id: String,
    layer: String,
    flat: bool,
    brush: Value,
    pts: Vec<f64>,
    z: Vec<f64>,
    up: Vec<f64>,
    sent: usize,
    started: Instant,
    length: f64,
    middle: [f64; 3],
    size: f64,
    turns: [f64; 3],
}

pub fn run(server: &str, input: &str, name: &str) -> Result<()> {
    let quit = Arc::new(AtomicBool::new(false));
    let q = quit.clone();
    ctrlc::set_handler(move || q.store(true, Ordering::Relaxed))?;
    let srv = vdraw_net::Server::new(server, None);
    let (key, link) = srv.resolve(input)?.with_context(|| format!("no canvas {input:?} on {server}"))?;
    let id = vdraw_net::identity::Identity::default();
    let mut s = Session::open(&srv, &key, name, &id.color, &id.anon, link.as_deref());
    let t0 = Instant::now();
    while s.state != State::Open {
        s.poll();
        if let State::Denied(why) = &s.state {
            bail!("{key}: turned away: {why}");
        }
        if t0.elapsed() > Duration::from_secs(10) {
            bail!("{key}: no answer after 10 s ({:?})", s.state);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !s.can_edit() {
        bail!("{key}: {name} may only look ({})", s.role);
    }
    let mut rng = Rng::new();
    // Where the drawing is, and how big a meter is on it: as VR first fits it (1.1 m across).
    let b = s.doc.bounds().unwrap_or([0.0, 0.0, 1000.0, 1000.0]);
    let side = ((b[2] - b[0]).max(b[3] - b[1]) * 1.08).max(1e-9);
    let m = side / 1.1;
    let center = [(b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5, 0.0];
    // A 3D layer of its own, on top.
    let top = s.doc.children(None).last().map_or(0.0, |l| l.order) + 1.0;
    let layer3d = new_id();
    s.send_op(json!({ "type": "layer.add", "layer": { "id": layer3d, "name": format!("{name}'s 3D layer"), "order": top, "blend": "normal", "opacity": 1.0, "visible": true, "threed": true } }));
    println!("{name} is on {key} ({server}); Ctrl-C to stop");
    let mut drawing: Option<Drawing> = None;
    let mut mine: Vec<String> = Vec::new();
    let mut rest_until = Instant::now() + Duration::from_millis(800);
    let mut look = center;
    let mut hand = center;
    let started = Instant::now();
    let mut frame = 0u64;
    while !quit.load(Ordering::Relaxed) {
        let changes = s.poll();
        for (_, why) in changes.rejected {
            println!("refused: {why}");
        }
        if !matches!(s.state, State::Open) {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }
        let t = started.elapsed().as_secs_f64();
        // The stroke: a point every frame along its curve, its pressure swelling and fading.
        if let Some(d) = &mut drawing {
            let u = d.started.elapsed().as_secs_f64() / d.length;
            let a = u * std::f64::consts::TAU;
            let p = [
                d.middle[0] + d.size * ((a * d.turns[0]).sin() + 0.3 * (a * 3.1).cos()),
                d.middle[1] + d.size * ((a * d.turns[1]).cos() * 0.8),
                if d.flat { 0.0 } else { d.middle[2] + d.size * 0.6 * (a * d.turns[2]).sin() },
            ];
            let pressure = (0.25 + 0.75 * (u * std::f64::consts::PI).sin()).clamp(0.05, 1.0);
            let dec = doc::point_decimals(m / 0.0005);
            d.pts.extend([doc::round_to(p[0], dec), doc::round_to(p[1], dec), (pressure * 1000.0).round() / 1000.0]);
            d.z.push(doc::round_to(p[2], dec));
            // The pen's top tilts as it goes.
            let up = norm([0.3 * (a * 2.0).sin(), -1.0, 0.4 * (a * 1.3).cos()]);
            d.up.extend(up);
            hand = p;
            look = p;
            let n = d.pts.len() / 3;
            let depth = |from: usize| (!d.flat).then(|| StrokeThreeD { z: d.z[from..].to_vec(), up: Some(d.up[3 * from..].to_vec()) });
            if n - d.sent >= 2 || u >= 1.0 {
                s.send_live(&d.id, &d.layer, None, &d.brush, &d.pts[3 * d.sent..], depth(d.sent).as_ref(), d.sent == 0);
                d.sent = n;
            }
            if u >= 1.0 {
                let mut stroke = json!({ "id": d.id, "layerId": d.layer, "brush": d.brush, "pts": d.pts });
                if let Some(v) = depth(0) {
                    stroke["threed"] = serde_json::to_value(v)?;
                }
                s.send_op(json!({ "type": "stroke.add", "stroke": stroke }));
                mine.push(d.id.clone());
                drawing = None;
                rest_until = Instant::now() + Duration::from_millis(rng.range(400.0, 1500.0) as u64);
            }
        } else if Instant::now() >= rest_until {
            if !mine.is_empty() && rng.next() < 0.12 {
                // Takes the last one back.
                let last = mine.pop().unwrap();
                s.send_op(json!({ "type": "stroke.remove", "id": last }));
                rest_until = Instant::now() + Duration::from_millis(700);
            } else {
                // A new stroke: mostly in 3D on its layer; now and then flat on the paper, on the
                // top flat layer.
                let flat_layer = s.doc.painted_layers().into_iter().rev().find(|l| !l.threed && !l.is_group() && l.kind.is_none()).map(|l| l.id.clone());
                let flat = flat_layer.is_some() && rng.next() < 0.25;
                let size = rng.range(0.05, 0.2) * m;
                let middle = [center[0] + rng.range(-0.35, 0.35) * m, center[1] + rng.range(-0.3, 0.3) * m, rng.range(-0.05, 0.25) * m];
                drawing = Some(Drawing {
                    id: new_id(),
                    layer: if flat { flat_layer.unwrap() } else { layer3d.clone() },
                    flat,
                    brush: brush(&mut rng, m),
                    pts: Vec::new(),
                    z: Vec::new(),
                    up: Vec::new(),
                    sent: 0,
                    started: Instant::now(),
                    length: rng.range(1.2, 3.0),
                    middle,
                    size,
                    turns: [rng.range(0.5, 2.0), rng.range(0.5, 2.0), rng.range(0.5, 1.5)],
                });
            }
        }
        // Where it stands: in front of the drawing, swaying; its head looks at the brush, its
        // left hand rests at its side.
        let head = [center[0] + 0.25 * m * (t * 0.3).sin(), center[1] - 0.1 * m + 0.05 * m * (t * 0.5).sin(), 1.0 * m + 0.1 * m * (t * 0.2).cos()];
        let f = norm(sub(look, head));
        let rest = [head[0] - 0.25 * m, head[1] + 0.45 * m, head[2] - 0.15 * m];
        let right = [hand[0], hand[1], hand[2] + 0.12 * m];
        let pose = |p: [f64; 3], f: [f64; 3]| Pose { p, f, u: norm([0.0, -1.0, 0.0]) };
        let avatar = Avatar { m, head: pose(head, f), hands: [Some(pose(rest, norm([0.0, 0.3, -1.0]))), Some(pose(right, norm(sub(hand, right))))] };
        // (About 15 times a second: under the server's limit.)
        if frame % 2 == 0 {
            s.send_avatar(Some(&avatar));
        }
        frame += 1;
        if drawing.is_none() {
            // Between strokes the hand drifts back toward the middle.
            hand = [hand[0] + (center[0] - hand[0]) * 0.02, hand[1] + (center[1] - hand[1]) * 0.02, hand[2] + (0.1 * m - hand[2]) * 0.02];
        }
        std::thread::sleep(Duration::from_millis(33));
    }
    s.send_avatar(None);
    std::thread::sleep(Duration::from_millis(100));
    s.close();
    println!("{name} left");
    Ok(())
}
