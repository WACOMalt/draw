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

static const uint TILE = 16;
static const uint MAX_TILE = 1024;

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
    float4 laserA;     // the pointer's laser: from xyz (w = radius, 0: none)
    float4 laserB;     // to xyz
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
    uint soft; // 1: the stroke is soft
    uint pad;
};
[[vk::binding(3, 0)]] StructuredBuffer<Chunk> chunks;

// Chunks that touch this tile's cone of view (shared by the workgroup), sorted near to far by
// where their spheres start.
groupshared uint tileList[MAX_TILE];
groupshared float tileKey[MAX_TILE];
groupshared uint tileCount;
static bool tileAll; // more than fit: the tile uses every chunk

uint tileN() { return tileAll ? params.chunkCount : min(tileCount, MAX_TILE); }
uint tileSeg(uint i) { return tileAll ? i : tileList[i]; }
// No chunk from list position i on starts nearer than this (the list is sorted).
float tileNear(uint i) { return tileAll ? 0.0 : tileKey[i]; }

// The world-space direction of the ray through pixel position `px` (pixels, may be fractional).
float3 rayDir(Eye eye, float2 px)
{
    float2 ndc = px / float2(params.width, params.height) * 2.0 - 1.0;
    float4 far = mul(eye.invViewProj, float4(ndc, 1.0, 1.0));
    return normalize(far.xyz / far.w - eye.pos.xyz);
}

// Whether a sphere (xyz, w = radius) touches the cone from `o` along `axis` with half angle
// `angle`: the angle to its center, less its angular radius, is inside the cone.
bool sphereInCone(float3 o, float3 axis, float angle, float4 sphere)
{
    float3 v = sphere.xyz - o;
    float d = length(v);
    if (d <= sphere.w)
        return true;
    float toCenter = acos(clamp(dot(v, axis) / d, -1.0, 1.0));
    return toCenter <= angle + asin(sphere.w / d);
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

static const uint BINS = 12;
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

// The brush falloff of the 2D app: 1 inside `hard` of the radius, then a raised cosine down
// to 0 at the edge. `u`: the distance from the center, in radii. (vdraw_core::segments::falloff)
float brushFalloff(float u, float hard)
{
    if (u >= 1.0)
        return 0.0;
    if (u <= hard)
        return 1.0;
    float x = (u - hard) / max(1.0 - hard, 1e-6);
    return 0.5 + 0.5 * cos(3.14159265 * x);
}

// The falloff integrated along a line at distance q (radii) from a stamp's center, from the
// line's nearest point to y further on (radii; negative: backward). The full-density core is
// exact; the falloff shell, which is smooth, by 4-point Gauss.
float stampLine(float q, float y, float hard)
{
    float sgn = y < 0.0 ? -1.0 : 1.0;
    y = min(abs(y), sqrt(max(1.0 - q * q, 0.0)));
    if (y <= 0.0)
        return 0.0;
    float yc = sqrt(max(hard * hard - q * q, 0.0)); // where the core ends
    float core = min(y, yc);
    float shell = 0.0;
    if (y > yc)
    {
        const float X[2] = { 0.3399810436, 0.8611363116 };
        const float W[2] = { 0.6521451549, 0.3478548451 };
        float mid = 0.5 * (y + yc);
        float half = 0.5 * (y - yc);
        for (uint k = 0; k < 2; k++)
        {
            float s0 = mid - X[k] * half;
            float s1 = mid + X[k] * half;
            shell += W[k] * (brushFalloff(sqrt(q * q + s0 * s0), hard) + brushFalloff(sqrt(q * q + s1 * s1), hard));
        }
        shell *= half;
    }
    return sgn * (core + shell);
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

// One stamp (center c, radius r, strength) into the slices: its optical depth along the ray,
// between t0 and t1 (the slices' span), split where the slice edges cut its chord.
void addStamp(Segment g, float3 c, float r, float strength, float3 o, float3 dir, float t0, float t1)
{
    float tc = dot(c - o, dir);
    float3 off = o + dir * tc - c;
    float q = length(off) / r;
    if (q >= 1.0 || strength <= 0.0)
        return;
    float half = r * sqrt(1.0 - q * q);
    float a = max(tc - half, t0);
    float b = min(tc + half, t1);
    if (a >= b)
        return;
    float3 lit = softLit(g, off / r);
    float perBin = (t1 - t0) / float(BINS);
    uint k0 = min(uint((a - t0) / perBin), BINS - 1);
    uint k1 = min(uint((b - t0) / perBin), BINS - 1);
    float before = stampLine(q, (a - tc) / r, g.style.x);
    for (uint k = k0; k <= k1; k++)
    {
        float edge = min(b, t0 + perBin * float(k + 1));
        float upto = stampLine(q, (edge - tc) / r, g.style.x);
        float tau = strength * (upto - before);
        binAdd(k, tau, tau * lit);
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
        float angle = acos(clamp(cosAngle, -1.0, 1.0));
        if (gi == 0)
            tileCount = 0;
        GroupMemoryBarrierWithGroupSync();
        for (uint c = gi; c < params.chunkCount; c += TILE * TILE)
        {
            float4 b = chunks[c].sphere;
            if (sphereInCone(o, axis, angle, b))
            {
                uint k;
                InterlockedAdd(tileCount, 1, k);
                if (k < MAX_TILE)
                {
                    tileList[k] = c;
                    tileKey[k] = max(length(b.xyz - o) - b.w, 0.0);
                }
            }
        }
        GroupMemoryBarrierWithGroupSync();
        tileAll = tileCount > MAX_TILE;

        // Sort near to far (bitonic, in place). When the list overflowed, the tile uses every
        // chunk in stored order instead.
        if (!tileAll && tileCount > 1)
        {
            uint n = tileCount;
            uint size = 2;
            while (size < n)
                size <<= 1;
            for (uint i = n + gi; i < size; i += TILE * TILE)
                tileKey[i] = 1e30;
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
                            float key = tileKey[i];
                            tileKey[i] = tileKey[l];
                            tileKey[l] = key;
                            uint seg = tileList[i];
                            tileList[i] = tileList[l];
                            tileList[l] = seg;
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
    // The ray of the next pixel to the right: the angle of one pixel.
    float pix = length(rayDir(eye, float2(id.xy) + float2(1.5, 0.5)) - dir);

    float tFloor;
    float3 color = background(o, dir, pix, tFloor);

    // 2. Solid: the nearest exact hit among the tile's solid segments.
    float tBehind = tFloor;
    bool anySoft = false;
    for (uint j = 0; j < tileN() && tileNear(j) < tBehind; j++)
    {
        Chunk ch = chunks[tileSeg(j)];
        float2 tc = raySphere(o, dir, ch.sphere);
        if (tc.x > tc.y || tc.y < 0.0 || tc.x >= tBehind)
            continue;
        if (ch.soft != 0)
        {
            anySoft = true;
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
                color = shadeSurface(g.color.rgb, hit.yzw, dir);
            }
        }
    }

    // 3. Soft: the stamps' density through the volume in front of whatever is behind.
    if (anySoft)
    {
        // The span the soft chunks cover along the ray.
        float t0 = tBehind, t1 = 0.0;
        for (uint j = 0; j < tileN() && tileNear(j) < tBehind; j++)
        {
            Chunk ch = chunks[tileSeg(j)];
            if (ch.soft == 0)
                continue;
            float2 tc = raySphere(o, dir, ch.sphere);
            if (tc.x > tc.y || tc.y < 0.0 || tc.x >= tBehind)
                continue;
            t0 = min(t0, max(tc.x, 0.0));
            t1 = max(t1, min(tc.y, tBehind));
        }
        if (t1 > t0)
        {
            lane = gi;
            for (uint k = 0; k < BINS; k++)
                bins[k * TILE * TILE + gi] = uint2(0, 0);
            for (uint j = 0; j < tileN() && tileNear(j) < tBehind; j++)
            {
                Chunk ch = chunks[tileSeg(j)];
                if (ch.soft == 0)
                    continue;
                float2 tc = raySphere(o, dir, ch.sphere);
                if (tc.x > tc.y || tc.y < 0.0 || tc.x >= tBehind)
                    continue;
                for (uint s = ch.first; s < ch.first + ch.count; s++)
                {
                    Segment g = segments[s];
                    addStamp(g, g.a.xyz, g.a.w, g.style.z, o, dir, t0, t1);
                    if (g.style.w > 0.0)
                        addStamp(g, g.b.xyz, g.b.w, g.style.w, o, dir, t0, t1);
                }
            }
            // Front to back.
            float T = 1.0; // what still shows through
            float3 sum = 0.0;
            for (uint k = 0; k < BINS; k++)
            {
                uint2 v = bins[k * TILE * TILE + gi];
                float tau = f16tof32(v.x);
                if (tau <= 0.0)
                    continue;
                float3 c = float3(f16tof32(v.x >> 16), f16tof32(v.y), f16tof32(v.y >> 16));
                float alpha = 1.0 - exp(-tau);
                sum += T * alpha * c / tau;
                T *= 1.0 - alpha;
            }
            color = sum + T * color;
        }
    }

    // 4. The brush tip, where the next stroke starts: a preview of its color, opacity and
    //    hardness (drawn over everything), with a thin outline so it shows at any opacity.
    if (params.brushTip.w > 0.0)
    {
        float3 oc = params.brushTip.xyz - o;
        float along = dot(oc, dir);
        if (along > 0.0)
        {
            float r = params.brushTip.w;
            float q = length(oc - dir * along) / r; // the ray's distance from the center, in radii
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

    // 5. The pointer's laser: a thin line, at least a pixel wide, in the 2D app's accent.
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
