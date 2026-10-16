// Raymarches the painting: the exact round cones of every stroke, no voxels.
//
// One thread per pixel, one image layer per eye (dispatch z = eye). Each ray first collects the
// segments whose bounding spheres it crosses (at most MAX_CAND), starting at the nearest entry,
// then sphere-traces only those. Writes linear color (RGBA16F); the present step encodes sRGB.
import sdf;

static const uint MAX_CAND = 64;
static const uint MAX_STEPS = 192;

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
    float4 brushTip; // xyz, w = radius (0: no tip shown)
};

[[vk::binding(0, 0)]] [[vk::image_format("rgba16f")]] RWTexture2DArray<float4> outImage;
[[vk::binding(1, 0)]] StructuredBuffer<Segment> segments;
[[vk::binding(2, 0)]] ConstantBuffer<Params> params;

// Candidate segments of this ray (indices).
static uint cand[MAX_CAND];
static uint candCount;
static bool useAll; // more candidates than fit: test every segment

uint candidateCount() { return useAll ? params.segCount : candCount; }
uint candidate(uint i) { return useAll ? i : cand[i]; }

// The distance to the nearest candidate, and which one it is.
float scene(float3 p, out uint nearest)
{
    float d = 1e9;
    nearest = 0;
    uint n = candidateCount();
    for (uint i = 0; i < n; i++)
    {
        uint s = candidate(i);
        float ds = sdSegment(p, segments[s]);
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
[numthreads(8, 8, 1)]
void main(uint3 id: SV_DispatchThreadID)
{
    if (id.x >= params.width || id.y >= params.height)
        return;
    Eye eye = params.eyes[id.z];
    float2 ndc = (float2(id.xy) + 0.5) / float2(params.width, params.height) * 2.0 - 1.0;
    float4 far = mul(eye.invViewProj, float4(ndc, 1.0, 1.0));
    float3 o = eye.pos.xyz;
    float3 dir = normalize(far.xyz / far.w - o);
    // The ray of the next pixel to the right: the angle of one pixel.
    float4 far1 = mul(eye.invViewProj, float4(ndc.x + 2.0 / float(params.width), ndc.y, 1.0, 1.0));
    float pix = length(normalize(far1.xyz / far1.w - o) - dir);

    // 1. Candidates: segments whose bounding sphere the ray crosses in front of the eye.
    candCount = 0;
    useAll = false;
    float tStart = 1e9, tEnd = 0.0;
    for (uint s = 0; s < params.segCount; s++)
    {
        float2 tt = raySphere(o, dir, segmentBounds(segments[s]));
        if (tt.x > tt.y || tt.y < 0.0)
            continue;
        tStart = min(tStart, max(tt.x, 0.0));
        tEnd = max(tEnd, tt.y);
        if (candCount < MAX_CAND)
            cand[candCount] = s;
        candCount++;
    }
    if (candCount > MAX_CAND)
        useAll = true;

    float tFloor;
    float3 color = background(o, dir, pix, tFloor);

    // 2. Sphere trace from the first entry to the last exit.
    if (candCount > 0)
    {
        float t = tStart;
        float tMax = min(tEnd, tFloor);
        for (uint i = 0; i < MAX_STEPS && t < tMax; i++)
        {
            float3 p = o + dir * t;
            uint nearest;
            float d = scene(p, nearest);
            float hit = 0.0001 + t * 0.0004; // about a pixel
            if (d < hit)
            {
                float3 n = normalAt(p, max(hit, 0.0002));
                float3 base = segments[nearest].color.rgb;
                float3 l = normalize(float3(0.4, 0.9, 0.3));
                float diff = saturate(dot(n, l) * 0.5 + 0.5); // wrapped
                float3 h = normalize(l - dir);
                float spec = pow(saturate(dot(n, h)), 48.0) * 0.25;
                float rim = pow(1.0 - saturate(dot(n, -dir)), 3.0) * 0.15;
                float hemi = lerp(0.35, 1.0, n.y * 0.5 + 0.5);
                color = base * (0.25 * hemi + 0.85 * diff * diff) + spec + rim;
                break;
            }
            t += d;
        }
    }

    // 3. The brush tip: a translucent ring where the next stroke would start.
    if (params.brushTip.w > 0.0)
    {
        float2 tt = raySphere(o, dir, params.brushTip);
        if (tt.x <= tt.y && tt.y > 0.0)
        {
            float3 p = o + dir * max(tt.x, 0.0);
            float edge = 1.0 - saturate(dot(normalize(p - params.brushTip.xyz), -dir));
            color = lerp(color, float3(1.0, 1.0, 1.0), 0.15 + 0.5 * edge * edge);
        }
    }

    outImage[id] = float4(color, 1.0);
}
