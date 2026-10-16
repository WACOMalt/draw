//! How many stamps overlap a point of a painting seen square on from +z (a lower bound on the
//! per-pixel work of drawing it; for strokes brought in from the 2D app, which lie in a plane
//! of constant z). Usage: overlap_stats file.vdraw
use glam::Vec2;
fn main() {
    let path = std::env::args().nth(1).expect("file.vdraw");
    let p = vdraw_core::file::load(std::path::Path::new(&path)).unwrap();
    let (lo3, hi3) = p.bounds().expect("strokes");
    struct Rect { min: Vec2 }
    let c = Rect { min: lo3.truncate() };
    let size = (hi3 - lo3).truncate().max(Vec2::splat(1e-6));
    let mut segs = Vec::new();
    p.segments(&mut segs);
    const N: usize = 160;
    let mut count = vec![0u32; N * N];
    for s in &segs {
        let at = s.a().truncate();
        let r = s.a[3];
        let lo = ((at - r - c.min) / size * N as f32).floor().max(Vec2::ZERO);
        let hi = ((at + r - c.min) / size * N as f32).ceil().min(Vec2::splat(N as f32 - 1.0));
        for y in lo.y as usize..=hi.y as usize {
            for x in lo.x as usize..=hi.x as usize {
                let q = c.min + (Vec2::new(x as f32, y as f32) + 0.5) / N as f32 * size;
                if (q - at).length() < r {
                    count[y * N + x] += 1;
                }
            }
        }
    }
    let mut sorted = count.clone();
    sorted.sort();
    let covered: Vec<u32> = sorted.iter().copied().filter(|&n| n > 0).collect();
    println!("{} stamps; per covered point: median {}, 90% {}, 99% {}, max {}", segs.len(), covered[covered.len() / 2], covered[covered.len() * 9 / 10], covered[covered.len() * 99 / 100], covered.last().unwrap());
}
