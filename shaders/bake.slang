// Composites the canvas's flat layers from their strokes into an image (sRGB, premultiplied,
// row 0 at the top), as the 2D app draws them. Run when the flat layers change; the raymarcher
// samples the image (with mipmaps) every frame.
//
// The flat layers (vdraw_core::painting::FlatData): segments in plane meters, their chunks, the
// layers, and a GRID x GRID grid of the canvas per layer, each cell a range of `items` (chunk
// numbers in stroke order).
import sdf;
import brush;

struct Chunk
{
    float4 sphere; // center xyz, radius w
    uint first;
    uint count;
    uint soft;
    uint pad;
};

struct FlatLayer
{
    uint blend;
    float opacity;
    uint visible;
    uint cellBase;
};

struct Params
{
    float2 lo;    // the canvas rectangle, plane meters
    float2 hi;
    uint2 size;   // the image
    uint layers;
    uint pad;
    float4 paper; // rgb sRGB; w: 1 with paper
};

static const uint GRID = 64;
[[vk::binding(0, 0)]] [[vk::image_format("rgba8")]] RWTexture2D<float4> outImage;
[[vk::binding(1, 0)]] StructuredBuffer<Segment> flatSegments;
[[vk::binding(2, 0)]] StructuredBuffer<Chunk> flatChunks;
[[vk::binding(3, 0)]] StructuredBuffer<FlatLayer> flatLayers;
[[vk::binding(4, 0)]] StructuredBuffer<uint> cells;
[[vk::binding(5, 0)]] StructuredBuffer<uint> items;
[[vk::binding(6, 0)]] ConstantBuffer<Params> params;

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

// A flat stroke's dabs from one segment at canvas point p: the dab density times the line
// integral of the falloff along the segment, through p's distance from it (all in radii).
float flatTrail(Segment g, float2 p)
{
    float2 a = g.a.xy;
    float2 ba = g.b.xy - a;
    float len = length(ba);
    if (len < 1e-9)
        return 0.0;
    float2 u = ba / len;
    float2 pa = p - a;
    float along = dot(pa, u);
    float s = saturate(along / len);
    float r = lerp(g.a.w, g.b.w, s);
    float q = abs(pa.x * u.y - pa.y * u.x) / r;
    if (q >= 1.0)
        return 0.0;
    float density = lerp(g.style.z, g.style.w, s);
    return density * (stampLine(q, (len - along) / r, g.style.x) - stampLine(q, -along / r, g.style.x));
}

// The canvas at plane point p: the paper (or nothing), then each flat layer: its strokes in
// order (each covering 1 - exp(-dabs), capped by its opacity; an eraser takes away), then the
// layer blended by its mode and opacity, as the 2D app composites (in sRGB, premultiplied;
// multiplayer-canvas BLEND_FS). Returns premultiplied sRGB and alpha.
float4 canvasColor(float2 p)
{
    float3 back = params.paper.w > 0.0 ? params.paper.rgb : float3(0.0); // premultiplied
    float backA = params.paper.w > 0.0 ? 1.0 : 0.0;
    uint2 cell = uint2(clamp((p - params.lo) / (params.hi - params.lo) * float(GRID), 0.0, float(GRID) - 1.0));
    uint c = cell.y * GRID + cell.x;
    for (uint l = 0; l < params.layers; l++)
    {
        FlatLayer fl = flatLayers[l];
        if (fl.visible == 0)
            continue;
        uint i0 = cells[fl.cellBase + c];
        uint i1 = cells[fl.cellBase + c + 1];
        if (i0 == i1)
            continue;
        float3 lc = 0.0; // the layer, premultiplied
        float la = 0.0;
        float stroke = -1.0;
        float dabs = 0.0;
        float4 strokeColor = 0.0;
        for (uint i = i0; i <= i1; i++)
        {
            // Past the last chunk: one more round, to put the last stroke down.
            Chunk ch;
            bool more = i < i1;
            if (more)
            {
                ch = flatChunks[items[i]];
                if (length(p - ch.sphere.xy) > ch.sphere.w)
                    continue;
            }
            float id = more ? flatSegments[ch.first].style.y : -2.0;
            if (id != stroke)
            {
                if (stroke >= 0.0 && dabs > 0.0)
                {
                    float alpha = abs(strokeColor.a) * (1.0 - exp(-dabs));
                    lc *= 1.0 - alpha;
                    la *= 1.0 - alpha;
                    if (strokeColor.a > 0.0)
                    {
                        lc += strokeColor.rgb * alpha;
                        la += alpha;
                    }
                }
                stroke = id;
                dabs = 0.0;
                if (more)
                    strokeColor = flatSegments[ch.first].color;
            }
            if (more)
                for (uint s = ch.first; s < ch.first + ch.count; s++)
                    dabs += flatTrail(flatSegments[s], p);
        }
        float3 sc = lc * fl.opacity;
        float sa = la * fl.opacity;
        if (sa <= 0.0)
            continue;
        float3 cb = backA > 0.0 ? saturate(back / backA) : float3(0.0);
        float3 cs = saturate(lc / max(la, 1e-6));
        float3 mixed = saturate(blendMode(fl.blend, cb, cs));
        back = sc * (1.0 - backA) + back * (1.0 - sa) + sa * backA * mixed;
        backA = sa + backA * (1.0 - sa);
    }
    return float4(back, backA);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void main(uint3 id: SV_DispatchThreadID)
{
    if (id.x >= params.size.x || id.y >= params.size.y)
        return;
    float2 f = (float2(id.xy) + 0.5) / float2(params.size);
    float2 p = float2(lerp(params.lo.x, params.hi.x, f.x), lerp(params.hi.y, params.lo.y, f.y));
    outImage[id.xy] = canvasColor(p);
}
