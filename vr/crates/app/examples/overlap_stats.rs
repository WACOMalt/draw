//! How much of a painting a point is under, seen square on from +z (a lower bound on the
//! per-pixel work of drawing it; for strokes brought in from the 2D app, which lie in a plane
//! of constant z): segments (tubes) whose capsule covers it, chunk spheres that do, and strokes.
//! Usage: overlap_stats file.vdraw
use glam::Vec2;
fn main() {
    let path = std::env::args().nth(1).expect("file.vdraw");
    let p = vdraw_core::file::load(std::path::Path::new(&path)).unwrap();
    let (lo3, hi3) = p.bounds().expect("strokes");
    let min = lo3.truncate();
    let size = (hi3 - lo3).truncate().max(Vec2::splat(1e-6));
    let mut segs = Vec::new();
    p.build(&mut segs);
    let mut chunks = Vec::new();
    vdraw_core::chunks(&segs, &mut chunks);
    const N: usize = 160;
    let point = |x: usize, y: usize| min + (Vec2::new(x as f32, y as f32) + 0.5) / N as f32 * size;
    let add = |count: &mut Vec<u32>, lo: Vec2, hi: Vec2, inside: &dyn Fn(Vec2) -> bool| {
        let lo = ((lo - min) / size * N as f32).floor().max(Vec2::ZERO);
        let hi = ((hi - min) / size * N as f32).ceil().min(Vec2::splat(N as f32 - 1.0));
        for y in lo.y as usize..=hi.y as usize {
            for x in lo.x as usize..=hi.x as usize {
                if inside(point(x, y)) {
                    count[y * N + x] += 1;
                }
            }
        }
    };
    let mut tubes = vec![0u32; N * N];
    for s in &segs {
        let (a, b) = (s.a().truncate(), s.b().truncate());
        let r = s.a[3].max(s.b[3]);
        add(&mut tubes, a.min(b) - r, a.max(b) + r, &|q| {
            let ab = b - a;
            let t = if ab.length_squared() > 0.0 { ((q - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) } else { 0.0 };
            (q - a - ab * t).length() < r
        });
    }
    let mut spheres = vec![0u32; N * N];
    for c in &chunks {
        let (at, r) = (Vec2::new(c.sphere[0], c.sphere[1]), c.sphere[3]);
        add(&mut spheres, at - r, at + r, &|q| (q - at).length() < r);
    }
    let stats = |name: &str, count: &[u32]| {
        let mut s: Vec<u32> = count.iter().copied().filter(|&n| n > 0).collect();
        s.sort();
        println!("{name}: per covered point median {}, 90% {}, 99% {}, max {}", s[s.len() / 2], s[s.len() * 9 / 10], s[s.len() * 99 / 100], s.last().unwrap());
    };
    println!("{} segments, {} chunks", segs.len(), chunks.len());
    stats("tubes", &tubes);
    stats("chunk spheres", &spheres);
}
