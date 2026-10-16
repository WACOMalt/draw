// Raytraces the painting: the exact round cones of every stroke, no voxels.
//
// Two kinds of stroke:
//   - Solid (opaque, hard edge): a surface. Each ray takes the nearest exact ray/round-cone
//     intersection, lit with its normal. No marching.
//   - Soft (opacity or hardness below 1): a layer per stroke, as in the 2D app. Its cover
//     comes from how near the ray passes to the stroke's center line. The layers are blended
//     front to back over whatever solid surface or background is behind them.
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

// ---- Soft strokes: layers ----

// A soft stroke works like a stroke of the 2D app, seen from where the ray is: its cover along
// a ray comes from how near the ray passes to the stroke's center line (as a part of the
// radius there), through the brush falloff, times its opacity. Each stroke is one layer: where
// it folds or crosses itself it does not build up, the nearest pass counts. The layers are
// blended front to back by the depth of that nearest pass.

static const uint MAX_LAYERS = 8;

// The brush falloff of the 2D app: cover at distance u (a part of the radius) from the center
// line. Full inside `hard`, then a raised cosine down to 0 at the edge.
float brushFalloff(float u, float hard)
{
    if (u >= 1.0)
        return 0.0;
    if (u <= hard)
        return 1.0;
    float x = (u - hard) / max(1.0 - hard, 1e-6);
    return 0.5 + 0.5 * cos(3.14159265 * x);
}

// The light of a soft stroke. `n`: the offset of the ray's nearest pass from the center line,
// in radii (0 through the middle, so the light changes smoothly across the stroke; the light
// is linear in n).
float3 softLit(Segment g, float3 n)
{
    float diff = saturate(dot(n, LIGHT) * 0.5 + 0.5);
    float hemi = lerp(0.5, 1.0, n.y * 0.5 + 0.5);
    // Softer strokes get flatter light: a haze has no clear surface to shade.
    float lit = 0.35 * hemi + 0.75 * diff;
    return g.color.rgb * lerp(0.85, lit, 0.4 + 0.6 * g.style.x);
}

// One soft segment along the ray: its cover (0 when the ray passes outside it), the depth of
// the nearest pass, and the lit color there. `tBehind`: a solid surface or the floor; a pass
// beyond it fades out within half a radius.
float softCover(Segment g, float3 o, float3 dir, float tBehind, out float t, out float3 color, out float r)
{
    // The nearest points of the ray (t >= 0) and the segment (s in 0..1).
    float3 ba = g.b.xyz - g.a.xyz;
    float3 w = o - g.a.xyz;
    float bb = dot(ba, ba);
    float bd = dot(ba, dir);
    float ob = dot(w, ba);
    float od = dot(w, dir);
    float den = bb - bd * bd;
    float s = den > 1e-12 ? saturate((ob - od * bd) / den) : 0.0;
    t = max(s * bd - od, 0.0);
    s = bb > 1e-12 ? saturate((ob + t * bd) / bb) : 0.0;
    t = max(s * bd - od, 0.0);
    float3 off = w + dir * t - ba * s;
    r = lerp(g.a.w, g.b.w, s);
    float u = length(off) / r;
    color = 0.0;
    float cover = g.color.a * brushFalloff(u, g.style.x) * saturate((tBehind - t) / (0.5 * r));
    if (cover > 0.0)
        color = softLit(g, off / r);
    return cover;
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

    // 3. Soft: one layer per stroke, then the layers front to back.
    //    A layer's cover is the stroke's best cover along the ray (it does not build up where
    //    the stroke folds); its color, depth and radius are means over the stroke's segments,
    //    weighted by cover^4, so they change smoothly where segments tie.
    if (anySoft)
    {
        float layerId[MAX_LAYERS];
        float layerCover[MAX_LAYERS];
        float layerW[MAX_LAYERS];      // sum of weights
        float layerT[MAX_LAYERS];      // weighted sums, then means
        float layerR[MAX_LAYERS];
        float3 layerColor[MAX_LAYERS];
        uint layers = 0;
        // Strokes past MAX_LAYERS: one rest layer behind the others, in no order.
        float restT = 1.0;
        float3 restSum = 0.0;
        float restCover = 0.0;
        for (uint j = 0; j < tileN() && tileNear(j) < tBehind; j++)
        {
            Chunk ch = chunks[tileSeg(j)];
            if (ch.soft == 0)
                continue;
            float2 tc = raySphere(o, dir, ch.sphere);
            if (tc.x > tc.y || tc.y < 0.0 || tc.x >= tBehind)
                continue;
            // The chunk's part (a chunk is all one stroke).
            float cover = 0.0, w = 0.0, wt = 0.0, wr = 0.0;
            float3 wc = 0.0;
            for (uint s = ch.first; s < ch.first + ch.count; s++)
            {
                float ts, rs;
                float3 cs;
                float cv = softCover(segments[s], o, dir, tBehind, ts, cs, rs);
                if (cv <= 0.0)
                    continue;
                float ws = cv * cv * cv * cv;
                cover = max(cover, cv);
                w += ws;
                wt += ws * ts;
                wr += ws * rs;
                wc += ws * cs;
            }
            if (cover <= 0.0)
                continue;
            float id = segments[ch.first].style.y;
            uint k = 0;
            while (k < layers && layerId[k] != id)
                k++;
            if (k == layers)
            {
                if (layers < MAX_LAYERS)
                    layers++;
                else
                {
                    // Full: the farthest of the layers and this one goes to the rest.
                    k = 0;
                    for (uint i = 1; i < MAX_LAYERS; i++)
                        if (layerT[i] / layerW[i] > layerT[k] / layerW[k])
                            k = i;
                    if (wt / w >= layerT[k] / layerW[k])
                    {
                        restSum += cover * wc / w;
                        restCover += cover;
                        restT *= 1.0 - cover;
                        continue;
                    }
                    restSum += layerCover[k] * layerColor[k] / layerW[k];
                    restCover += layerCover[k];
                    restT *= 1.0 - layerCover[k];
                }
                layerId[k] = id;
                layerCover[k] = 0.0;
                layerW[k] = 0.0;
                layerT[k] = 0.0;
                layerR[k] = 0.0;
                layerColor[k] = 0.0;
            }
            layerCover[k] = max(layerCover[k], cover);
            layerW[k] += w;
            layerT[k] += wt;
            layerR[k] += wr;
            layerColor[k] += wc;
        }
        for (uint i = 0; i < layers; i++)
        {
            layerT[i] /= layerW[i];
            layerR[i] /= layerW[i];
            layerColor[i] /= layerW[i];
        }
        // Front to back. A layer is in front of another by how much nearer its pass is,
        // eased over their radii: strokes that cross mix smoothly instead of cutting along the
        // crossing (where their order flips).
        float T = 1.0; // what still shows through all layers
        float3 sum = 0.0;
        for (uint i = 0; i < layers; i++)
        {
            float shown = 1.0; // what of layer i the others let through
            for (uint m = 0; m < layers; m++)
            {
                if (m == i)
                    continue;
                float front = smoothstep(-1.0, 1.0, (layerT[i] - layerT[m]) / (0.5 * (layerR[i] + layerR[m])));
                shown *= 1.0 - layerCover[m] * front;
            }
            sum += shown * layerCover[i] * layerColor[i];
            T *= 1.0 - layerCover[i];
        }
        // The rest, behind all layers: its cover, in its mean color.
        if (restCover > 0.0)
            sum += T * (1.0 - restT) * restSum / restCover;
        color = sum + T * restT * color;
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

    outImage[id] = float4(color, 1.0);
}
