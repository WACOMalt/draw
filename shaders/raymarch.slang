// Raytraces the painting: the exact round cones of every stroke, no voxels.
//
// Two kinds of stroke:
//   - Solid (opaque, hard edge): a surface. Each ray takes the nearest exact ray/round-cone
//     intersection, lit with its normal. No marching.
//   - Soft (opacity or hardness below 1): a row of density stamps (spheres with the 2D app's
//     brush falloff), all adding up. The ray takes each stamp's exact optical depth into depth
//     slices, then blends the slices front to back over whatever is behind them.
//
// One thread per pixel, one image layer per eye (dispatch z = eye). The work per pixel stays
// small in two ways:
//   1. Tile: a 16x16 workgroup first collects, together, the chunks (a few segments of a
//      stroke in one sphere) that touch the cone of view of its tile (in shared memory, at
//      most MAX_TILE). Pixels test a chunk's segments only when their ray crosses its sphere.
//   2. Order: the tile sorts its list near to far once, so each pixel can stop at the first
//      chunk that starts behind its solid hit.
// Writes linear color (RGBA16F); the present step encodes sRGB.
import sdf;
import brush;
import pigment;

// 1: paint mixes as paint (pigment.slang), 0: as light. Two builds of this shader (see
// crates/render/build.rs), as the pigment math needs many registers.
#ifndef PIGMENT
#define PIGMENT 0
#endif

static const uint TILE = 16;
static const uint MAX_TILE = 2048;

struct Eye
{
    float4x4 invViewProj; // clip (Vulkan: y down, depth 0..1) to world
    float4 pos;           // eye position, world
};

struct Params
{
    Eye eyes[2];
    uint segCount;
    uint width;
    uint height;
    uint chunkCount;
    float4 brushTip;   // xyz, w = radius (0: no tip shown)
    float4 brushColor; // rgb: the color the next stroke gets
    float4 brushStyle; // x = opacity, y = hardness of the next stroke
    float4 brushUp;    // xyz: the pen's up direction, w: the tip's roundness
    float4 laserA;     // the pointer's laser: from xyz (w = radius, 0: none)
    float4 laserB;     // to xyz
    uint clusterCount;
    uint lineCount;
    uint2 pad2;
};

[[vk::binding(0, 0)]] [[vk::image_format("rgba16f")]] RWTexture2DArray<float4> outImage;
[[vk::binding(1, 0)]] StructuredBuffer<Segment> segments;
[[vk::binding(2, 0)]] ConstantBuffer<Params> params;

// A few consecutive segments of one stroke (CHUNK in crates/core), in a sphere. Rays test
// chunks before segments.
struct Chunk
{
    float4 sphere; // center xyz, radius w
    uint first;
    uint count;
    uint flags; // bit 0: soft (density stamps); bit 1: an eraser; 0: solid
    uint layer;
    uint stroke;
    uint pad0; // three scalars, not a uint3 (std430 would align that to 16 bytes)
    uint pad1;
    uint pad2;
};
[[vk::binding(3, 0)]] StructuredBuffer<Chunk> chunks;

// The layers: the 2D app's blend mode (its number) and the opacity.
struct Layer
{
    uint blend;
    float opacity;
    uint ordered; // 1: strokes cover each other in their order (2D app strokes, in one plane)
    uint pad;
};
[[vk::binding(4, 0)]] StructuredBuffer<Layer> layers;

// The falloff integrated along a whole line through a stamp (vdraw_core::chord_table):
// CHORD_H hardnesses x CHORD_Q distances from the center (radii), row by hardness.
static const uint CHORD_Q = 65;
static const uint CHORD_H = 17;
[[vk::binding(6, 0)]] StructuredBuffer<float> chordTable;

float chord(float q, float hard)
{
    float fq = saturate(q) * float(CHORD_Q - 1);
    float fh = saturate(hard) * float(CHORD_H - 1);
    uint q0 = min(uint(fq), CHORD_Q - 2);
    uint h0 = min(uint(fh), CHORD_H - 2);
    float tq = fq - float(q0);
    float th = fh - float(h0);
    float a = lerp(chordTable[h0 * CHORD_Q + q0], chordTable[h0 * CHORD_Q + q0 + 1], tq);
    float b = lerp(chordTable[(h0 + 1) * CHORD_Q + q0], chordTable[(h0 + 1) * CHORD_Q + q0 + 1], tq);
    return lerp(a, b, th);
}

// A stamp's optical depth along a ray that crosses it whole (in front of the eye).
float stampWhole(float3 c, float r, float strength, float hard, float3 o, float3 dir)
{
    float tc = dot(c - o, dir);
    if (tc + r < 0.0 || strength <= 0.0)
        return 0.0;
    float q = length(o + dir * tc - c) / r;
    return q < 1.0 ? strength * chord(q, hard) : 0.0;
}

// The trail table (vdraw_core::trail_table) in a 3D texture: the chord value integrated
// along a tube's axis direction from the nearest point to v (radii), x: KV lengths (0..1),
// y: KQ distances, z: KH hardnesses.
static const float KH = 17.0;
static const float KQ = 33.0;
static const float KV = 33.0;
[[vk::binding(7, 0)]] Sampler3D<float> trailTable;

float trail(float q, float v, float hard)
{
    float3 at = float3(min(abs(v), 1.0), saturate(q), saturate(hard));
    float3 n = float3(KV, KQ, KH);
    return sign(v) * trailTable.SampleLevel((at * (n - 1.0) + 0.5) / n, 0.0);
}

// A tube's optical depth along a ray: its dabs spread evenly from a to b (density per meter
// at a and b in style.z and style.w), the radius and density taken at the point nearest the
// ray. A segment with a == b is one stamp (its strength in style.z).
float tubeWhole(Segment world, float3 o, float3 dir)
{
    // A flat tip: in its round space, and the result back by the stretch.
    float scale;
    Segment g = roundSpace(world, o, dir, scale);
    return tubeRound(g, o, dir) / scale;
}

float tubeRound(Segment g, float3 o, float3 dir)
{
    float3 ab = g.b.xyz - g.a.xyz;
    // Rays that pass outside the segment's bounding sphere (most that reach it through its
    // chunk's sphere): out before the work. (x + y)^2 <= 2 (x^2 + y^2) keeps it a bound.
    float rmax = max(g.a.w, g.b.w);
    float3 m = (g.a.xyz + g.b.xyz) * 0.5 - o;
    float md = dot(m, dir);
    if (dot(m, m) - md * md > 2.0 * (0.25 * dot(ab, ab) + rmax * rmax))
        return 0.0;
    float len = length(ab);
    if (len < 1e-6)
        return stampWhole(g.a.xyz, g.a.w, g.style.z, g.style.x, o, dir);
    float3 u = ab / len;
    float3 w0 = g.a.xyz - o;
    float ud = dot(u, dir);
    float s2 = max(1.0 - ud * ud, 0.0);
    if (max(dot(w0, dir), dot(g.b.xyz - o, dir)) + rmax < 0.0)
        return 0.0; // behind the eye
    // The axis point nearest the ray (x0 along the axis), and the distance there.
    float x0 = s2 > 1e-8 ? (ud * dot(w0, dir) - dot(w0, u)) / s2 : len * 0.5;
    float3 p = g.a.xyz + u * x0 - o;
    float d0 = length(p - dir * dot(p, dir));
    float f = saturate(x0 / len);
    float r = lerp(g.a.w, g.b.w, f);
    float lambda = lerp(g.style.z, g.style.w, f);
    float q0 = d0 / r;
    if (q0 >= 1.0 || lambda <= 0.0)
        return 0.0;
    float sn = sqrt(s2);
    if (sn * len < 1e-3 * r)
        return lambda * len * chord(q0, g.style.x); // along the axis
    float k = sn / r;
    return lambda / k * (trail(q0, (len - x0) * k, g.style.x) - trail(q0, -x0 * k, g.style.x));
}

// Lines drawn over everything (the stroke eraser's marks): a.xyz to b.xyz, a line a.w pixels
// wide in `color` over a halo b.w pixels wide in `halo` (linear rgb, and how much each covers).
struct OverlayLine
{
    float4 a;
    float4 b;
    float4 color;
    float4 halo;
};
[[vk::binding(8, 0)]] StructuredBuffer<OverlayLine> overlayLines;
static const uint MAX_LINES = 256;
groupshared uint lineList[MAX_LINES];
groupshared uint lineCount;

// Up to 16 consecutive chunks of one layer, in a sphere: tiles test clusters before chunks.
struct Cluster
{
    float4 sphere;
    uint first; // chunk
    uint count;
    uint2 pad;
};
[[vk::binding(5, 0)]] StructuredBuffer<Cluster> clusters;

// Chunks that touch this tile's cone of view (shared by the workgroup), sorted by layer, then
// near to far by where their spheres start: the key is the layer (top 8 bits) and the depth
// (24 bits, up to DEPTH_RANGE meters).
static const float DEPTH_RANGE = 100.0;
groupshared uint tileList[MAX_TILE];
groupshared uint tileKey[MAX_TILE];
// Which 4x4-pixel parts of the tile each listed chunk can touch (bit y * 4 + x).
groupshared uint tileMask[MAX_TILE];
groupshared float4 subAxis[16]; // xyz: a part's middle ray; w: cos of its half angle
static uint sub; // this pixel's part
groupshared uint tileCount;
static bool tileAll; // more than fit: the tile uses every chunk

uint tileN() { return tileAll ? params.chunkCount : min(tileCount, MAX_TILE); }
uint tileSeg(uint i) { return tileAll ? i : tileList[i]; }
// Whether list position i can touch this pixel's 4x4 part.
bool inPart(uint i) { return tileAll || ((tileMask[i] >> sub) & 1) != 0; }
uint tileLayer(uint i) { return tileAll ? chunks[i].layer : tileKey[i] >> 24; }
// No chunk of the same layer from list position i on starts nearer than this (layers that are
// not ordered).
float tileNear(uint i) { return tileAll ? 0.0 : float(tileKey[i] & 0xffffff) * (DEPTH_RANGE / 16777215.0); }
// The first list position past i's layer (the list is sorted by layer).
uint runEnd(uint i)
{
    uint n = tileN();
    uint layer = tileLayer(i);
    if (tileAll)
    {
        while (i < n && chunks[i].layer == layer)
            i++;
        return i;
    }
    uint lo = i + 1, hi = n;
    while (lo < hi)
    {
        uint mid = (lo + hi) / 2;
        if ((tileKey[mid] >> 24) == layer)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}

// The world-space direction of the ray through pixel position `px` (pixels, may be fractional).
float3 rayDir(Eye eye, float2 px)
{
    float2 ndc = px / float2(params.width, params.height) * 2.0 - 1.0;
    float4 far = mul(eye.invViewProj, float4(ndc, 1.0, 1.0));
    return normalize(far.xyz / far.w - eye.pos.xyz);
}

// Whether a sphere (xyz, w = radius) touches the cone from `o` along `axis` with half angle
// a (given as cos a, sin a; under 90 degrees): the angle to its center is at most a plus the
// sphere's angular radius b, that is cos(angle) >= cos(a + b) = cos a cos b - sin a sin b.
bool sphereInCone(float3 o, float3 axis, float cosA, float sinA, float4 sphere)
{
    float3 v = sphere.xyz - o;
    float d = length(v);
    if (d <= sphere.w)
        return true;
    float sinB = sphere.w / d;
    float cosB = sqrt(1.0 - sinB * sinB);
    return dot(v, axis) >= d * (cosA * cosB - sinA * sinB);
}

static const float3 LIGHT = float3(0.39, 0.88, 0.29); // normalized (0.4, 0.9, 0.3)

float3 shadeSurface(float3 base, float3 n, float3 dir)
{
    float diff = saturate(dot(n, LIGHT) * 0.5 + 0.5); // wrapped
    float3 h = normalize(LIGHT - dir);
    float spec = pow(saturate(dot(n, h)), 48.0) * 0.25;
    float rim = pow(1.0 - saturate(dot(n, -dir)), 3.0) * 0.15;
    float hemi = lerp(0.35, 1.0, n.y * 0.5 + 0.5);
    return base * (0.25 * hemi + 0.85 * diff * diff) + spec + rim;
}

// ---- Soft strokes: density stamps ----

// A soft stroke is a row of density stamps, one at each resampled point (a segment's `a`, and
// the last segment's `b`): spheres whose density falls off from the center by the 2D app's
// brush falloff, scaled by the stamp's strength (style.z, style.w). All stamps add up: along a
// stroke, where it crosses itself, and between strokes.
//
// The ray samples this density through the volume in BINS depth slices over the part of the
// ray that soft chunks cover. Each stamp's optical depth goes into the slices its chord
// crosses, exactly (the line integral of the falloff); then the slices are blended front to
// back. Within a slice the order does not count; between slices it does.

static const uint BINS = 10;
// The slices of every pixel of the tile, in shared memory: each a pair of half floats (optical
// depth, red) and (green, blue), the color weighted by the depth. Per-thread arrays indexed at
// run time spill to local memory, which made the soft pass three times slower.
groupshared uint2 bins[BINS * TILE * TILE];
static uint lane; // this thread's place in the tile

void binAdd(uint k, float tau, float3 c)
{
    uint i = k * TILE * TILE + lane;
    uint2 v = bins[i];
    float2 a = float2(f16tof32(v.x), f16tof32(v.x >> 16)) + float2(tau, c.r);
    float2 b = float2(f16tof32(v.y), f16tof32(v.y >> 16)) + c.gb;
    bins[i] = uint2(f32tof16(a.x) | (f32tof16(a.y) << 16), f32tof16(b.x) | (f32tof16(b.y) << 16));
}

// The light of a soft stamp. `n`: the offset of the ray's nearest point from the center, in
// radii (0 through the middle, so the light changes smoothly; the light is linear in n).
float3 softLit(Segment g, float3 n)
{
    float diff = saturate(dot(n, LIGHT) * 0.5 + 0.5);
    float hemi = lerp(0.5, 1.0, n.y * 0.5 + 0.5);
    // Softer strokes get flatter light: a haze has no clear surface to shade.
    float lit = 0.35 * hemi + 0.75 * diff;
    return g.color.rgb * lerp(0.85, lit, 0.4 + 0.6 * g.style.x);
}

// The slices along this pixel's ray (world distances): the near group, bins 0 to
// sliceSplit - 1 from sliceT0 to sliceGap0, and the far group, the rest from sliceGap1 to sliceT1.
// With no wide empty gap in the soft strokes' span, one group: sliceSplit = BINS, and
// sliceGap0 = sliceGap1 = sliceT1. (See where they are set.)
static float sliceT0, sliceT1, sliceGap0, sliceGap1;
static uint sliceSplit;

// A segment's stamps (at a, and at b on a stroke's last segment) into the slices. A flat tip:
// in its round space, where distances along the ray are `scale` times longer.
void addStamps(Segment world, float3 o, float3 dir)
{
    float scale;
    Segment g = roundSpace(world, o, dir, scale);
    addStamp(g, g.a.xyz, g.a.w, g.style.z / scale, o, dir, scale);
    if (g.style.w > 0.0)
        addStamp(g, g.b.xyz, g.b.w, g.style.w / scale, o, dir, scale);
}

// One stamp (center c, radius r, strength) into the slices: its optical depth along the ray,
// within its slice group (near or far, by its center), split where the slice edges cut its
// chord. `scale`: distances along the ray here are that many times the world's.
void addStamp(Segment g, float3 c, float r, float strength, float3 o, float3 dir, float scale)
{
    float tc = dot(c - o, dir);
    float3 off = o + dir * tc - c;
    float q = length(off) / r;
    if (q >= 1.0 || strength <= 0.0)
        return;
    bool near = tc < (sliceGap0 + sliceGap1) * 0.5 * scale;
    float t0 = (near ? sliceT0 : sliceGap1) * scale;
    float t1 = (near ? sliceGap0 : sliceT1) * scale;
    uint first = near ? 0 : sliceSplit;
    uint count = near ? sliceSplit : BINS - sliceSplit;
    float half = r * sqrt(1.0 - q * q);
    float a = max(tc - half, t0);
    float b = min(tc + half, t1);
    if (a >= b)
        return;
    float3 lit = softLit(g, off / r);
    float perBin = (t1 - t0) / float(count);
    uint k0 = min(uint((a - t0) / perBin), count - 1);
    uint k1 = min(uint((b - t0) / perBin), count - 1);
    float before = stampLine(q, (a - tc) / r, g.style.x);
    for (uint k = k0; k <= k1; k++)
    {
        float edge = min(b, t0 + perBin * float(k + 1));
        float upto = stampLine(q, (edge - tc) / r, g.style.x);
        float tau = strength * (upto - before);
        binAdd(first + k, tau, tau * lit);
        before = upto;
    }
}

// The nearest points of a ray (o + t dir, t >= 0) and a segment (a + s (b - a), s in 0..1).
// Returns the offset from the segment's point to the ray's. (For the laser.)
float3 rayToSegment(float3 o, float3 dir, float3 a, float3 b, out float t, out float s)
{
    float3 ba = b - a;
    float3 w = o - a;
    float bb = dot(ba, ba);
    float bd = dot(ba, dir);
    float ob = dot(w, ba);
    float od = dot(w, dir);
    float den = bb - bd * bd;
    s = den > 1e-12 ? saturate((ob - od * bd) / den) : 0.0;
    t = max(s * bd - od, 0.0);
    s = bb > 1e-12 ? saturate((ob + t * bd) / bb) : 0.0;
    t = max(s * bd - od, 0.0);
    return w + dir * t - ba * s;
}

// ---- Colors ----

float3 srgbFromLinear(float3 c)
{
    c = saturate(c);
    return lerp(c * 12.92, 1.055 * pow(c, float3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float3 linearFromSrgb(float3 c)
{
    return lerp(c / 12.92, pow((c + 0.055) / 1.055, float3(2.4)), step(0.04045, c));
}

// One stamp's optical depth along the ray, from the eye to tEnd (for erasers).
float stampTau(float3 c, float r, float strength, float hard, float3 o, float3 dir, float tEnd)
{
    float tc = dot(c - o, dir);
    float q = length(o + dir * tc - c) / r;
    if (q >= 1.0 || strength <= 0.0)
        return 0.0;
    float half = r * sqrt(1.0 - q * q);
    float a = max(tc - half, 0.0);
    float b = min(tc + half, tEnd);
    if (a >= b)
        return 0.0;
    return strength * (stampLine(q, (b - tc) / r, hard) - stampLine(q, (a - tc) / r, hard));
}

// The 2D app's layer blend modes (W3C Compositing and Blending), on sRGB colors: backdrop b,
// source s (multiplayer-canvas src/client/engine/gl/programs.ts, BLEND_FS).
float lum(float3 c) { return dot(c, float3(0.3, 0.59, 0.11)); }
float3 clipColor(float3 c)
{
    float l = lum(c);
    float n = min(c.r, min(c.g, c.b));
    float x = max(c.r, max(c.g, c.b));
    if (n < 0.0)
        c = l + (c - l) * l / max(l - n, 1e-6);
    if (x > 1.0)
        c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
    return c;
}
float3 setLum(float3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(float3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
float3 setSat(float3 c, float s)
{
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    return mx > mn ? (c - mn) * s / (mx - mn) : float3(0.0);
}
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0); }
float softLight(float b, float s)
{
    if (s <= 0.5)
        return b - (1.0 - 2.0 * s) * b * (1.0 - b);
    float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
    return b + (2.0 * s - 1.0) * (d - b);
}
float3 blendMode(uint mode, float3 b, float3 s)
{
    switch (mode)
    {
    case 1: return b * s;
    case 2: return b + s - b * s;
    case 3: return float3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
    case 4: return min(b, s);
    case 5: return max(b, s);
    case 6: return float3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
    case 7: return float3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
    case 8: return float3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
    case 9: return float3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
    case 10: return abs(b - s);
    case 11: return b + s - 2.0 * b * s;
    case 12: return setLum(setSat(s, sat(b)), lum(b));
    case 13: return setLum(setSat(b, sat(s)), lum(b));
    case 14: return setLum(s, lum(b));
    case 15: return setLum(b, lum(s));
    case 16: return min(b + s, float3(1.0));
    default: return s;
    }
}

// ---- Background ----

// Sky and a floor grid at y = 0 (for scale and orientation in VR). `pix`: the angle of one
// pixel (radians), for antialiased grid lines (a compute shader has no screen derivatives).
float3 background(float3 o, float3 dir, float pix, out float tFloor)
{
    float3 sky = lerp(float3(0.20, 0.21, 0.24), float3(0.05, 0.06, 0.08), saturate(dir.y * 1.5 + 0.2));
    tFloor = 1e9;
    if (dir.y < -1e-4)
    {
        float t = -o.y / dir.y;
        if (t > 0.0)
        {
            tFloor = t;
            float2 q = (o + dir * t).xz;
            // One pixel on the floor, in meters (the floor seen at a slant: longer).
            float w = t * pix / max(-dir.y, 0.05);
            // 1 m lines, 10 cm lines fainter.
            float2 g1 = abs(frac(q - 0.5) - 0.5) / max(w, 1e-5);
            float2 g10 = abs(frac(q * 10.0 - 0.5) - 0.5) / max(w * 10.0, 1e-5);
            float line1 = 1.0 - saturate(min(g1.x, g1.y));
            float line10 = 1.0 - saturate(min(g10.x, g10.y));
            float fade = exp(-t * 0.08);
            float3 floorCol = float3(0.11, 0.115, 0.13) + (line1 * 0.25 + line10 * 0.06) * fade;
            return lerp(sky, floorCol, saturate(-dir.y * 8.0));
        }
    }
    return sky;
}

[shader("compute")]
[numthreads(TILE, TILE, 1)]
void main(uint3 id: SV_DispatchThreadID, uint3 group: SV_GroupID, uint gi: SV_GroupIndex)
{
    Eye eye = params.eyes[id.z];
    float3 o = eye.pos.xyz;

    // 1. The tile's chunks. Every thread helps, also those outside the image.
    {
        float2 lo = float2(group.xy * TILE);
        float2 hi = min(lo + TILE, float2(params.width, params.height));
        float3 axis = rayDir(eye, (lo + hi) * 0.5);
        float cosAngle = min(min(dot(axis, rayDir(eye, lo)), dot(axis, rayDir(eye, hi))),
                             min(dot(axis, rayDir(eye, float2(lo.x, hi.y))), dot(axis, rayDir(eye, float2(hi.x, lo.y)))));
        float sinAngle = sqrt(saturate(1.0 - cosAngle * cosAngle));
        // The 4x4-pixel parts' cones.
        if (gi < 16)
        {
            float2 slo = lo + float2(gi % 4, gi / 4) * 4.0;
            float2 shi = min(slo + 4.0, float2(params.width, params.height));
            float3 sax = rayDir(eye, (slo + shi) * 0.5);
            float c = min(min(dot(sax, rayDir(eye, slo)), dot(sax, rayDir(eye, shi))),
                          min(dot(sax, rayDir(eye, float2(slo.x, shi.y))), dot(sax, rayDir(eye, float2(shi.x, slo.y)))));
            subAxis[gi] = float4(sax, c);
        }
        if (gi == 0)
        {
            tileCount = 0;
            lineCount = 0;
        }
        GroupMemoryBarrierWithGroupSync();
        // The overlay lines in the tile's cone. Their width is in pixels: a line's sphere grows
        // by that many pixels (at its far side) so the cone test keeps it.
        float tilePix = length(rayDir(eye, lo + float2(1.0, 0.0)) - rayDir(eye, lo));
        for (uint li = gi; li < params.lineCount; li += TILE * TILE)
        {
            OverlayLine l = overlayLines[li];
            float3 mid = (l.a.xyz + l.b.xyz) * 0.5;
            float reach = length(l.b.xyz - l.a.xyz) * 0.5;
            float wide = max(l.a.w, l.b.w) * 0.5 + 1.0;
            float4 sphere = float4(mid, reach + (length(mid - o) + reach) * tilePix * wide);
            if (!sphereInCone(o, axis, cosAngle, sinAngle, sphere))
                continue;
            uint k;
            InterlockedAdd(lineCount, 1, k);
            if (k < MAX_LINES)
                lineList[k] = li;
        }
        // Clusters first: each thread takes clusters, and the chunks of those in the cone.
        for (uint cl = gi; cl < params.clusterCount; cl += TILE * TILE)
        {
            Cluster cluster = clusters[cl];
            if (!sphereInCone(o, axis, cosAngle, sinAngle, cluster.sphere))
                continue;
            for (uint c = cluster.first; c < cluster.first + cluster.count; c++)
            {
                float4 b = chunks[c].sphere;
                if (!sphereInCone(o, axis, cosAngle, sinAngle, b))
                    continue;
                uint mask = 0;
                for (uint p = 0; p < 16; p++)
                {
                    float4 sa = subAxis[p];
                    if (sphereInCone(o, sa.xyz, sa.w, sqrt(saturate(1.0 - sa.w * sa.w)), b))
                        mask |= 1u << p;
                }
                if (mask == 0)
                    continue;
                uint k;
                InterlockedAdd(tileCount, 1, k);
                if (k < MAX_TILE)
                {
                    // Ordered layers keep their stroke order (the chunk number); the others go
                    // near to far.
                    uint layer = chunks[c].layer;
                    float near = saturate(max(length(b.xyz - o) - b.w, 0.0) / DEPTH_RANGE);
                    uint order = layers[layer].ordered != 0 ? (c & 0xffffff) : uint(near * 16777215.0);
                    tileList[k] = c;
                    tileKey[k] = (min(layer, 255u) << 24) | order;
                    tileMask[k] = mask;
                }
            }
        }
        GroupMemoryBarrierWithGroupSync();
        tileAll = tileCount > MAX_TILE;

        // Sort by the key (bitonic, in place). When the list overflowed, the tile uses every
        // chunk in stored order instead (which is in layer order too).
        if (!tileAll && tileCount > 1)
        {
            uint n = tileCount;
            uint size = 2;
            while (size < n)
                size <<= 1;
            for (uint i = n + gi; i < size; i += TILE * TILE)
                tileKey[i] = 0xffffffff;
            GroupMemoryBarrierWithGroupSync();
            for (uint k = 2; k <= size; k <<= 1)
            {
                for (uint j = k >> 1; j > 0; j >>= 1)
                {
                    for (uint i = gi; i < size; i += TILE * TILE)
                    {
                        uint l = i ^ j;
                        if (l > i && (tileKey[i] > tileKey[l]) == ((i & k) == 0))
                        {
                            uint key = tileKey[i];
                            tileKey[i] = tileKey[l];
                            tileKey[l] = key;
                            uint seg = tileList[i];
                            tileList[i] = tileList[l];
                            tileList[l] = seg;
                            uint m = tileMask[i];
                            tileMask[i] = tileMask[l];
                            tileMask[l] = m;
                        }
                    }
                    GroupMemoryBarrierWithGroupSync();
                }
            }
        }
    }

    if (id.x >= params.width || id.y >= params.height)
        return;
    float3 dir = rayDir(eye, float2(id.xy) + 0.5);
    sub = ((id.y % TILE) / 4) * 4 + (id.x % TILE) / 4;
    // The ray of the next pixel to the right: the angle of one pixel.
    float pix = length(rayDir(eye, float2(id.xy) + float2(1.5, 0.5)) - dir);

    float tFloor;
    float3 color = background(o, dir, pix, tFloor);
    // 2. The layers, bottom to top. Each is drawn on its own: its solid strokes (the nearest
    //    hit), its soft strokes' density in front of that (in depth slices), its erasers
    //    taking paint away; then it is blended onto what is below by its mode and opacity, in
    //    sRGB, as the 2D app composites (multiplayer-canvas BLEND_FS). Seen through a layer
    //    above, a layer below shows by the blend, not by depth.
    float3 below = srgbFromLinear(color); // opaque
    lane = gi;
    uint n = tileN();
    for (uint j = 0; j < n;)
    {
        uint end = runEnd(j);
        Layer ly = layers[tileLayer(j)];
        if (ly.ordered != 0)
        {
            // An ordered layer, as the 2D app draws: each stroke's dabs along the ray (its
            // tubes, whole), covering 1 - exp(-dabs), capped by its opacity, over the strokes
            // before it, or taking from them (an eraser). Unlit, in sRGB. Taken top stroke
            // first (each stroke's paint shows through the strokes after it), so a pixel stops
            // once the strokes over it cover it. Pigment mixing: bottom stroke first, each
            // mixed into the paint under it (the mix depends on what is under it).
            bool pigment = PIGMENT != 0;
            float3 lc = 0.0; // premultiplied sRGB
            float la = 0.0;
            float through = 1.0; // what shows through the strokes taken so far
            float stroke = -1.0;
            float dabs = 0.0;
            float4 strokeColor = 0.0;
            int count = int(end - j);
            for (int step = 0; step <= count; step++)
            {
                // Past the last chunk: one more round, to put the last stroke taken down.
                bool more = step < count;
                uint k = more ? (pigment ? j + uint(step) : end - 1 - uint(step)) : 0;
                Chunk ch;
                if (more)
                {
                    if (!inPart(k))
                        continue;
                    ch = chunks[tileSeg(k)];
                    float2 tc = raySphere(o, dir, ch.sphere);
                    if (tc.x > tc.y || tc.y < 0.0)
                        continue;
                }
                float id = more ? float(ch.stroke) : -2.0;
                if (id != stroke)
                {
                    if (stroke >= 0.0 && dabs > 0.0)
                    {
                        float alpha = abs(strokeColor.a) * (1.0 - exp(-dabs));
                        if (pigment)
                        {
                            if (strokeColor.a > 0.0)
                            {
                                float4 mixed = pigmentOver(float4(lc, la), float4(srgbFromLinear(strokeColor.rgb) * alpha, alpha));
                                lc = mixed.rgb;
                                la = mixed.a;
                            }
                            else
                            {
                                lc *= 1.0 - alpha;
                                la *= 1.0 - alpha;
                            }
                        }
                        else
                        {
                            if (strokeColor.a > 0.0)
                            {
                                lc += through * alpha * srgbFromLinear(strokeColor.rgb);
                                la += through * alpha;
                            }
                            through *= 1.0 - alpha;
                            if (through < 1.0 / 512.0)
                                break;
                        }
                    }
                    stroke = id;
                    dabs = 0.0;
                    if (more)
                        strokeColor = segments[ch.first].color;
                }
                if (more)
                {
                    for (uint s = ch.first; s < ch.first + ch.count; s++)
                        dabs += tubeWhole(segments[s], o, dir);
                }
            }
            float sa = la * ly.opacity;
            if (sa > 0.0)
            {
                float3 cs = saturate(lc / la);
                below = below * (1.0 - sa) + sa * saturate(blendMode(ly.blend, below, cs));
            }
            j = end;
            continue;
        }
        float tBehind = tFloor;
        float3 solidColor = 0.0;
        bool solid = false, anySoft = false, anyErase = false;
        for (uint k = j; k < end && tileNear(k) < tBehind; k++)
        {
            if (!inPart(k))
                continue;
            Chunk ch = chunks[tileSeg(k)];
            float2 tc = raySphere(o, dir, ch.sphere);
            if (tc.x > tc.y || tc.y < 0.0 || tc.x >= tBehind)
                continue;
            if (ch.flags != 0)
            {
                anySoft = anySoft || (ch.flags & 2) == 0;
                anyErase = anyErase || (ch.flags & 2) != 0;
                continue;
            }
            for (uint s = ch.first; s < ch.first + ch.count; s++)
            {
                Segment g = segments[s];
                float2 tt = raySphere(o, dir, segmentBounds(g));
                if (tt.x > tt.y || tt.y < 0.0 || tt.x >= tBehind)
                    continue;
                float4 hit = raySegment(o, dir, g);
                if (hit.x >= 0.0 && hit.x < tBehind)
                {
                    tBehind = hit.x;
                    solidColor = shadeSurface(g.color.rgb, hit.yzw, dir);
                    solid = true;
                }
            }
        }
        // The layer, premultiplied (linear): the solid hit, then the soft density over it.
        float3 lc = solid ? solidColor : float3(0.0);
        float la = solid ? 1.0 : 0.0;
        if (anySoft)
        {
            // The span the soft chunks cover along the ray, and its widest empty gap: the
            // chunks come about near to far, so a gap shows between where the ones so far
            // reach and where the next starts.
            float t0 = tBehind, t1 = 0.0;
            float reach = -1.0, gap0 = 0.0, gap1 = 0.0;
            for (uint k = j; k < end && tileNear(k) < tBehind; k++)
            {
                if (!inPart(k))
                    continue;
                Chunk ch = chunks[tileSeg(k)];
                if (ch.flags != 1)
                    continue;
                float2 tc = raySphere(o, dir, ch.sphere);
                if (tc.x > tc.y || tc.y < 0.0 || tc.x >= tBehind)
                    continue;
                float s = max(tc.x, 0.0), e = min(tc.y, tBehind);
                t0 = min(t0, s);
                t1 = max(t1, e);
                if (reach >= 0.0 && s - reach > gap1 - gap0)
                {
                    gap0 = reach;
                    gap1 = s;
                }
                reach = max(reach, e);
            }
            // A wide gap (a soft stroke near the eye, the others far off): the near part and the
            // far part each get slices, in proportion to their lengths. Else the far strokes
            // would share a few coarse slices, and their order, kept only between slices, would
            // show as bands at the slice edges. The chunks are only about in order: those in
            // the gap first make it narrower.
            sliceSplit = BINS;
            if (gap1 - gap0 > 0.25 * (t1 - t0))
            {
                for (uint k = j; k < end && tileNear(k) < tBehind; k++)
                {
                    if (!inPart(k))
                        continue;
                    Chunk ch = chunks[tileSeg(k)];
                    if (ch.flags != 1)
                        continue;
                    float2 tc = raySphere(o, dir, ch.sphere);
                    float s = max(tc.x, 0.0), e = min(tc.y, tBehind);
                    if (tc.x > tc.y || e <= gap0 || s >= gap1)
                        continue;
                    if (s - gap0 > gap1 - e)
                        gap1 = s;
                    else
                        gap0 = e;
                }
                if (gap1 - gap0 > 0.25 * (t1 - t0))
                {
                    float near = gap0 - t0, far = t1 - gap1;
                    sliceSplit = clamp(uint(round(float(BINS) * near / max(near + far, 1e-6))), 1u, BINS - 1);
                }
            }
            if (sliceSplit == BINS)
            {
                gap0 = t1;
                gap1 = t1;
            }
            sliceT0 = t0;
            sliceT1 = t1;
            sliceGap0 = gap0;
            sliceGap1 = gap1;
            if (t1 > t0)
            {
                for (uint b = 0; b < BINS; b++)
                    bins[b * TILE * TILE + gi] = uint2(0, 0);
                for (uint k = j; k < end && tileNear(k) < tBehind; k++)
                {
                    if (!inPart(k))
                        continue;
                    Chunk ch = chunks[tileSeg(k)];
                    if (ch.flags != 1)
                        continue;
                    float2 tc = raySphere(o, dir, ch.sphere);
                    if (tc.x > tc.y || tc.y < 0.0 || tc.x >= tBehind)
                        continue;
                    for (uint s = ch.first; s < ch.first + ch.count; s++)
                        addStamps(segments[s], o, dir);
                }
                // Back to front, over the solid hit.
                for (uint b = BINS; b-- > 0;)
                {
                    uint2 v = bins[b * TILE * TILE + gi];
                    float tau = f16tof32(v.x);
                    if (tau <= 0.0)
                        continue;
                    float3 c = float3(f16tof32(v.x >> 16), f16tof32(v.y), f16tof32(v.y >> 16));
                    float alpha = 1.0 - exp(-tau);
                    if (PIGMENT != 0 && la > 1e-4)
                    {
                        // As paint: the slice's paint into the paint behind it (in sRGB, as the
                        // 2D app mixes).
                        float4 back = float4(srgbFromLinear(lc / la) * la, la);
                        float4 mixed = pigmentOver(back, float4(srgbFromLinear(c / tau) * alpha, alpha));
                        lc = linearFromSrgb(mixed.rgb / max(mixed.a, 1e-6)) * mixed.a;
                        la = mixed.a;
                    }
                    else
                    {
                        lc = lc * (1.0 - alpha) + alpha * c / tau;
                        la = la * (1.0 - alpha) + alpha;
                    }
                }
            }
        }
        // Erasers: their density along the ray (in front of the solid hit) takes paint away.
        if (anyErase && la > 0.0)
        {
            float erased = 0.0;
            for (uint k = j; k < end && tileNear(k) < tBehind; k++)
            {
                if (!inPart(k))
                    continue;
                Chunk ch = chunks[tileSeg(k)];
                if ((ch.flags & 2) == 0)
                    continue;
                float2 tc = raySphere(o, dir, ch.sphere);
                if (tc.x > tc.y || tc.y < 0.0 || tc.x >= tBehind)
                    continue;
                for (uint s = ch.first; s < ch.first + ch.count; s++)
                {
                    float3 so = o, sd = dir;
                    float scale;
                    Segment g = roundSpace(segments[s], so, sd, scale);
                    float tEnd = tBehind * scale;
                    float e = stampTau(g.a.xyz, g.a.w, g.style.z, g.style.x, so, sd, tEnd);
                    if (g.style.w > 0.0)
                        e += stampTau(g.b.xyz, g.b.w, g.style.w, g.style.x, so, sd, tEnd);
                    erased += e / scale;
                }
            }
            float keep = exp(-erased);
            lc *= keep;
            la *= keep;
        }
        // Onto what is below.
        float sa = la * ly.opacity;
        if (sa > 0.0)
        {
            float3 cs = srgbFromLinear(lc / max(la, 1e-6));
            below = below * (1.0 - sa) + sa * saturate(blendMode(ly.blend, below, cs));
        }
        j = end;
    }
    color = linearFromSrgb(below);

    // 4. The brush tip, where the next stroke starts: a preview of its color, opacity and
    //    hardness (drawn over everything), with a thin outline so it shows at any opacity.
    if (params.brushTip.w > 0.0)
    {
        // A flat tip: in its round space (stretched along the pen's up direction).
        float3 up = params.brushUp.xyz;
        float k = 1.0 / max(params.brushUp.w, 0.02) - 1.0;
        float3 oc = params.brushTip.xyz - o;
        float3 ocR = oc + up * (k * dot(up, oc));
        float3 dirR = normalize(dir + up * (k * dot(up, dir)));
        float along = dot(oc, dir);
        if (along > 0.0)
        {
            float r = params.brushTip.w;
            float q = length(ocR - dirR * dot(ocR, dirR)) / r; // the ray's distance from the center, in radii
            float px = pix * along / r;             // one pixel, in radii
            float hard = params.brushStyle.y;
            float e = saturate((1.0 - q) / max(1.0 - hard, px));
            float fill = params.brushStyle.x * smoothstep(0.0, 1.0, e);
            float ball = 0.7 + 0.3 * sqrt(saturate(1.0 - q * q));
            color = lerp(color, params.brushColor.rgb * ball, fill);
            float ring = saturate(1.0 - abs(q - 1.0) / (1.5 * px));
            color = lerp(color, float3(1.0, 1.0, 1.0), ring * 0.5);
        }
    }

    // 5. Overlay lines: each a halo, then the line, widths in pixels.
    for (uint li = 0; li < min(lineCount, MAX_LINES); li++)
    {
        OverlayLine l = overlayLines[lineList[li]];
        float t, s;
        float dist = length(rayToSegment(o, dir, l.a.xyz, l.b.xyz, t, s)) / max(pix * t, 1e-7); // pixels
        color = lerp(color, l.halo.rgb, l.halo.a * saturate(l.b.w * 0.5 - dist + 0.5));
        color = lerp(color, l.color.rgb, l.color.a * saturate(l.a.w * 0.5 - dist + 0.5));
    }

    // 6. The pointer's laser: a thin line, at least a pixel wide, in the 2D app's accent.
    if (params.laserA.w > 0.0)
    {
        float t, s;
        float dist = length(rayToSegment(o, dir, params.laserA.xyz, params.laserB.xyz, t, s));
        float px = max(pix * t, 1e-5);
        float cover = saturate((max(params.laserA.w, px) - dist) / px + 0.5);
        color = lerp(color, float3(0.03, 0.39, 1.0), 0.85 * cover);
    }

    outImage[id] = float4(color, 1.0);
}
