// Raytraces the painting: the exact round cones of every stroke, no voxels.
//
// Two kinds of stroke:
//   - Solid (opaque, hard edge): a surface. Each ray takes the nearest exact ray/round-cone
//     intersection, lit with its normal. No marching.
//   - Soft (opacity or hardness below 1): a volume of density. The ray integrates each
//     segment's density, and blends the segments front to back over whatever solid surface or
//     background is behind them. No marching either.
//
// One thread per pixel, one image layer per eye (dispatch z = eye). The work per pixel stays
// small in two ways:
//   1. Tile: a 16x16 workgroup first collects, together, the segments whose bounding spheres
//      touch the cone of view of its tile (in shared memory, at most MAX_TILE).
//   2. Order: the tile sorts its list near to far once, so each pixel blends the soft
//      segments front to back in one pass, with no sorting of its own.
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
    uint pad0;
    float4 brushTip;   // xyz, w = radius (0: no tip shown)
    float4 brushColor; // rgb: the color the next stroke gets
    float4 brushStyle; // x = opacity, y = hardness of the next stroke
};

[[vk::binding(0, 0)]] [[vk::image_format("rgba16f")]] RWTexture2DArray<float4> outImage;
[[vk::binding(1, 0)]] StructuredBuffer<Segment> segments;
[[vk::binding(2, 0)]] ConstantBuffer<Params> params;

// Segments that touch this tile's cone of view (shared by the workgroup), sorted near to far
// by where their bounding spheres start.
groupshared uint tileList[MAX_TILE];
groupshared float tileKey[MAX_TILE];
groupshared uint tileCount;
static bool tileAll; // more than fit: the tile uses every segment

uint tileN() { return tileAll ? params.segCount : min(tileCount, MAX_TILE); }
uint tileSeg(uint i) { return tileAll ? i : tileList[i]; }
// No segment from list position i on starts nearer than this (the list is sorted).
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

// ---- Soft strokes: volumes ----

// Each soft segment owns the part of its stroke between the planes that halve the angles at
// its two joints. An open end (the first or last segment) has a flat cut there instead, and a
// half sphere beyond it: the round end. So the segments of a stroke share it out with no
// overlap and no gap, and different strokes add up.
//
// The density falls off with the distance from the axis, as a part of the radius (rho): full
// inside `hardness`, then ((1 - rho) / (1 - hardness))^3 to 0 at the edge. Along a straight
// line, this profile has a closed-form integral, so each segment's optical depth along the ray
// is exact, with no steps. The segments are then blended front to back, in order of entry.

// Antiderivative in s of (1 - rho)^3, rho = sqrt(q^2 + s^2).
float shellAnti(float q, float s)
{
    float r = sqrt(q * q + s * s);
    float L = q > 1e-6 ? q * q * log((s + r) / q) : 0.0; // q^2 asinh(s / q)
    float i1 = 0.5 * (s * r + L);                         // integral of rho
    float i2 = q * q * s + s * s * s / 3.0;               // of rho^2
    float i3 = 0.25 * s * r * r * r + 0.375 * q * q * (s * r + L); // of rho^3
    return s - 3.0 * i1 + 3.0 * i2 - i3;
}

// The profile integrated along a line at distance q (in radii) from the axis, from the point
// nearest the axis to y further on (in radii; negative y: backward).
float profileIntegral(float q, float y, float hard)
{
    float sgn = y < 0.0 ? -1.0 : 1.0;
    y = min(abs(y), sqrt(max(1.0 - q * q, 0.0)));
    if (y <= 0.0)
        return 0.0;
    if (hard > 0.98)
    {
        // A hard edge: a step at the radius that holds the same amount.
        float rc = hard + (1.0 - hard) * 0.25;
        return sgn * min(y, sqrt(max(rc * rc - q * q, 0.0)));
    }
    float yc = sqrt(max(hard * hard - q * q, 0.0)); // where the full-density core ends
    float core = min(y, yc);
    float shell = 0.0;
    if (y > yc)
    {
        float w = 1.0 - hard;
        shell = (shellAnti(q, y) - shellAnti(q, yc)) / (w * w * w);
    }
    return sgn * (core + shell);
}

// The profile's value at rho (for a ray along the axis).
float profileAt(float rho, float hard)
{
    if (rho >= 1.0)
        return 0.0;
    float e = saturate((1.0 - rho) / max(1.0 - hard, 1e-3));
    return e * e * e;
}

// Clips the ray interval `span` to the side of a plane (through q, normal n) that n points to.
float2 clipPlane(float2 span, float3 o, float3 dir, float3 q, float3 n)
{
    float dn = dot(dir, n);
    float dist = dot(q - o, n); // t * dn >= dist
    if (abs(dn) < 1e-8)
        return dist <= 0.0 ? span : float2(1.0, 0.0);
    float t = dist / dn;
    return dn > 0.0 ? float2(max(span.x, t), span.y) : float2(span.x, min(span.y, t));
}

// The light of a soft segment along a ray. `n`: the mean normal along the ray's path through
// it, which is about the offset of the path from the axis, in radii (0 through the middle, so
// the light changes smoothly across the stroke; the light is linear in n).
float3 softLit(Segment g, float3 n)
{
    float diff = saturate(dot(n, LIGHT) * 0.5 + 0.5);
    float hemi = lerp(0.5, 1.0, n.y * 0.5 + 0.5);
    // Softer strokes get flatter light: a haze has no clear surface to shade.
    float lit = 0.35 * hemi + 0.75 * diff;
    return g.color.rgb * lerp(0.85, lit, 0.4 + 0.6 * g.style.x);
}

// A round end: the half sphere at c (radius r) on the side of the plane through c that n
// points to. Adds its optical depth within `span` (in units of the profile integral) and its
// lit color, weighted.
void softCap(Segment g, float3 c, float r, float3 n, float3 o, float3 dir, float2 span, inout float tau, inout float3 col)
{
    span = clipPlane(span, o, dir, c, n);
    float tc = dot(c - o, dir);
    float3 off = o + dir * tc - c;
    float q = length(off) / r;
    if (q >= 1.0 || span.x >= span.y)
        return;
    float d = profileIntegral(q, (span.y - tc) / r, g.style.x) - profileIntegral(q, (span.x - tc) / r, g.style.x);
    tau += d;
    col += d * softLit(g, off / r);
}

// The segment's optical depth along the ray within `span`, and its mean color.
float softOptical(uint s, float3 o, float3 dir, float2 span, out float3 color)
{
    Segment g = segments[s];
    color = 0.0;
    float3 ba = g.b.xyz - g.a.xyz;
    float len = length(ba);
    float hard = g.style.x;
    // Scaled so a ray through the middle is covered by `opacity` (at most 98%: a soft edge
    // needs a core that is not quite saturated), at any hardness. Across the stroke the profile
    // integrates to 2 * (hard + (1 - hard) / 4) radii.
    float k = -log(1.0 - min(g.color.a, 0.98)) / (2.0 * (hard + (1.0 - hard) * 0.25));
    float tau = 0.0; // in profile-integral units until the end
    float3 col = 0.0;
    if (len < 1e-7)
    {
        // A single point: a whole sphere.
        softCap(g, g.a.xyz, max(g.a.w, g.b.w), -dir, o, dir, span, tau, col);
        softCap(g, g.a.xyz, max(g.a.w, g.b.w), dir, o, dir, span, tau, col);
    }
    else
    {
        float3 u = ba / len;
        // The cut at a: the plane halving the joint with the previous segment, or flat.
        float2 body = span;
        bool openA = !(s > 0 && segments[s - 1].style.y == g.style.y);
        float3 na = u;
        if (!openA)
        {
            float3 pd = segments[s - 1].b.xyz - segments[s - 1].a.xyz;
            float3 n = (dot(pd, pd) > 1e-14 ? normalize(pd) : u) + u;
            if (dot(n, n) > 1e-8)
                na = normalize(n);
        }
        body = clipPlane(body, o, dir, g.a.xyz, na);
        bool openB = !(s + 1 < params.segCount && segments[s + 1].style.y == g.style.y);
        float3 nb = u;
        if (!openB)
        {
            float3 qd = segments[s + 1].b.xyz - segments[s + 1].a.xyz;
            float3 n = (dot(qd, qd) > 1e-14 ? normalize(qd) : u) + u;
            if (dot(n, n) > 1e-8)
                nb = normalize(n);
        }
        body = clipPlane(body, o, dir, g.b.xyz, -nb);
        // The body: the ray against the axis line. Its distance from the axis is
        // sqrt(d0^2 + (sp * (t - tc))^2).
        float3 oa = o - g.a.xyz;
        float3 dp = dir - u * dot(dir, u);
        float3 op = oa - u * dot(oa, u);
        float sp2 = dot(dp, dp);
        float tc = sp2 > 1e-12 ? -dot(op, dp) / sp2 : 0.0;
        float3 off = op + dp * tc; // from the axis to the ray's nearest point
        float hc = saturate(dot(o + dir * tc - g.a.xyz, u) / len);
        float r = lerp(g.a.w, g.b.w, hc);
        float q = length(off) / r;
        if (body.x < body.y && q < 1.0)
        {
            float sp = sqrt(sp2);
            float d;
            if (sp < 1e-3)
                d = profileAt(q, hard) * (body.y - body.x) / r; // along the axis
            else
                d = (profileIntegral(q, sp * (body.y - tc) / r, hard) - profileIntegral(q, sp * (body.x - tc) / r, hard)) / sp;
            tau += d;
            col += d * softLit(g, off / r);
        }
        if (openA)
            softCap(g, g.a.xyz, g.a.w, -u, o, dir, span, tau, col);
        if (openB)
            softCap(g, g.b.xyz, g.b.w, u, o, dir, span, tau, col);
    }
    color = tau > 0.0 ? col / tau : 0.0;
    return tau * k;
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
            tileCount = 0;
        GroupMemoryBarrierWithGroupSync();
        for (uint s = gi; s < params.segCount; s += TILE * TILE)
        {
            if (sphereInCone(o, axis, angle, segmentBounds(segments[s])))
            {
                uint k;
                InterlockedAdd(tileCount, 1, k);
                if (k < MAX_TILE)
                {
                    float4 b = segmentBounds(segments[s]);
                    tileList[k] = s;
                    tileKey[k] = max(length(b.xyz - o) - b.w, 0.0);
                }
            }
        }
        GroupMemoryBarrierWithGroupSync();
        tileAll = tileCount > MAX_TILE;

        // Sort near to far (bitonic, in place). When the list overflowed, the tile uses every
        // segment in stored order instead.
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
        Segment g = segments[tileSeg(j)];
        float2 tt = raySphere(o, dir, segmentBounds(g));
        if (tt.x > tt.y || tt.y < 0.0 || tt.x >= tBehind)
            continue;
        if (!isSolid(g))
        {
            anySoft = true;
            continue;
        }
        float4 hit = raySegment(o, dir, g);
        if (hit.x >= 0.0 && hit.x < tBehind)
        {
            tBehind = hit.x;
            color = shadeSurface(g.color.rgb, hit.yzw, dir);
        }
    }

    // 3. Soft: the volumes in front of whatever is behind, blended front to back in the
    //    tile's order.
    if (anySoft)
    {
        float T = 1.0; // what still shows through
        float3 sum = 0.0;
        for (uint j = 0; j < tileN() && tileNear(j) < tBehind && T > 0.004; j++)
        {
            uint s = tileSeg(j);
            Segment g = segments[s];
            if (isSolid(g))
                continue;
            float2 tt = raySphere(o, dir, segmentBounds(g));
            if (tt.x > tt.y || tt.y < 0.0 || tt.x >= tBehind)
                continue;
            float3 c;
            float tau = softOptical(s, o, dir, float2(max(tt.x, 0.0), min(tt.y, tBehind)), c);
            float alpha = 1.0 - exp(-tau);
            sum += T * alpha * c;
            T *= 1.0 - alpha;
        }
        color = sum + T * color;
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
