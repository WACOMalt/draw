// Distance functions of vdraw. The same as crates/core/src/sdf.rs (keep both in step).
//
// Portable core: plain functions on float3, no Vulkan-only features (no buffer pointers, no
// subgroups), so Slang can also emit HLSL for a Unity/VRChat port of the renderer.
module sdf;

// Signed distance from p to a round cone: the hull of a sphere at a (radius ra) and a sphere at
// b (radius rb). Exact (Inigo Quilez). When one sphere holds the other, the larger sphere.
public float sdRoundCone(float3 p, float3 a, float ra, float3 b, float rb)
{
    float3 ba = b - a;
    float l2 = dot(ba, ba);
    float rr = ra - rb;
    if (rr * rr >= l2)
        return ra >= rb ? length(p - a) - ra : length(p - b) - rb;
    float a2 = l2 - rr * rr;
    float il2 = 1.0 / l2;
    float3 pa = p - a;
    float y = dot(pa, ba);
    float z = y - l2;
    float3 w = pa * l2 - ba * y;
    float x2 = dot(w, w);
    float y2 = y * y * l2;
    float z2 = z * z * l2;
    float k = sign(rr) * rr * rr * x2;
    if (sign(z) * a2 * z2 > k)
        return sqrt(x2 + z2) * il2 - rb;
    if (sign(y) * a2 * y2 < k)
        return sqrt(x2 + y2) * il2 - ra;
    return (sqrt(x2 * a2 * il2) + y * rr) * il2 - ra;
}

// Smooth minimum (polynomial): blends two distances over k.
public float smin(float a, float b, float k)
{
    if (k <= 0.0)
        return min(a, b);
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}

// A segment as stored: a.xyz, a.w = radius at a; b.xyz, b.w = radius at b; color = linear RGBA.
// Three float4, so a port can read it from a float texture (three texels).
public struct Segment
{
    public float4 a;
    public float4 b;
    public float4 color;
}

public float sdSegment(float3 p, Segment s)
{
    return sdRoundCone(p, s.a.xyz, s.a.w, s.b.xyz, s.b.w);
}

// The sphere that holds a segment: center xyz, radius w.
public float4 segmentBounds(Segment s)
{
    float3 c = (s.a.xyz + s.b.xyz) * 0.5;
    return float4(c, length(s.b.xyz - s.a.xyz) * 0.5 + max(s.a.w, s.b.w));
}

// Ray against a sphere: the entry and exit distances along the ray (dir normalized). x > y
// when the ray misses.
public float2 raySphere(float3 o, float3 dir, float4 sphere)
{
    float3 oc = o - sphere.xyz;
    float b = dot(oc, dir);
    float c = dot(oc, oc) - sphere.w * sphere.w;
    float h = b * b - c;
    if (h < 0.0)
        return float2(1.0, -1.0);
    h = sqrt(h);
    return float2(-b - h, -b + h);
}
