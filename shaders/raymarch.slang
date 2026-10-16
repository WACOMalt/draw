// Raymarches the painting: the exact round cones of every stroke, no voxels.
//
// Two kinds of stroke:
//   - Solid (opaque, hard edge): a surface. Sphere-traced to the hit, lit with its normal.
//   - Soft (opacity or hardness below 1): a volume of density. Marched in small steps, front
//     to back, over whatever solid surface or background is behind it.
//
// One thread per pixel, one image layer per eye (dispatch z = eye). Two culling steps keep the
// work per pixel small:
//   1. Tile: a 16x16 workgroup first collects, together, the segments whose bounding spheres
//      touch the cone of view of its tile (in shared memory, at most MAX_TILE), sorted by
//      segment number when the tile has soft segments.
//   2. Ray: each pixel then collects the tile segments its own ray crosses (solid and soft
//      apart), and traces only those.
// Writes linear color (RGBA16F); the present step encodes sRGB.
import sdf;

static const uint TILE = 16;
static const uint MAX_TILE = 1024;
static const uint MAX_SOLID = 48;
static const uint MAX_SOFT = 32;
static const uint MAX_STEPS = 192;
static const uint MAX_VSTEPS = 384;

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
    uint pad0;
    float4 brushTip;   // xyz, w = radius (0: no tip shown)
    float4 brushColor; // rgb: the color the next stroke gets
};

[[vk::binding(0, 0)]] [[vk::image_format("rgba16f")]] RWTexture2DArray<float4> outImage;
[[vk::binding(1, 0)]] StructuredBuffer<Segment> segments;
[[vk::binding(2, 0)]] ConstantBuffer<Params> params;

// Segments that touch this tile's cone of view (shared by the workgroup).
groupshared uint tileList[MAX_TILE];
groupshared uint tileCount;
groupshared uint tileSoft; // 1 when any of them is soft
static bool tileAll;       // more than fit: the tile uses every segment

uint tileN() { return tileAll ? params.segCount : min(tileCount, MAX_TILE); }
uint tileSeg(uint i) { return tileAll ? i : tileList[i]; }

// Candidates of this ray. When there are more than fit, the ray uses every tile segment of
// that kind instead (`solidAll`, `softAll`). Soft candidates stay in segment order, so the
// segments of one stroke are next to each other.
static uint solid[MAX_SOLID];
static uint solidCount;
static bool solidAll;
static uint soft[MAX_SOFT];
static uint softCount;
static bool softAll;

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

// ---- Solid strokes: surfaces ----

// The distance to the nearest solid candidate, and which one it is.
float scene(float3 p, out uint nearest)
{
    float d = 1e9;
    nearest = 0;
    uint n = solidAll ? tileN() : solidCount;
    for (uint i = 0; i < n; i++)
    {
        uint s = solidAll ? tileSeg(i) : solid[i];
        Segment g = segments[s];
        if (solidAll && !isSolid(g))
            continue;
        float ds = sdSegment(p, g);
        if (ds < d)
        {
            d = ds;
            nearest = s;
        }
    }
    return d;
}

float sceneD(float3 p)
{
    uint unused;
    return scene(p, unused);
}

// Normal from four samples (tetrahedron), Inigo Quilez.
float3 normalAt(float3 p, float eps)
{
    const float2 k = float2(1.0, -1.0);
    return normalize(k.xyy * sceneD(p + k.xyy * eps) + k.yyx * sceneD(p + k.yyx * eps) +
                     k.yxy * sceneD(p + k.yxy * eps) + k.xxx * sceneD(p + k.xxx * eps));
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

// ---- Soft strokes: volumes ----

// Density of the soft candidates at p: `sigma` (absorption per meter) and its mean lit color.
// Inside one stroke only the segment with the nearest axis counts (its segments overlap at the
// joints, and in the full-density core they tie); strokes add up. `outside`: about the distance to the nearest soft volume (0 inside one), for skipping
// empty space. `rMin`: the smallest radius around p, for the step size.
void field(float3 p, out float sigma, out float3 color, out float outside, out float rMin)
{
    sigma = 0.0;
    float3 sum = 0.0;
    outside = 1e9;
    rMin = 1e9;
    float best = 0.0;     // density of this stroke's nearest segment
    float bestU = 1.0;    // its distance from the axis, as a part of the radius
    float3 bestColor = 0.0;
    float stroke = -1.0;
    uint n = softAll ? tileN() : softCount;
    for (uint i = 0; i < n; i++)
    {
        Segment g = segments[softAll ? tileSeg(i) : soft[i]];
        if (softAll && isSolid(g))
            continue;
        if (g.style.y != stroke)
        {
            sigma += best;
            sum += best * bestColor;
            best = 0.0;
            bestU = 1.0;
            stroke = g.style.y;
        }
        // The nearest point of the axis, and the radius there.
        float3 ba = g.b.xyz - g.a.xyz;
        float h = saturate(dot(p - g.a.xyz, ba) / max(dot(ba, ba), 1e-12));
        float3 c = g.a.xyz + ba * h;
        float r = lerp(g.a.w, g.b.w, h);
        float3 pc = p - c;
        float dist = length(pc);
        outside = min(outside, dist - r);
        float u = dist / r;
        if (u >= bestU)
            continue;
        bestU = u;
        rMin = min(rMin, r);
        // Full density inside `hardness` of the radius, then a falloff to 0 at the edge
        // (cubic: most of the density near the core, so the cover fades out gradually).
        float hard = g.style.x;
        float e = saturate((1.0 - u) / max(1.0 - hard, 1e-3));
        float f = e * e * e;
        // Scaled so a ray through the middle is covered by `opacity` (at most 98%: a soft
        // edge needs a core that is not quite saturated), at any hardness. Across the stroke
        // the profile integrates to 2r * (hard + (1 - hard) / 4).
        float depth = -log(1.0 - min(g.color.a, 0.98));
        float k = depth / (2.0 * r * (hard + (1.0 - hard) * 0.25));
        best = f * k;
        float3 nrm = dist > 1e-6 ? pc / dist : float3(0.0, 1.0, 0.0);
        float diff = saturate(dot(nrm, LIGHT) * 0.5 + 0.5);
        float hemi = lerp(0.5, 1.0, nrm.y * 0.5 + 0.5);
        // Softer strokes get flatter light: a haze has no clear surface to shade.
        float lit = 0.35 * hemi + 0.75 * diff;
        bestColor = g.color.rgb * lerp(0.85, lit, 0.4 + 0.6 * hard);
    }
    sigma += best;
    sum += best * bestColor;
    color = sigma > 0.0 ? sum / sigma : 0.0;
    outside = max(outside, 0.0);
}

// Interleaved gradient noise (Jimenez): a per-pixel offset for the volume steps, so the steps
// show as fine noise, not as bands.
float pixelNoise(float2 px)
{
    return frac(52.9829189 * frac(dot(px, float2(0.06711056, 0.00583715))));
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

    // 1. The tile's segments. Every thread helps, also those outside the image.
    {
        float2 lo = float2(group.xy * TILE);
        float2 hi = min(lo + TILE, float2(params.width, params.height));
        float3 axis = rayDir(eye, (lo + hi) * 0.5);
        float cosAngle = min(min(dot(axis, rayDir(eye, lo)), dot(axis, rayDir(eye, hi))),
                             min(dot(axis, rayDir(eye, float2(lo.x, hi.y))), dot(axis, rayDir(eye, float2(hi.x, lo.y)))));
        float angle = acos(clamp(cosAngle, -1.0, 1.0));
        if (gi == 0)
        {
            tileCount = 0;
            tileSoft = 0;
        }
        GroupMemoryBarrierWithGroupSync();
        for (uint s = gi; s < params.segCount; s += TILE * TILE)
        {
            Segment g = segments[s];
            if (sphereInCone(o, axis, angle, segmentBounds(g)))
            {
                uint k;
                InterlockedAdd(tileCount, 1, k);
                if (k < MAX_TILE)
                    tileList[k] = s;
                if (!isSolid(g))
                    tileSoft = 1;
            }
        }
        GroupMemoryBarrierWithGroupSync();
        tileAll = tileCount > MAX_TILE;

        // Soft segments of one stroke must come together: sort the list (bitonic, in place).
        // When it overflowed, the tile uses every segment, which is in order already.
        if (tileSoft != 0 && !tileAll && tileCount > 1)
        {
            uint n = tileCount;
            uint size = 2;
            while (size < n)
                size <<= 1;
            for (uint i = n + gi; i < size; i += TILE * TILE)
                tileList[i] = 0xffffffff;
            GroupMemoryBarrierWithGroupSync();
            for (uint k = 2; k <= size; k <<= 1)
            {
                for (uint j = k >> 1; j > 0; j >>= 1)
                {
                    for (uint i = gi; i < size; i += TILE * TILE)
                    {
                        uint l = i ^ j;
                        if (l > i)
                        {
                            uint a = tileList[i];
                            uint b = tileList[l];
                            if ((a > b) == ((i & k) == 0))
                            {
                                tileList[i] = b;
                                tileList[l] = a;
                            }
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

    // 2. Candidates: tile segments whose bounding sphere the ray crosses in front of the eye.
    solidCount = 0;
    softCount = 0;
    float2 solidSpan = float2(1e9, 0.0);
    float2 softSpan = float2(1e9, 0.0);
    for (uint j = 0; j < tileN(); j++)
    {
        uint s = tileSeg(j);
        Segment g = segments[s];
        float2 tt = raySphere(o, dir, segmentBounds(g));
        if (tt.x > tt.y || tt.y < 0.0)
            continue;
        float2 span = float2(max(tt.x, 0.0), tt.y);
        if (isSolid(g))
        {
            solidSpan = float2(min(solidSpan.x, span.x), max(solidSpan.y, span.y));
            if (solidCount < MAX_SOLID)
                solid[solidCount] = s;
            solidCount++;
        }
        else
        {
            softSpan = float2(min(softSpan.x, span.x), max(softSpan.y, span.y));
            if (softCount < MAX_SOFT)
                soft[softCount] = s;
            softCount++;
        }
    }
    solidAll = solidCount > MAX_SOLID;
    softAll = softCount > MAX_SOFT;

    float tFloor;
    float3 color = background(o, dir, pix, tFloor);
    float tBehind = tFloor;

    // 3. Solid: sphere trace from the first entry to the last exit.
    if (solidCount > 0)
    {
        float t = solidSpan.x;
        float tMax = min(solidSpan.y, tFloor);
        for (uint i = 0; i < MAX_STEPS && t < tMax; i++)
        {
            float3 p = o + dir * t;
            uint nearest;
            float d = scene(p, nearest);
            float hit = 0.0001 + t * 0.0004; // about a pixel
            if (d < hit)
            {
                float3 n = normalAt(p, max(hit, 0.0002));
                color = shadeSurface(segments[nearest].color.rgb, n, dir);
                tBehind = t;
                break;
            }
            t += d;
        }
    }

    // 4. Soft: march the volume in front of whatever is behind, front to back.
    if (softCount > 0)
    {
        float t = softSpan.x;
        float tMax = min(softSpan.y, tBehind);
        float jitter = pixelNoise(float2(id.xy) + float2(id.z * 37, 0));
        float T = 1.0; // what still shows through
        float3 sum = 0.0;
        bool inside = false;
        for (uint i = 0; i < MAX_VSTEPS && t < tMax && T > 0.004; i++)
        {
            float sigma, outside, rMin;
            float3 c;
            field(o + dir * t, sigma, c, outside, rMin);
            if (sigma <= 0.0)
            {
                // Empty: skip toward the next volume.
                inside = false;
                t += max(outside * 0.9, 0.0003);
                continue;
            }
            float dt = clamp(rMin * 0.07, 0.0002, 0.01);
            if (!inside)
            {
                // Just entered: start a random part of a step in.
                inside = true;
                t += jitter * dt;
                continue;
            }
            float alpha = 1.0 - exp(-sigma * dt);
            sum += T * alpha * c;
            T *= 1.0 - alpha;
            t += dt;
        }
        color = sum + T * color;
    }

    // 5. The brush tip: a translucent ball in the brush color, where the next stroke starts.
    if (params.brushTip.w > 0.0)
    {
        float2 tt = raySphere(o, dir, params.brushTip);
        if (tt.x <= tt.y && tt.y > 0.0)
        {
            float3 p = o + dir * max(tt.x, 0.0);
            float edge = 1.0 - saturate(dot(normalize(p - params.brushTip.xyz), -dir));
            color = lerp(color, params.brushColor.rgb, 0.35 + 0.5 * edge * edge);
        }
    }

    outImage[id] = float4(color, 1.0);
}
